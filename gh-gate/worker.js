/**
 * GitHub 登录门 —— 换 token + 查 star 的小后端（Cloudflare Worker 版）
 *
 * 为什么需要它：GitHub 已经下线了隐式流（response_type=token 不再返回 #access_token），
 * 只剩授权码流。而授权码流换 token 必须带 client_secret，纯静态页面不能放 secret，
 * 所以这一步只能挪到服务端。浏览器只拿到「用户名」，真正的 token 从不离开服务端。
 *
 * 注意：workers.dev 在国内被 DNS 污染打不开，正式用的是同目录 server.js（部署在 Render）。
 *       这份留作备用 —— 两条线路的功能保持一致（POST /token、GET /star）。
 *
 * 部署：Cloudflare → Workers & Pages → Create Worker → 粘贴本文件 → 设置加密变量
 *   GH_CLIENT_ID      = Ov23li7TDJXKaxFNgIxd
 *   GH_CLIENT_SECRET  = （OAuth App 页面 Generate a new client secret 生成的那串）
 *   ALLOW_ORIGINS     = https://nefelibata857.github.io   （可选，默认就是这个）
 *   STAR_REPO         = Nefelibata857/resume-autofill     （可选，默认就是这个）
 */

const UA = 'resume-autofill-gate';

/* 每个 Worker 实例各自缓存，够挡住高频刷新 */
const starCache = new Map();   // login -> { v, at }
const STAR_TTL = 3 * 60 * 1000;
const MAX_PAGES = 30;

async function fetchStarred(repo, login) {
  const key = String(login).toLowerCase();
  const hit = starCache.get(key);
  if (hit && Date.now() - hit.at < STAR_TTL) return hit.v;

  /* 读「某个用户的 starred 列表」而不是仓库的 stargazers 名单：
     后者匿名访问已被 GitHub 关掉（401），前者是公开数据，不需要 token 也不需要权限 */
  let starred = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetch('https://api.github.com/users/' + encodeURIComponent(login) + '/starred?per_page=100&page=' + page, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': UA }
    });
    if (!r.ok) throw new Error('github_' + r.status);
    const arr = await r.json().catch(() => []);
    if (!Array.isArray(arr) || !arr.length) break;
    if (arr.some(x => String((x && x.full_name) || '').toLowerCase() === repo.toLowerCase())) { starred = true; break; }
    if (arr.length < 100) break;
  }
  starCache.set(key, { v: starred, at: Date.now() });
  return starred;
}

export default {
  async fetch(req, env) {
    const allow = (env.ALLOW_ORIGINS || 'https://nefelibata857.github.io')
      .split(',').map(s => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') || '';
    const okOrigin = allow.indexOf(origin) >= 0;
    const repo = env.STAR_REPO || 'Nefelibata857/resume-autofill';

    const h = {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    if (okOrigin) h['Access-Control-Allow-Origin'] = origin;

    const json = (o, s) => new Response(JSON.stringify(o), {
      status: s || 200,
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, h)
    });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (!okOrigin) return json({ error: 'origin_not_allowed', origin: origin }, 403);

    /* 健康检查 */
    if (path === '/' || path === '') return json({ ok: true, service: 'resume-autofill-gate', repo: repo });

    /* ---------- 查点星（读公开名单，不需要 token） ---------- */
    if (path === '/star') {
      if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const login = String(url.searchParams.get('login') || '').trim();
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return json({ error: 'bad_login' }, 400);
      try {
        return json({ login: login, repo: repo, starred: await fetchStarred(repo, login) });
      } catch (e) {
        return json({ error: 'upstream_failed', description: String((e && e.message) || e) }, 502);
      }
    }

    if (path !== '/token') return json({ error: 'not_found' }, 404);
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

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
        'User-Agent': UA
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

    /* ② 只把用户名（和点星状态）回给浏览器。token 到这里就丢掉，不落前端、不落日志 */
    const u = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': 'Bearer ' + t.access_token,
        'Accept': 'application/vnd.github+json',
        'User-Agent': UA
      }
    });
    if (!u.ok) return json({ error: 'user_failed', status: u.status }, 502);
    const me = await u.json().catch(() => ({}));

    let starred = false;
    try { starred = await fetchStarred(repo, me.login); } catch (e) {}

    return json({ login: me.login || '', name: me.name || '', starred: starred, repo: repo, at: Date.now() });
  }
};
