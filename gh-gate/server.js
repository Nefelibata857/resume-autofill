/**
 * 同一个后端的 Node / Express 版（部署到 Render、Railway、Fly.io、自己服务器都行）
 * 用法：
 *   npm i express
 *   GH_CLIENT_ID=Ov23li7TDJXKaxFNgIxd GH_CLIENT_SECRET=xxx PORT=3000 node server.js
 * 健康检查：GET /  →  { ok: true }
 *
 * 两个职责：
 *   1) POST /token  拿一次性授权码换用户名（client_secret 只在服务端出现）
 *   2) GET  /star   查某个账号有没有给仓库点过 star —— 读的是该用户**公开**的 starred 列表
 *
 * v2：?fresh=1 跳缓存、?debug=1 出诊断；仓库名比较 trim+小写；非数组不再静默当「没点星」。
 *
 * v3（修「github 403 API rate limit exceeded」）：
 *   匿名访问 GitHub 只有 60 次/小时，而且是**按出口 IP** 算的 ——
 *   Render 免费实例的出口 IP 是共享的，别人打光了我们就没有了，
 *   用户看到的是「这次检查没成功：github 403 API rate limit exceeded」，
 *   还会误以为是自己没点星。三条通道，按优先级：
 *     ① 登录用户自己的 token（5000 次/小时，按 token 算，完全不占服务器额度）
 *        —— 前端复查时把 token 带在 Authorization 头里；后端登录时也暂存一份兜底
 *     ② 服务端自己的只读 PAT（环境变量 GH_TOKEN，可选；配了就更稳）
 *     ③ 都没有 → 退回匿名（60 次/小时），并且只查第一页，别把额度吃光
 *   限流时返回 429 + error=rate_limited，让前端说「等几分钟」而不是「你没点星」。
 *
 * v3.2：额度用完时不再拦人，直接放行（starred:true + assumed:'rate_limited'）——
 *        这道门防的是白嫖，不是防人；GitHub 免费接口的 60 次/小时不该成为下载障碍。
 *
 * v4（GitHub App webhook：把「查星」从轮询改成推送）：
 *   建一个 GitHub App 订阅 Watch 事件，用户点星的瞬间 GitHub 会主动 POST 到
 *   POST /gh-webhook。后端验签后把这个 login 记进名单，并把名单写回本仓库的
 *   gh-gate/stars.json（用 GH_TOKEN）—— Render 休眠/重启也不丢；
 *   而且「谁 star 过仓库」本来就是 GitHub 上的公开信息，写进仓库反而透明。
 *   于是查星变成两级：
 *     ① 名单里有人 → 直接放行，0 次 API 调用、点完星立刻生效（不用等也不用重试）
 *     ② 名单里没有 → 才走上面那条三级 API 通道，确认「他真的没点」
 *   环境变量：
 *     WEBHOOK_SECRET  建 GitHub App 时自己填的 webhook 密钥（不配就拒绝一切推送）
 *     GH_TOKEN        需要 Contents:write 才能把名单写回仓库；只读也能跑（名单只存内存）
 */
const express = require('express');
const crypto = require('crypto');
const app = express();

const VERSION = 'gate/v4';
const CLIENT_ID = process.env.GH_CLIENT_ID || 'Ov23li7TDJXKaxFNgIxd';
const CLIENT_SECRET = process.env.GH_CLIENT_SECRET || '';
const GH_TOKEN = (process.env.GH_TOKEN || '').trim();   /* 可选：服务端自己的只读 PAT */
const ALLOW = (process.env.ALLOW_ORIGINS || 'https://nefelibata857.github.io').split(',').map(s => s.trim()).filter(Boolean);
/* 要检查点星的仓库，owner/repo */
const STAR_REPO = (process.env.STAR_REPO || 'Nefelibata857/resume-autofill').trim();
const WANT = STAR_REPO.toLowerCase();
const UA = 'resume-autofill-gate';
/* 线上工具页地址：/ver 用它反查「最新引擎是哪个版本」 */
const PAGES_URL = (process.env.PAGES_URL || 'https://nefelibata857.github.io/resume-autofill/').trim();

/* ---------- 点星名单（webhook 推送，零 API 调用） ---------- */

/* 建 GitHub App 时自己设的 webhook 密钥；不配就拒绝所有推送，
   否则谁都能 POST 一个假 login 进来把下载门解开。 */
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || '').trim();
/* 名单存成本仓库里的这个文件，公开可见（GitHub 上本来就能看到谁 star 过） */
const STARS_PATH = 'gh-gate/stars.json';
const knownStars = new Set();      // 小写 login
let starsSha = '';                 // 写回仓库要带的文件 sha
let writeChain = Promise.resolve();

function ghApi(path, opt) {
  opt = opt || {};
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': UA };
  if (GH_TOKEN) headers['Authorization'] = 'Bearer ' + GH_TOKEN;
  return fetch('https://api.github.com' + path,
    Object.assign({ headers, signal: AbortSignal.timeout(15000) }, opt));
}

/* 启动时把仓库里的名单读回来：Render 免费实例会休眠，内存丢了得能从仓库恢复 */
async function loadStars() {
  try {
    const r = await ghApi('/repos/' + STAR_REPO + '/contents/' + STARS_PATH);
    if (r.status === 404) { starsSha = ''; return { ok: true, empty: true }; }
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json().catch(() => ({}));
    starsSha = String(j.sha || '');
    const txt = Buffer.from(String(j.content || ''), 'base64').toString('utf8');
    const d = JSON.parse(txt);
    if (Array.isArray(d.stars)) d.stars.forEach(x => knownStars.add(String(x).toLowerCase()));
    return { ok: true, loaded: knownStars.size };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* 记一个点星者：先进内存（立刻生效），再异步写回仓库（重启后还在）。
   串行执行，避免两个人同时点星时 sha 打架。 */
function noteStar(login) {
  const key = String(login).toLowerCase();
  if (knownStars.has(key)) return;
  knownStars.add(key);
  writeChain = writeChain.then(async () => {
    if (!GH_TOKEN) return;               /* 没有写权限就只存内存，不阻塞解锁 */
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const body = JSON.stringify({
          repo: STAR_REPO,
          updated: new Date().toISOString(),
          count: knownStars.size,
          stars: Array.from(knownStars).sort()
        }, null, 2) + '\n';
        const r = await ghApi('/repos/' + STAR_REPO + '/contents/' + STARS_PATH, {
          method: 'PUT',
          body: JSON.stringify({
            message: 'gate: ' + login + ' starred',
            content: Buffer.from(body, 'utf8').toString('base64'),
            branch: 'main',
            sha: starsSha || undefined      /* 新文件时省略这个字段 */
          })
        });
        if (r.ok) {
          const j = await r.json().catch(() => ({}));
          starsSha = String((j.content && j.content.sha) || starsSha);
          return;
        }
        /* 409/422 = 本地 sha 过期（别人刚改过）→ 重新拉一次，把别人加的也合进来再试 */
        if (r.status === 409 || r.status === 422) {
          const g = await ghApi('/repos/' + STAR_REPO + '/contents/' + STARS_PATH);
          if (g.ok) {
            const j = await g.json().catch(() => ({}));
            starsSha = String(j.sha || '');
            try {
              const t = Buffer.from(String(j.content || ''), 'base64').toString('utf8');
              const d = JSON.parse(t);
              if (Array.isArray(d.stars)) d.stars.forEach(x => knownStars.add(String(x).toLowerCase()));
            } catch (e) { /* 远端文件坏了也不解锁阻塞，继续用内存名单 */ }
            continue;
          }
          return;
        }
        return;                            /* 其余错误：放弃持久化，内存名单照常生效 */
      } catch (e) { return; }
    }
  }).catch(() => {});
}

/* webhook 必须验签：用原始字节算 HMAC-SHA256，和 X-Hub-Signature-256 对。
   所以这个路由要挂在 express.json() 之前，body 得保持 Buffer。 */
app.post('/gh-webhook', express.raw({ type: '*/*', limit: '256kb' }), (req, res) => {
  if (!WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'webhook_secret_not_configured', hint: '在 Render 环境变量里配 WEBHOOK_SECRET' });
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const sig = String(req.headers['x-hub-signature-256'] || '');
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  const want = 'sha256=' + mac;
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'bad_signature' });
  }

  /* 先回 202：GitHub 等不了太久，写仓库这种慢活放后面做 */
  res.status(202).json({ ok: true });

  const ev = String(req.headers['x-github-event'] || '');
  if (ev !== 'watch') return;                      /* 只关心点星 */
  let p = null;
  try { p = JSON.parse(raw.toString('utf8')); } catch (e) { return; }
  if (!p || p.action !== 'started') return;        /* watch 事件只有 started（取消星不推） */
  const full = String((p.repository && p.repository.full_name) || '').trim().toLowerCase();
  if (full !== WANT) return;                       /* 点的是别的仓库，不是我们的门 */
  const login = String((p.sender && p.sender.login) || '').trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return;
  noteStar(login);
});

app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOW.indexOf(origin) >= 0) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.json({
  ok: true, service: 'resume-autofill-gate', repo: STAR_REPO, version: VERSION,
  serverToken: !!GH_TOKEN,
  webhook: !!WEBHOOK_SECRET,          /* GitHub App 配好了没有 */
  knownStars: knownStars.size,        /* 名单里已经有几个人（webhook 记的 + 启动时读回来的） */
  persist: !!GH_TOKEN                 /* 能不能把名单写回仓库 */
}));

/* ---------- 引擎版本查询 ----------
   书签是「装了就一直用」的代码快照：引擎从 v39 修到 v41，用户手里的书签
   还是旧代码，而他自己完全看不出落后了几个版本 —— 每次都得靠人工提醒
   「去重装书签」。跑的时候问一句线上最新版本，落后就在面板上提示。
   Pages 页面 230KB，没必要每次真拉，内存里缓存 5 分钟。 */
const verCache = { at: 0, v: '' };
app.get('/ver', async (req, res) => {
  if (verCache.v && Date.now() - verCache.at < 5 * 60 * 1000) {
    return res.json({ version: verCache.v, cached: 1 });
  }
  try {
    const r = await fetch(PAGES_URL, { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' } });
    const t = await r.text();
    const m = t.match(/ENGINE_VER\s*=\s*'(v\d+)'/);
    if (m && m[1]) {
      verCache.at = Date.now();
      verCache.v = m[1];
      return res.json({ version: m[1] });
    }
    res.json({ version: verCache.v || '', err: 'not_found' });
  } catch (e) {
    res.json({ version: verCache.v || '', err: String((e && e.message) || e) });
  }
});

/* ---------- 点星检查 ---------- */

/* 结果缓存 3 分钟：免得同一秒里连点几次把额度打光。
   ?fresh=1 会绕过它 —— 用户点完星的那一下必须拿到当下的真实状态。 */
const starCache = new Map();   // login -> { v, at }
const STAR_TTL = 3 * 60 * 1000;

/* 登录时换到的 token 暂存一份，复查没带 token 时兜底。
   Render 免费实例会休眠、重启就没了，所以前端复查时也会自己带 —— 两条都认。 */
const tokenStore = new Map();  // login -> { tok, at }
const TOK_TTL = 25 * 60 * 1000;

function bearer(req) {
  const h = String((req.headers && req.headers.authorization) || '');
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : '';
}

async function fetchStarred(login, opt) {
  opt = opt || {};
  const key = String(login).toLowerCase();
  if (!opt.fresh) {
    const hit = starCache.get(key);
    if (hit && Date.now() - hit.at < STAR_TTL) {
      return { starred: hit.v, info: { cached: true, ageMs: Date.now() - hit.at } };
    }
  }

  /* 挑一条额度通道 */
  const stash = tokenStore.get(key);
  const stashTok = (stash && Date.now() - stash.at < TOK_TTL) ? stash.tok : '';
  let tok = opt.token || stashTok || GH_TOKEN;
  let via = opt.token ? 'user' : (stashTok ? 'stash' : (GH_TOKEN ? 'server' : 'anon'));

  /* 读「某个用户的 starred 列表」而不是仓库的 stargazers 名单：
     后者匿名访问已被 GitHub 关掉（401 Requires authentication），
     前者是公开数据，匿名也能读；带 token 只是为了把额度从 60 提到 5000。
     显式按 star 时间倒序，刚点完的仓库必然在第一页。 */
  const MAX_PAGES = tok ? 6 : 1;   /* 匿名只查第一页，别把 60 次吃光 */
  const info = {
    upstream: 0, pages: 0, sample: [], matchedAt: -1, badBody: false, cached: false,
    authed: !!tok, via, maxPages: MAX_PAGES
  };
  let starred = false;

  async function walk(token) {
    const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': UA };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await fetch(
        'https://api.github.com/users/' + encodeURIComponent(login) +
        '/starred?per_page=100&sort=created&direction=desc&page=' + page,
        { headers }
      );
      info.upstream = r.status;

      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        if (r.status === 401 && token) {         /* token 过期/被撤销 → 换下一档通道 */
          const e = new Error('token_dead'); e.tokenDead = true; throw e;
        }
        /* 限流：429，或 403 且正文提到 rate limit */
        if (r.status === 429 || (r.status === 403 && /rate limit/i.test(txt))) {
          const e = new Error('rate_limited');
          e.rateLimited = true;
          e.reset = r.headers.get('x-ratelimit-reset') || '';
          e.remaining = r.headers.get('x-ratelimit-remaining') || '';
          e.authed = !!token;
          throw e;
        }
        throw new Error('github_' + r.status + (txt ? ' ' + txt.slice(0, 120) : ''));
      }

      const arr = await r.json().catch(() => null);
      if (!Array.isArray(arr)) { info.badBody = true; return false; }
      if (!arr.length) return false;
      info.pages = page;
      if (page === 1) {
        info.sample = arr.slice(0, 8).map(x => String((x && x.full_name) || ''));
        info.totalFirstPage = arr.length;
      }
      const i = arr.findIndex(x => String((x && x.full_name) || '').trim().toLowerCase() === WANT);
      if (i >= 0) { info.matchedAt = (page - 1) * 100 + i; return true; }
      if (arr.length < 100) return false;
    }
    return false;
  }

  try {
    starred = await walk(tok);
  } catch (e) {
    /* 用户 token 失效了：清掉，用服务端 token / 匿名再走一遍，别让用户卡在这 */
    if (e && e.tokenDead) {
      tokenStore.delete(key);
      tok = GH_TOKEN;
      via = GH_TOKEN ? 'server' : 'anon';
      info.authed = !!tok; info.via = via; info.maxPages = tok ? 6 : 1;
      starred = await walk(tok);
    } else throw e;
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
  const tok = bearer(req) || String(req.query.token || '').trim() || '';
  const key = login.toLowerCase();

  /* ① 名单里有人 → 直接放行。webhook 是 GitHub 主动推的，比我们轮询更及时，
       而且一次 API 都不用调 —— 点完星刷新就能下载，不用等也不用重试。 */
  if (knownStars.has(key)) {
    starCache.set(key, { v: true, at: Date.now() });
    const body = { login, repo: STAR_REPO, starred: true, via: 'webhook', v: VERSION, at: Date.now() };
    if (dbg) body.diag = { via: 'webhook', known: knownStars.size, apiCalls: 0, hasServerToken: !!GH_TOKEN };
    return res.json(body);
  }

  try {
    const r = await fetchStarred(login, { fresh, token: tok || undefined });
    const body = { login, repo: STAR_REPO, starred: r.starred, v: VERSION, at: Date.now() };
    if (dbg) {
      body.diag = Object.assign({}, r.info, {
        repoExact: JSON.stringify(STAR_REPO),
        want: WANT,
        node: process.version,
        hasUserToken: !!tok,
        hasServerToken: !!GH_TOKEN
      });
    }
    res.json(body);
  } catch (e) {
    if (e && e.rateLimited) {
      /* 额度用完 → 直接放行（不给验证结论，但也不把人拦在门外）。
         GitHub 免费接口的 60 次/小时不该变成正常用户下载的障碍：
         这道门防的是白嫖，不是防人。assumed 标记让前端能说明「没验证成功」。 */
      return res.json({
        login, repo: STAR_REPO, starred: true, assumed: 'rate_limited',
        v: VERSION, at: Date.now(),
        description: '没能向 GitHub 验证（接口额度用完了），先放行'
      });
    }
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

    /* 把 token 暂存一份：复查时前端会自己带，万一没带这里还能兜底 */
    if (me.login) tokenStore.set(String(me.login).toLowerCase(), { tok: t.access_token, at: Date.now() });

    /* 顺便把「有没有点星」一起问出来：登录这一步就能决定给不给下载。
       名单里已经有他 → 直接算通过，一次 API 都不用调。 */
    let starred = false, assumed = '';
    if (knownStars.has(String(me.login).toLowerCase())) {
      starred = true;
    } else {
      try {
        starred = (await fetchStarred(me.login, { fresh: true, token: t.access_token })).starred;
      } catch (e) {
        /* 额度用完 → 放行（不给验证结论，但也不把人拦在门外）。 */
        if (e && e.rateLimited) { starred = true; assumed = 'rate_limited'; }
      }
      /* 这一趟确认他是点过星的，顺手记进名单，以后他就走 webhook 那条零调用的路 */
      if (starred) noteStar(me.login);
    }

    /* 把 token 一并交回浏览器：之后每次复查「点没点星」都带上它，
       走的是这个用户自己的 5000 次/小时额度，不再受服务器出口 IP 那 60 次连累。
       这个 OAuth App 的 scope 是空的，token 只能读公开数据 + 「你是谁」，
       而页面本来就把身份证号手机号存在同一份 localStorage 里 —— 风险并不比那更高。 */
    res.json({
      login: me.login || '', name: me.name || '', starred, assumed, repo: STAR_REPO,
      token: t.access_token || '', v: VERSION, at: Date.now()
    });
  } catch (e) {
    res.status(502).json({ error: 'upstream_failed', description: String((e && e.message) || e) });
  }
});

/* 名单先就位再开始收请求：Render 冷启动时也不会漏掉已经点过星的人。
   读仓库最多等 8 秒，超时也照样起来（名单为空，退回 API 通道确认）。 */
Promise.race([
  loadStars(),
  new Promise(r => setTimeout(r, 8000))
]).then(r => {
  if (r && r.ok && r.loaded) console.log('loaded', r.loaded, 'known stars');
  app.listen(process.env.PORT || 3000, () => console.log('gate listening on', process.env.PORT || 3000, VERSION,
    '| webhook', WEBHOOK_SECRET ? 'on' : 'OFF', '| knownStars', knownStars.size, '| persist', GH_TOKEN ? 'on' : 'off'));
});
