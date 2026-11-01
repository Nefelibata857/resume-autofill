# 登录门的换 token 后端

## 为什么需要它

GitHub 已经下线了 OAuth 隐式流（`response_type=token` 不再返回 `#access_token`，只会回 `?code=xxx`）。
现在只剩授权码流，而**授权码换 token 必须带 client_secret**——静态页面放 secret 等于公开泄露，
所以这一步只能挪到服务端。

这个后端一共只做三件事：

1. 拿浏览器送来的一次性 `code` + 服务端保管的 `client_secret`，向 GitHub 换 access_token；
2. 用这个 token 问一句「你是谁」，**只把用户名回给浏览器**，token 当场丢掉；
3. 用这个用户名去查「他给本仓库点过 star 没有」——读的是**公开**的 starred 列表，不需要 token、也不需要任何权限。

浏览器的 localStorage 里最后只有 `{t:'srv', login:'Nefelibata857'}`，没有 GitHub token。

## 文件

| 文件 | 用途 |
|---|---|
| `server.js` | Node / Express 版 —— **线上用的是这个**（部署在 Render） |
| `package.json` | Express 依赖 + `npm start` |
| `worker.js` | Cloudflare Worker 版（备用，见下方「为什么不用它」） |

## 部署（Render，约 3 分钟）

仓库根目录有一份 `render.yaml`（Blueprint），最省事：

1. Render 控制台 → **New +** → **Blueprint** → 选 `Nefelibata857/resume-autofill` 仓库 → **Apply**。
2. 它会把服务名建为 `resume-autofill-gate`、根目录指到 `gh-gate/`、自动跑 `npm install && node server.js`。
3. 弹出 `GH_CLIENT_SECRET` 的输入框时填入那串 secret（`render.yaml` 里标了 `sync: false`，
   所以不会写进仓库）。`GH_CLIENT_ID` 和 `ALLOW_ORIGINS` 已在蓝图里配好。

也可以手动建：**New + → Web Service** → 选仓库 → Root Directory 填 `gh-gate` →
Build `npm install` → Start `node server.js` → 环境变量加 `GH_CLIENT_ID`、`GH_CLIENT_SECRET`。

4. 服务地址就是 `https://resume-autofill-gate.onrender.com`，前端 `var GH_API` 已经指向
   `https://resume-autofill-gate.onrender.com/token`，**不用改任何代码**。

验证：浏览器打开 `https://resume-autofill-gate.onrender.com/` 应返回 `{"ok":true,...}`。

> 免费实例闲置 15 分钟会挂起，下次请求要 30～60 秒才醒。前端做了两件事缓解：
> 页面打开 1.5 秒后静默 `GET /` 预热；换凭证超过 6 秒就把提示条切成「正在唤醒登录服务」。

## 为什么不用 Cloudflare Worker

`*.workers.dev` 在中国大陆被 DNS 污染——实测解析出来是 `199.59.148.106` /
`2a03:2880:f11c:8183:face:b00c:0:25de`（Facebook 的 IP），浏览器报 `ERR_CONNECTION_TIMED_OUT`。
访客打不开就等于登录不了。`*.vercel.app`、`*.deno.dev` 同样不通；
`*.onrender.com` 实测 200 / 1.3s，可用。

`worker.js` 仍然保留：如果你以后有自己的域名并托管在 Cloudflare，可以给 Worker 绑自定义域名再用它，
那样没有冷启动，比 Render 体验好。

## 部署（Node 版本地跑）

```bash
npm i express
GH_CLIENT_ID=Ov23li7TDJXKaxFNgIxd GH_CLIENT_SECRET=xxx PORT=3000 node server.js
# 健康检查：curl http://localhost:3000/  →  {"ok":true}
```

## client secret 在哪拿

GitHub → **Settings** → **Developer settings** → **OAuth Apps** → 打开那个 App
（client_id 是 `Ov23li7TDJXKaxFNgIxd` 的那个）→ **Generate a new client secret**。
**这串只显示一次**，生成后立刻粘到环境变量里。

同一个页面确认 **Authorization callback URL** 正好是
`https://nefelibata857.github.io/resume-autofill/`（**结尾的斜杠必须有**）。

## 接口

```
POST /token
Content-Type: application/json
Origin: https://nefelibata857.github.io

{ "code": "GitHub 回调带回来的一次性授权码" }
```

成功 `200`（`starred` 是顺便查好的点星状态，前端据此决定放不放行下载）：

```json
{ "login": "Nefelibata857", "name": "王勇超", "starred": true,
  "repo": "Nefelibata857/resume-autofill", "at": 1730000000000 }
```

失败（举例）`502`：

```json
{ "error": "exchange_failed",
  "description": "The code passed is incorrect or expired.",
  "hint": "授权码只能用一次、10 分钟内有效" }
```

其他：`405` 非 POST、`403` Origin 不在白名单、`400` code 格式不对、
`500 server_missing_client_secret` 忘了配 secret。

`GET /` 返回 `{"ok":true}`，只用于健康检查和前端预热。

### 查点星

```
GET /star?login=Nefelibata857
Origin: https://nefelibata857.github.io
```

```json
{ "login": "Nefelibata857", "repo": "Nefelibata857/resume-autofill", "starred": true }
```

- 数据源是 `GET /users/:login/starred`（公开、匿名可读）。
  仓库的 `/repos/:owner/:repo/stargazers` 现在匿名请求会返回 `401 Requires authentication`，所以没用它。
- 结果在内存里缓存 3 分钟：点完星马上回来查也能拿到新值，又不至于把 GitHub 的匿名额度（60 次/小时）打光。
- 参数不合法 `400`；查不到（GitHub 侧失败 / 被限流）`502`，前端会提示「正在唤醒服务」并自动重试一次。
- 要换检查对象就设环境变量 `STAR_REPO=owner/repo`。

## 安全边界

- client_secret 只存在于服务端环境变量里，不下发、不进日志；
- GitHub access_token 只在服务端内存中出现一次，用完即弃，不落库、不返回；
- 只向浏览器返回用户名与点星状态，不返回任何 token；
- 点星检查只读公开数据，**不向用户索取任何权限**（scope 仍是空）；
- CORS 白名单锁死为 `https://nefelibata857.github.io`；
- 授权码只允许 `[A-Za-z0-9_-]{10,80}`，且本来就是一次性的。

> 说明：这只是一个「确认对方是 GitHub 真人用户」的门槛，不是严格鉴权——
> 任何人只要有个 GitHub 账号都能过。它的作用是提高批量抓取的成本，不是防专业攻击者。
