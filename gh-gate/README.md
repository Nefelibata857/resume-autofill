# 登录门的换 token 后端

## 为什么需要它

GitHub 已经下线了 OAuth 隐式流（`response_type=token` 不再返回 `#access_token`，只会回 `?code=xxx`）。
现在只剩授权码流，而**授权码换 token 必须带 client_secret**——静态页面放 secret 等于公开泄露，
所以这一步只能挪到服务端。

这个后端一共只做两件事：

1. 拿浏览器送来的一次性 `code` + 服务端保管的 `client_secret`，向 GitHub 换 access_token；
2. 用这个 token 问一句「你是谁」，**只把用户名回给浏览器**，token 当场丢掉。

浏览器的 localStorage 里最后只有 `{t:'srv', login:'Nefelibata857'}`，没有 GitHub token。

## 文件

| 文件 | 用途 |
|---|---|
| `worker.js` | Cloudflare Worker 版（推荐：免费、无冷启动、全球边缘） |
| `server.js` | Node / Express 版（Render、Railway、Fly.io、自己的服务器） |

## 部署（Cloudflare Worker，约 3 分钟）

1. 打开 https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker**，
   随便起个名字（比如 `resume-autofill-gate`）→ **Deploy**。
2. 点 **Edit code**，把 `worker.js` 的内容整段粘进去，覆盖默认代码 → **Deploy**。
3. **Settings → Variables and Secrets → Add**，加两个（类型都选 **Secret**，加密存储）：

   | 变量名 | 值 |
   |---|---|
   | `GH_CLIENT_ID` | `Ov23li7TDJXKaxFNgIxd` |
   | `GH_CLIENT_SECRET` | OAuth App 页面生成的那串（见下） |

   可选再加一个普通变量 `ALLOW_ORIGINS`，默认已经是 `https://nefelibata857.github.io`。

4. 复制 Worker 的访问地址（`https://resume-autofill-gate.<你的子域>.workers.dev`），
   把它填到 `index.html` 里的 `var GH_API = '.../token';`（只改这一处），提交推送。

### client secret 在哪拿

GitHub → **Settings** → **Developer settings** → **OAuth Apps** → 打开那个 App
（client_id 是 `Ov23li7TDJXKaxFNgIxd` 的那个）→ **Generate a new client secret**。
**这串只显示一次**，生成后立刻粘到上面的 Secret 里。

同一个页面确认 **Authorization callback URL** 正好是
`https://nefelibata857.github.io/resume-autofill/`（**结尾的斜杠必须有**）。

## 部署（Node 版，备用）

```bash
npm i express
GH_CLIENT_ID=Ov23li7TDJXKaxFNgIxd GH_CLIENT_SECRET=xxx PORT=3000 node server.js
# 健康检查：curl http://localhost:3000/  →  {"ok":true}
```

前端 `GH_API` 填 `https://你的域名/token`。

## 接口

```
POST /token
Content-Type: application/json
Origin: https://nefelibata857.github.io

{ "code": "GitHub 回调带回来的一次性授权码" }
```

成功 `200`：

```json
{ "login": "Nefelibata857", "name": "王勇超", "at": 1730000000000 }
```

失败（举例）`502`：

```json
{ "error": "exchange_failed",
  "description": "The code passed is incorrect or expired.",
  "hint": "授权码只能用一次、10 分钟内有效" }
```

其他：`405` 非 POST、`403` Origin 不在白名单、`400` code 格式不对。

## 安全边界

- client_secret 只存在于服务端（Worker 的 Secret 里），不下发、不进日志；
- GitHub access_token 只在服务端内存中出现一次，用完即弃，不落库、不返回；
- 只向浏览器返回用户名；
- CORS 白名单锁死为 `https://nefelibata857.github.io`；
- 授权码只允许 `[A-Za-z0-9_-]{10,80}`，且本来就是一次性的。

> 说明：这只是一个「确认对方是 GitHub 真人用户」的门槛，不是严格鉴权——
> 任何人只要有个 GitHub 账号都能过。它的作用是提高批量抓取的成本，不是防专业攻击者。
