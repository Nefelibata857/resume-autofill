/**
 * 同一个后端的 Node / Express 版（部署到 Render、Railway、Fly.io、自己服务器都行）
 * 用法：
 *   npm i express
 *   GH_CLIENT_ID=Ov23li7TDJXKaxFNgIxd GH_CLIENT_SECRET=xxx PORT=3000 node server.js
 * 健康检查：GET /  →  { ok: true }
 *
 * 两个职责：
 *   1) POST /token  拿一次性授权码换用户名（client_secret 只在服务端出现）
 *   2) GET  /star   查某个账号有没有给仓库点过 star —— 读的是仓库**公开**的 stargazers 名单，
 *                   不需要任何 token、也不向用户要任何权限，所以老用户不用重新授权。
 */
const express = require('express');
const app = express();

const CLIENT_ID = process.env.GH_CLIENT_ID || 'Ov23li7TDJXKaxFNgIxd';
const CLIENT_SECRET = process.env.GH_CLIENT_SECRET || '';
const ALLOW = (process.env.ALLOW_ORIGINS || 'https://nefelibata857.github.io').split(',').map(s => s.trim());
/* 要检查点星的仓库，owner/repo */
const STAR_REPO = process.env.STAR_REPO || 'Nefelibata857/resume-autofill';
const UA = 'resume-autofill-gate';

app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOW.indexOf(origin) >= 0) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.json({ ok: true, service: 'resume-autofill-gate', repo: STAR_REPO }));

/* ---------- 点星检查 ---------- */

/* 结果缓存 3 分钟：点完星立刻回来查也能拿到新结果，又不会把 GitHub 的匿名额度（60 次/小时）打光 */
const starCache = new Map();   // login -> { v, at }
const STAR_TTL = 3 * 60 * 1000;
const MAX_PAGES = 30;          // 最多翻 3000 个 star，够用了

async function fetchStarred(login) {
  const key = String(login).toLowerCase();
  const hit = starCache.get(key);
  if (hit && Date.now() - hit.at < STAR_TTL) return hit.v;

  /* 为什么读 /users/:login/starred 而不是仓库的 stargazers 名单：
     仓库 stargazers 匿名访问已被 GitHub 关掉（401 Requires authentication），
     而「某个用户的 starred 列表」是公开的，匿名就能读 —— 不用向用户要 token、也不要任何权限。
     默认排序就是最近 star 的在前，点完星一般第一页第一条就命中。 */
  let starred = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetch(
      'https://api.github.com/users/' + encodeURIComponent(login) + '/starred?per_page=100&page=' + page,
      { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': UA } }
    );
    if (!r.ok) throw new Error('github_' + r.status);
    const arr = await r.json().catch(() => []);
    if (!Array.isArray(arr) || !arr.length) break;
    if (arr.some(x => String((x && x.full_name) || '').toLowerCase() === STAR_REPO.toLowerCase())) { starred = true; break; }
    if (arr.length < 100) break;
  }
  starCache.set(key, { v: starred, at: Date.now() });
  return starred;
}

app.get('/star', async (req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOW.indexOf(origin) < 0) return res.status(403).json({ error: 'origin_not_allowed', origin });

  const login = String(req.query.login || '').trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return res.status(400).json({ error: 'bad_login' });

  try {
    res.json({ login, repo: STAR_REPO, starred: await fetchStarred(login) });
  } catch (e) {
    res.status(502).json({ error: 'upstream_failed', description: String((e && e.message) || e) });
  }
});

/* ---------- 授权码换 token ---------- */

app.post('/token', async (req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOW.indexOf(origin) < 0) return res.status(403).json({ error: 'origin_not_allowed', origin });

  const code = String((req.body || {}).code || '').trim();
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(code)) return res.status(400).json({ error: 'bad_code' });
  if (!CLIENT_SECRET) return res.status(500).json({ error: 'server_missing_client_secret' });

  try {
    const t = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code })
    }).then(r => r.json().catch(() => ({})));

    if (!t || !t.access_token) {
      return res.status(502).json({
        error: t.error || 'exchange_failed',
        description: t.error_description || '',
        hint: '授权码只能用一次、10 分钟内有效'
      });
    }

    const u = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': 'Bearer ' + t.access_token, 'Accept': 'application/vnd.github+json', 'User-Agent': UA }
    });
    if (!u.ok) return res.status(502).json({ error: 'user_failed', status: u.status });
    const me = await u.json().catch(() => ({}));

    /* 顺便把「有没有点星」一起问出来：登录这一步就能决定给不给下载，
       免得前后端各跑一趟。查不到 star 也不算失败（网络抖一下不该挡人），先按没点处理。 */
    let starred = false;
    try { starred = await fetchStarred(me.login); } catch (e) {}

    res.json({ login: me.login || '', name: me.name || '', starred, repo: STAR_REPO, at: Date.now() });
  } catch (e) {
    res.status(502).json({ error: 'upstream_failed', description: String((e && e.message) || e) });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('gate listening on', process.env.PORT || 3000));
