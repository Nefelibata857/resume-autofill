/**
 * GitHub 登录门 —— 换 token 的小后端（Cloudflare Worker，约 50 行）
 *
 * 为什么需要它：GitHub 已经下线了隐式流（response_type=token 不再返回 #access_token），
 * 只剩授权码流。而授权码流换 token 必须带 client_secret，纯静态页面不能放 secret，
 * 所以这一步只能挪到服务端。浏览器只拿到「用户名」，真正的 token 从不离开服务端。
 *
 * 部署：Cloudflare → Workers & Pages → Create Worker → 粘贴本文件 → 设置两个加密变量
 *   GH_CLIENT_ID      = Ov23li7TDJXKaxFNgIxd
 *   GH_CLIENT_SECRET  = （在 OAuth App 页面 Generate a new client secret 生成的那串）
 *   ALLOW_ORIGINS     = https://nefelibata857.github.io   （可选，默认就是这个）
 */

export default {
  async fetch(req, env) {
    const allow = (env.ALLOW_ORIGINS || 'https://nefelibata857.github.io')
      .split(',').map(s => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') || '';
    const okOrigin = allow.indexOf(origin) >= 0;

    const h = {
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    if (okOrigin) h['Access-Control-Allow-Origin'] = origin;

    const json = (o, s) => new Response(JSON.stringify(o), {
      status: s || 200,
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, h)
    });

    /* 跨域预检 */
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!okOrigin) return json({ error: 'origin_not_allowed', origin: origin }, 403);

    /* 只接受一个授权码，做基本格式校验（授权码只能用一次，10 分钟过期） */
    let code = '';
    try { code = String(((await req.json()) || {}).code || '').trim(); } catch (e) { return json({ error: 'bad_json' }, 400); }
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(code)) return json({ error: 'bad_code' }, 400);

    /* ① 授权码 + secret 换 token。这一步只能在服务端做 */
    const t = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'resume-autofill-gate'
      },
      body: JSON.stringify({
        client_id: env.GH_CLIENT_ID,
        client_secret: env.GH_CLIENT_SECRET,
        code: code
      })
    }).then(r => r.json().catch(() => ({})));

    if (!t || !t.access_token) {
      return json({
        error: t.error || 'exchange_failed',
        description: t.error_description || '',
        hint: '授权码只能用一次、10 分钟内有效；重复点「重新登录」一般会拿到新码'
      }, 502);
    }

    /* ② 只把用户名回给浏览器。token 到这里就丢掉，不落前端、不落日志 */
    const u = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': 'Bearer ' + t.access_token,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'resume-autofill-gate'
      }
    });
    if (!u.ok) return json({ error: 'user_failed', status: u.status }, 502);
    const me = await u.json().catch(() => ({}));

    return json({ login: me.login || '', name: me.name || '', at: Date.now() });
  }
};
