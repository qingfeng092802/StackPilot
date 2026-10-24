# 安全部署指南（Zeabur / Render）

> 一句话：**凭据只从环境变量读，永远不进仓库、不进产物、不进日志。**
> 本文写给"要自己点完一整套流程"的人，每一步都可以照着做。

---

## 0. 这次迁移在修什么

| | 旧做法（WorkBuddy 沙箱） | 新做法（Zeabur / Render） |
|---|---|---|
| 凭据来源 | `boot.js` 里写死 `ANTHROPIC_API_KEY=sk-...` | `process.env.ANTHROPIC_API_KEY` |
| 凭据是否随产物上传 | **是**（产物 = 公网链接背后的代码） | **否**（平台在运行时注入） |
| 泄露后果 | 拿到产物 = 拿到 key = 直接盗刷 | 拿到产物只有代码，没有凭据 |
| 换 key 要做什么 | 改代码 → 重新打包 → 重新上传 | 在平台面板改一个值 → 重启 |
| 路径 | 网关把所有路径压成 `/`，被迫单路径折叠 | 正常透传，多路径直接可用 |
| 空闲 | 10–15 分钟自动停止，HTTP 唤不醒 | 可配不休眠 |

还有一件**必须现在就做**的事：

> ⚠️ **去模型后台轮换掉旧 key。**
> 它曾经以明文形式存在于沙箱产物里（`deploy/boot.js`），并随产物上传过。
> 本地已经删干净了（`deploy/` 目录整个移除），但**已经上传出去的东西删不回来**。
> 轮换一次，成本一分钟；不轮换，就是一个永远开着的口子。

---

## 1. 三条红线

### ① key 不进仓库

- `.gitignore` 已包含 `.env`、`.env.local`、`.env.*.local`
- 仓库里只有 `.env.example`，里面是 `sk-替换成你自己的`
- 提交前自查：`git ls-files | grep -i env` —— 只应该看到 `.env.example`

### ② key 不进产物

`scripts/build.mjs` 里有一段**构建期扫描**：打包完成后读一遍产物，
命中 `sk-xxxxx` 或 `api_key = "长字符串"` 就**直接让构建失败**，并打印打码后的命中内容。

这条不是"顺手加的检查"，它把口头承诺变成了机器强制：
哪天有人为了图省事把 key 写成默认值，构建会当场红，而不是等链接被人扒。

### ③ key 不进日志

启动时只打**后 4 位**和长度，用来确认"加载的是我粘的那把"：

```
  key   已加载（…6605，长度 35）
  端点  https://api.deepseek.com/anthropic
  模型  deepseek-flash
```

后 4 位不足以复原 key，但足以让你一眼看出"是不是粘错了"。

---

## 2. 代码侧已经做了什么

### 2.1 缺变量直接退出，不降级

`server/index.ts` 的 `assertEnv()`：启动第一件事就检查 `ANTHROPIC_API_KEY`，缺了就 `exit(1)`。

```
  ✗ 启动失败：缺少环境变量 ANTHROPIC_API_KEY

    本地：在项目根放 .env.local（不要提交），然后
          node --env-file=.env.local build/server.js
    线上：在平台的环境变量面板里配置，不要写进代码或仓库
```

**为什么不做"没 key 就用模板兜底"**：解释层本来有这个兜底，本地开发时很方便。
但带上线就变成——配置错了却看不出来，用户看到干巴巴的模板句子，你以为模型在跑。
更危险的是它诱导出一种"为了没 key 也能跑，不如把 key 写进默认值"的滑坡。
宁可起不来。

### 2.2 路径按模块位置算，不按 cwd 算

```ts
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = resolve(PROJECT_ROOT, 'web');
```

原来写的是 `resolve(process.cwd(), 'web')`。本地跑没问题，但 PaaS 的启动方式不保证 cwd 是项目根，
那时 `web/` 会 404，而日志里一个错都没有。
改成按**本文件位置**算之后：源码态是 `<root>/server/index.ts`，打包后是 `<root>/build/server.js`，
两种都往上一层就是根——所以 `build/` 里**不需要复制** `web/` 和 `tests/`。

### 2.3 产物只有一个文件

```
build/server.js    143 KB   ← 只有这个
```

`web/` 和 `tests/fixtures/` 直接用根目录那份，不再复制第二份。
少一份副本，就少一处"改了 A 忘了改 B"。

---

## 3. 本地先跑通（不要跳过这一步）

```bash
npm install                    # 只会装 esbuild 一个 devDependency
cp .env.example .env.local     # 然后把 ANTHROPIC_API_KEY 换成真实值
npm run dev                    # 先 build，再启动
```

打开 `http://localhost:8787`，确认三件事：

1. 页面能打开，输入框能打字
2. 点「开始选型」→ 出现追问卡片（说明解析层调通了）
3. 答完 → 出现方案（说明解释层调通了）

### ⚠️ 一个已经踩过的坑：`--env-file` 不覆盖已有变量

Node 的 `node --env-file=.env.local` 在变量**已存在**时**不覆盖**（和 dotenv 默认行为一样）。
而你的 shell 里很可能已经有别的 `ANTHROPIC_API_KEY`（别的工具、别的项目设的）。

表现是：`.env.local` 改对了，代码没动，接口却一直返回 `401 凭据无效`，
启动日志、配置文件、代码看起来全对——极难查。**实测踩过一次。**

所以本地统一用 `npm run dev`（它走 `scripts/dev.mjs`，**强制覆盖**同名变量）。
`npm run dev` 的启动日志里会先打一行 `已从 .env.local 载入 N 个变量（覆盖同名环境变量）`。

---

## 4. 推到 GitHub

平台都从 Git 仓库拉代码，所以先有仓库。

```bash
git init
git add -A
git commit -m "StackPilot: 环境变量隔离 + 单文件构建"
git branch -M main
git remote add origin git@github.com:<你的账号>/stackpilot.git
git push -u origin main
```

提交前跑一次自查，**这一行比什么都重要**：

```bash
git ls-files | grep -i env
# 期望输出只有：.env.example
# 如果看到 .env.local → 立刻 git rm --cached .env.local，并且换 key
```

---

## 5. 选哪个平台

| | Zeabur | Render | Railway |
|---|---|---|---|
| 国内访问 | 相对好（有香港/新加坡节点可选） | 一般 | 一般 |
| 免费额度 | 有试用，长期需付费 | 有免费实例 | 有试用额度 |
| **自动休眠** | 可配不休眠 | **免费实例会休眠**（15 分钟无流量） | 可配 |
| 支付方式 | 支付宝 / 微信 | 需要国际信用卡 | 需要国际信用卡 |
| 上手难度 | 低（中文界面） | 低 | 中 |

**推荐 Zeabur**，理由只有两条：国内访问相对稳、能用支付宝。
如果你有国际信用卡，Render 也可以，但**必须选不休眠的实例**——
免费实例休眠和之前那个沙箱是同一个坑：用户点开链接看到的是"正在唤醒"，第一印象直接毁掉。

> 无论选哪个，判据都是三条：**能注入环境变量 / 不休眠 / 国内能打开。**
> 少一条就换下一个。

---

## 6. Zeabur 部署步骤

1. 打开 <https://zeabur.com>，用 GitHub 账号登录。
2. **Create Project** → 选一个区域（有香港/新加坡就选近的）。
3. 项目里点 **Add Service** → **Git** → 授权并选中你的 `stackpilot` 仓库。
4. 平台会自动识别为 Node 项目。如果它让你填命令，按下面填：

   | 字段 | 值 |
   |---|---|
   | Build Command | `npm install && npm run build` |
   | Start Command | `npm start` |

5. 打开服务的 **Variables（环境变量）** 面板，逐条添加（值不要加引号）：

   ```
   ANTHROPIC_BASE_URL = https://api.deepseek.com/anthropic
   ANTHROPIC_API_KEY  = sk-你的真实key
   ANTHROPIC_MODEL    = deepseek-flash
   ```

6. **Networking** → **Generate Domain**，拿到一个 `https://xxx.zeabur.app` 的地址。
7. 打开那个地址，按 §8 验证。

> 如果构建报 "esbuild: not found"，把 Build Command 改成
> `npm install --include=dev && npm run build`（有些平台在构建期会跳过 devDependencies）。

---

## 7. Render 部署步骤

1. 打开 <https://render.com>，用 GitHub 登录。
2. **New +** → **Web Service** → 选你的 `stackpilot` 仓库。
3. 填表：

   | 字段 | 值 |
   |---|---|
   | Language / Runtime | `Node` |
   | Build Command | `npm install && npm run build` |
   | Start Command | `npm start` |
   | Instance Type | **不要选 Free**（会休眠） |

4. 往下拉到 **Environment Variables**，加三条（同 §6 第 5 步）。
5. **Create Web Service**，等构建完成，页面上方会给出 `https://xxx.onrender.com`。
6. 打开它，按 §8 验证。

---

## 8. 环境变量清单

| 变量 | 必填 | 示例 | 说明 |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **是** | `sk-...` | 缺了服务直接退出 |
| `ANTHROPIC_BASE_URL` | 否 | `https://api.deepseek.com/anthropic` | 不填走 `https://api.anthropic.com` |
| `ANTHROPIC_MODEL` | 否 | `deepseek-flash` | 不填用端点默认模型 |
| `PORT` | 平台自动注入 | `3000` | 服务读 `process.env.PORT`，不用手动填 |
| `SP_SINGLE_PATH` | 否 | `1` | **只有网关会改写路径时才设**。正常平台不要设 |
| `M3_MODULE_STAGGER_MS` | 否 | `180` | 模块之间的下发间隔，调试用 |

`SP_SINGLE_PATH=1` 会把应用折叠成 `GET /` + `POST /`（CSS/JS 内联、接口按 `body.action` 分发）。
它是为"网关吃掉路径"那种平台准备的。Zeabur / Render 不需要，设了反而丢掉静态资源缓存。

---

## 9. 上线后验证（三条命令）

把 `<URL>` 换成平台给的地址。

```bash
# ① 首页
curl -s -o /dev/null -w "%{http_code} %{size_download}B\n" <URL>/
# 期望：200 3608B

# ② 解析层（真调模型）
curl -s -X POST <URL>/api/intake -H 'content-type: application/json' \
  -d '{"raw_input":"想做个网页，打开就能随机听世界各地电台，收藏只存浏览器里，不要账号，也不要广告"}'
# 期望：{"ok":true,...,"required_capabilities":["no_persistence"],"dropped":[]}

# ③ 解释层（SSE，应逐块到达而不是一次性）
curl -s -N -X POST <URL>/api/plan -H 'content-type: application/json' \
  -d '{"raw_input":"听电台","vector":{"delivery":"web","team_size":"1","skills":{"js":0.8},"required_capabilities":["no_persistence"],"goal_type":"product"}}'
# 期望：event: meta → 若干 event: progress → 5×event: module → event: done（source:"llm"）
```

第 ② 条如果返回 `ok:false` 且 `failure.detail` 里有 `401`，去看平台日志的第一屏——
启动时那三行会告诉你**加载的是哪个 key（后 4 位）和哪个端点**。

### 反向验证：缺 key 应该起不来

这是安全设计的一部分，值得亲眼看一次。在平台面板里临时删掉 `ANTHROPIC_API_KEY` 再重启：

- 期望：启动失败，日志里有 `✗ 启动失败：缺少环境变量 ANTHROPIC_API_KEY`
- 期望**不是**：服务正常起来、页面能开、只是文案变成模板

看到后者说明跑的是旧代码（`build/` 没重新构建）。

---

## 10. 常见故障对照表

| 现象 | 原因 | 处置 |
|---|---|---|
| 部署成功但打不开 / 502 | 服务绑了 127.0.0.1 | 已默认 `0.0.0.0`；确认没手动覆盖 `HOST` |
| 启动即退出，日志有 `✗ 启动失败` | 缺 `ANTHROPIC_API_KEY` | 在平台面板补上 |
| `401 凭据无效或过期` | key 错 / 过期 / 环境变量没生效 | 看启动日志的 `…后四位`；本地注意 `--env-file` 不覆盖的坑 |
| 页面 404，但 `/api/*` 正常 | `web/` 没找到 | 确认 `web/` 在仓库里（不是 gitignore）；确认构建产物在 `build/` |
| 改了代码线上没变 | 忘了构建 | `build/` 在 `.gitignore` 里，**平台的 Build Command 必须包含 `npm run build`** |
| 所有路径都返回首页 | 网关改写了路径 | 设 `SP_SINGLE_PATH=1` 重启 |
| 首屏要等 5–10 秒 | 冷启动 | 选不休眠实例；或上线后自己先打开一次预热 |
| 页面能开，点「开始选型」没反应 | 前端 JS 没跑 | 打开控制台看报错；确认产物与 `web/app.js` 是同一版本 |

---

## 11. 附录 A：如果必须继续用"不能注入环境变量"的旧沙箱

那就别把真 key 放进去，放一个**可撤销的令牌**，让它穿过你本机的网关。

```
线上 app ──x-api-key: <令牌>──▶ 本机网关 ──x-api-key: <真 key>──▶ 模型端点
            （产物里只有这个）        （真 key 只在内存里）
```

### 起网关

```bash
# 终端 A
export UPSTREAM_API_KEY='真实的 key'
export GATEWAY_TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
node scripts/local-gateway.mjs          # 默认 127.0.0.1:8799

# 终端 B：把网关暴露到公网
ngrok http 8799
```

### 线上配置

```
ANTHROPIC_BASE_URL = https://<ngrok 给的域名>
ANTHROPIC_API_KEY  = <GATEWAY_TOKEN 的值>     ← 注意这不是真 key
```

### 它挡住了什么、挡不住什么

| | 说明 |
|---|---|
| ✅ 挡住了 | 产物泄露 ≠ key 泄露。拿到的是令牌 |
| ✅ 挡住了 | 换令牌只改一个环境变量，不用去模型后台轮换 |
| ✅ 有了 | 每一次调用都在你本机日志里，带来源 IP 和耗时 |
| ⚠️ 挡不住 | 令牌在产物里，**谁拿到产物谁就能用你的额度**（已加 30 次/分钟/IP 限流） |
| ⚠️ 挡不住 | 网关必须公网可达（ngrok），它本身就是一个入口 |
| ⚠️ 新风险 | 你电脑关机 / ngrok 断线 → 线上立刻不可用 |

**结论：这是应急方案，不是目标状态。** 能用真平台注入环境变量，就别用这个。

---

## 12. 上线前安全清单

- [ ] 旧 key 已在模型后台**轮换**（它进过沙箱产物）
- [ ] `git ls-files | grep -i env` 只有 `.env.example`
- [ ] `npm run build` 通过（说明产物里没有 key）
- [ ] 平台环境变量面板有 `ANTHROPIC_API_KEY`，且不是粘贴在代码里
- [ ] 删掉 `ANTHROPIC_API_KEY` 后重启，服务**起不来**（证明检查生效）
- [ ] 线上日志里搜 `sk-`，**搜不到**
- [ ] 实例**不休眠**
- [ ] §9 的三条 curl 全部符合预期
