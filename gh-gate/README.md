# 登录门的换 token 后端

## 为什么需要它

GitHub 已经下线了 OAuth 隐式流（`response_type=token` 不再返回 `#access_token`，只会回 `?code=xxx`）。
现在只剩授权码流，而**授权码换 token 必须带 client_secret**——静态页面放 secret 等于公开泄露，
所以这一步只能挪到服务端。

这个后端一共只做三件事：

1. 拿浏览器送来的一次性 `code` + 服务端保管的 `client_secret`，向 GitHub 换 access_token；
2. 用这个 token 问一句「你是谁」，把用户名和 token 一起回给浏览器 ——
   token 交给浏览器是为了让第 3 步走**这个用户自己**的额度（5000 次/小时），服务端不落盘；
3. 查「他给本仓库点过 star 没有」——读的是**公开**的 starred 列表，不需要额外权限。

浏览器的 localStorage 里存的是 `{t:'srv', tok:'gho_…', login:'Nefelibata857'}`。
这个 OAuth App 的 **scope 是空的**：token 只能读公开数据 + 「你是谁」，改不了仓库、也读不到私有内容；
而同一份 localStorage 里本来就存着身份证号、手机号，token 的敏感度并不比那更高。

## v3：点星检查为什么会报 `github 403 API rate limit exceeded`

匿名访问 GitHub API 只有 **60 次/小时，而且按出口 IP 算**。Render 免费实例的出口 IP 是共享的，
别人（或爬虫）打光了，我们这边就全挂 —— 用户看到的是「这次检查没成功：github 403 …rate limit…」，
很容易误以为是自己没点星。

v3 改成三条通道，按优先级：

1. **登录用户自己的 token**（前端复查时带 `Authorization: Bearer`，登录时后端也暂存一份）——
   5000 次/小时、按 token 算，完全不占服务器额度；
2. **服务端只读 PAT**（可选环境变量 `GH_TOKEN`）—— 不想让用户 token 参与时用它兜底；
3. 都没有才退回匿名，并且**只查第一页**，尽量少吃额度。

限流时返回 `429 { error: "rate_limited" }`，前端说「等几分钟 / 点重新登录」，
不再含糊成「你没点星」。token 失效（401）会自动降级到下一档通道，不会把用户卡死。

> v3.2 起额度用完**直接放行**（`starred:true` + `assumed:'rate_limited'`）：
> 这道门防的是白嫖，不是防人，GitHub 免费接口的 60 次/小时不该成为正常用户下载的障碍。
> v4 的 webhook 上线后，已经点过星的人根本不走 API，这条兜底就更少被触发了。

## v4：GitHub App webhook —— 把「查星」从轮询改成推送

上面的通道再稳，也还是「用户点完星 → 我们主动去问 GitHub」。v4 换了个思路：
**让 GitHub 主动告诉我们**。用户点星的那一瞬间，GitHub 会 POST 一个事件到后端，
后端验签后把这个 login 记进名单，名单写回本仓库的 `gh-gate/stars.json`。

于是查星变成两级：

| 情况 | 走哪条 | 代价 |
|---|---|---|
| 名单里有人 | 直接放行 `via: "webhook"` | **0 次 API 调用**，点完星刷新就能下载 |
| 名单里没有 | 上面那条三级 API 通道 | 确认他真的没点 |

「谁 star 过仓库」本来就是 GitHub 上的公开信息，写进仓库反而透明 ——
你可以直接打开 `gh-gate/stars.json` 看有谁点了星。

> 注意：GitHub 的 `watch` 事件**只在点星时推，取消星不推**。
> 所以名单只增不减。对一道下载门来说这是可接受的取舍（真要取消特权，
> 手动从 `stars.json` 里删掉那一行即可）。

### 配起来（约 5 分钟）

**第一步：建 GitHub App**

GitHub → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**

| 项 | 填什么 |
|---|---|
| GitHub App name | 随便起，比如 `resume-autofill-star-gate` |
| Homepage URL | `https://nefelibata857.github.io/resume-autofill/` |
| **Webhook URL** | `https://resume-autofill-gate.onrender.com/gh-webhook` |
| **Webhook secret** | **自己编一串随机的**（比如 `openssl rand -hex 20`），这串待会儿要填到 Render |
| Repository permissions → Contents | `Read and write`（要能把名单写回仓库） |
| Subscribe to events | 勾 **Watch** |

创建后 → 左侧 **Install App** → 装到 `Nefelibata857/resume-autofill` 仓库（Only select repositories）。

**第二步：Render 加两个环境变量**

| 变量 | 值 |
|---|---|
| `WEBHOOK_SECRET` | 刚才在 Webhook secret 里自己编的那串（**必须和 App 里的一致**） |
| `GH_TOKEN` | 你自己的 fine-grained PAT，`Contents: Read and write`，只配 `resume-autofill` 仓库 |

保存后 Render 自动重启。打开 `https://resume-autofill-gate.onrender.com/` 应该看到
`{"webhook":true,"knownStars":N,"persist":true}`。

**第三步：验证**

1. 用另一个 GitHub 账号给仓库点星（或者先取消再重点）
2. 等 1～2 秒，看仓库里 `gh-gate/stars.json` 是否多了一行
3. 访问 `/star?login=<那个账号>&fresh=1&debug=1`，应返回 `via:"webhook"`

> 没配 `WEBHOOK_SECRET` 时，`/gh-webhook` 一律返回 `503` 拒绝——
> 否则谁都能 POST 一个假 login 进来把下载门解开。
> 没配 `GH_TOKEN` 也能跑：名单只存内存，重启/休眠后丢，退回 API 通道确认。

## 文件

| 文件 | 用途 |
|---|---|
| `server.js` | Node / Express 版 —— **线上用的是这个**（部署在 Render） |
| `package.json` | Express 依赖 + `npm start` |
| `stars.json` | 点星名单（webhook 写的，公开信息，可手改） |
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
- 命中了 webhook 名单时会多返回一个 `"via":"webhook"`，且 `?debug=1` 里 `apiCalls: 0`。

### 点星推送（GitHub App 用，浏览器不碰）

```
POST /gh-webhook
X-GitHub-Event: watch
X-Hub-Signature-256: sha256=<HMAC-SHA256(原始请求体, WEBHOOK_SECRET)>
```

- 只认 `watch` + `action=started` + 仓库名匹配 `STAR_REPO`，其他一概忽略（但都回 `202`，GitHub 对非 2xx 会重试）；
- 验签失败 `403 bad_signature`；没配 `WEBHOOK_SECRET` 时 `503`；
- 先回 `202` 再干活（写仓库是慢活，不能让 GitHub 等）；
- 也可以用 `curl` 模拟，方便本地验证：

```bash
SEC=你的webhook secret
BODY='{"action":"started","repository":{"full_name":"Nefelibata857/resume-autofill"},"sender":{"login":"Nefelibata857"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SEC" | awk '{print $2}')"
curl -i -X POST https://resume-autofill-gate.onrender.com/gh-webhook \
  -H 'Content-Type: application/json' -H 'X-GitHub-Event: watch' -H "X-Hub-Signature-256: $SIG" \
  -d "$BODY"
```

## 安全边界

- client_secret 只存在于服务端环境变量里，不下发、不进日志；
- GitHub access_token 只在服务端内存中出现一次，用完即弃，不落库、不返回；
- 只向浏览器返回用户名与点星状态，不返回任何 token；
- 点星检查只读公开数据，**不向用户索取任何权限**（scope 仍是空）；
- CORS 白名单锁死为 `https://nefelibata857.github.io`；
- 授权码只允许 `[A-Za-z0-9_-]{10,80}`，且本来就是一次性的；
- `/gh-webhook` 用 `X-Hub-Signature-256`（HMAC-SHA256）验签，`timingSafeEqual` 防时序攻击；
  密钥没配就整条路由 `503` 关掉 —— 不会出现「忘了设防反而能解锁」的情况。

> 说明：这只是一个「确认对方是 GitHub 真人用户」的门槛，不是严格鉴权——
> 任何人只要有个 GitHub 账号都能过。它的作用是提高批量抓取的成本，不是防专业攻击者。
