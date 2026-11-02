/**
 * 同一个后端的 Node / Express 版（部署到 Render、Railway、Fly.io、自己服务器都行）
 * 用法：
 *   npm i express
 *   GH_CLIENT_ID=Ov23li7TDJXKaxFNgIxd GH_CLIENT_SECRET=xxx PORT=3000 node server.js
 * 健康检查：GET /  →  { ok: true }
 *
 * 两个职责：
 *   1) POST /token  拿一次性授权码换用户名（client_secret 只在服务端出现）
 *   2) GET  /star   查某个账号有没有给仓库点过 star —— 读的是该用户**公开**的 starred 列表，
 *                   不需要任何 token、也不向用户要任何权限，所以老用户不用重新授权。
 *
 * v2 变化：
 *   - 支持 ?fresh=1 跳过内存缓存（用户点完星回来点「重新检查」时用，不再等 3 分钟）
 *   - 支持 ?debug=1 返回上游诊断（GitHub 状态码、首页样本、命中位置），线上排查用
 *   - 仓库名比较统一 trim + 小写，避免环境变量里多一个空格就永远匹配不上
 *   - GitHub 返回非数组（限流/被拦）时不再静默当成「没点星」，直接 502 让前端说清楚
 */
const express = require('express');
const app = express();

const VERSION = 'gate/v2';
const CLIENT_ID = process.env.GH_CLIENT_ID || 'Ov23li7TDJXKaxFNgIxd';
const CLIENT_SECRET = process.env.GH_CLIENT_SECRET || '';
const ALLOW = (process.env.ALLOW_ORIGINS || 'https://nefelibata857.github.io').split(',').map(s => s.trim()).filter(Boolean);
/* 要检查点星的仓库，owner/repo */
const STAR_REPO = (process.env.STAR_REPO || 'Nefelibata857/resume-autofill').trim();
const WANT = STAR_REPO.toLowerCase();
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

app.get('/', (req, res) => res.json({
  ok: true, service: 'resume-autofill-gate', repo: STAR_REPO, version: VERSION
}));

/* ---------- 点星检查 ---------- */

/* 结果缓存 3 分钟：免得把 GitHub 的匿名额度（60 次/小时）打光。
   ?fresh=1 会绕过它 —— 用户点完星的那一下必须拿到当下的真实状态。 */
const starCache = new Map();   // login -> { v, at }
const STAR_TTL = 3 * 60 * 1000;
const MAX_PAGES = 30;          // 最多翻 3000 个 star，够用了

async function fetchStarred(login, opt) {
  opt = opt || {};
  const key = String(login).toLowerCase();
  if (!opt.fresh) {
    const hit = starCache.get(key);
    if (hit && Date.now() - hit.at < STAR_TTL) {
      return { starred: hit.v, info: { cached: true, ageMs: Date.now() - hit.at } };
    }
  }

  /* 读「某个用户的 starred 列表」而不是仓库的 stargazers 名单：
     后者匿名访问已被 GitHub 关掉（401 Requires authentication），
     前者是公开数据，匿名就能读 —— 不用向用户要 token、也不要任何权限。
     显式指定按 star 时间倒序，刚点完的仓库必然在第一页。 */
  const info = { upstream: 0, pages: 0, sample: [], matchedAt: -1, badBody: false, cached: false };
  let starred = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetch(
      'https://api.github.com/users/' + encodeURIComponent(login) +
      '/starred?per_page=100&sort=created&direction=desc&page=' + page,
      { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': UA } }
    );
    info.upstream = r.status;
    if (!r.ok) {
      /* 限流 / 被封 / 用户不存在：明确报错，别让用户对着「没点星」自我怀疑 */
      const txt = await r.text().catch(() => '');
      throw new Error('github_' + r.status + (txt ? ' ' + txt.slice(0, 120) : ''));
    }
    const arr = await r.json().catch(() => null);
    if (!Array.isArray(arr)) { info.badBody = true; break; }
    if (!arr.length) break;
    info.pages = page;
    if (page === 1) {
      info.sample = arr.slice(0, 8).map(x => String((x && x.full_name) || ''));
      info.totalFirstPage = arr.length;
    }
    const i = arr.findIndex(x => String((x && x.full_name) || '').trim().toLowerCase() === WANT);
    if (i >= 0) { starred = true; info.matchedAt = (page - 1) * 100 + i; break; }
    if (arr.length < 100) break;
  }

  if (info.badBody) throw new Error('github_bad_body');
  starCache.set(key, { v: starred, at: Date.now() });
  return { starred, info };
}

app.get('/star', async (req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOW.indexOf(origin) < 0) return res.status(403).json({ error: 'origin_not_allowed', origin });

  const login = String(req.query.login || '').trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return res.status(400).json({ error: 'bad_login' });

  const fresh = req.query.fresh === '1';
  const dbg = req.query.debug === '1';

  try {
    const r = await fetchStarred(login, { fresh });
    const body = { login, repo: STAR_REPO, starred: r.starred, v: VERSION, at: Date.now() };
    if (dbg) {
      body.diag = Object.assign({}, r.info, {
        repoExact: JSON.stringify(STAR_REPO),
        want: WANT,
        node: process.version
      });
    }
    res.json(body);
  } catch (e) {
    res.status(502).json({ error: 'upstream_failed', version: VERSION, description: String((e && e.message) || e) });
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

    /* 顺便把「有没有点星」一起问出来：登录这一步就能决定给不给下载。
       查不到 star 不算失败（网络抖一下不该挡人），先按没点处理，前端还能再查。 */
    let starred = false;
    try { starred = (await fetchStarred(me.login, { fresh: true })).starred; } catch (e) {}

    res.json({ login: me.login || '', name: me.name || '', starred, repo: STAR_REPO, v: VERSION, at: Date.now() });
  } catch (e) {
    res.status(502).json({ error: 'upstream_failed', description: String((e && e.message) || e) });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('gate listening on', process.env.PORT || 3000, VERSION));
