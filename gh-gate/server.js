/**
 * 同一个后端的 Node / Express 版（部署到 Render、Railway、Fly.io、自己服务器都行）
 * 用法：
 *   npm i express
 *   GH_CLIENT_ID=Ov23li7TDJXKaxFNgIxd GH_CLIENT_SECRET=xxx PORT=3000 node server.js
 * 健康检查：GET /  →  { ok: true }
 */
const express = require('express');
const app = express();

const CLIENT_ID = process.env.GH_CLIENT_ID || 'Ov23li7TDJXKaxFNgIxd';
const CLIENT_SECRET = process.env.GH_CLIENT_SECRET || '';
const ALLOW = (process.env.ALLOW_ORIGINS || 'https://nefelibata857.github.io').split(',').map(s => s.trim());

app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOW.indexOf(origin) >= 0) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.json({ ok: true, service: 'resume-autofill-gate' }));

app.post('/token', async (req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOW.indexOf(origin) < 0) return res.status(403).json({ error: 'origin_not_allowed', origin });

  const code = String((req.body || {}).code || '').trim();
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(code)) return res.status(400).json({ error: 'bad_code' });
  if (!CLIENT_SECRET) return res.status(500).json({ error: 'server_missing_client_secret' });

  try {
    const t = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'resume-autofill-gate' },
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
      headers: { 'Authorization': 'Bearer ' + t.access_token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'resume-autofill-gate' }
    });
    if (!u.ok) return res.status(502).json({ error: 'user_failed', status: u.status });
    const me = await u.json().catch(() => ({}));

    res.json({ login: me.login || '', name: me.name || '', at: Date.now() });
  } catch (e) {
    res.status(502).json({ error: 'upstream_failed', description: String(e && e.message || e) });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('gate listening on', process.env.PORT || 3000));
