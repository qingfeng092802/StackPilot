# StackPilot

> 在 Cursor / Claude Code 里说一句「我想做个 XX」，它给你**一套技术架构**和**一段可以直接粘回对话的启动指令**。

一个跑在本地的 MCP Server。目标用户是**用 AI 写代码的人**——你不需要会 JS 或 Python，
你只需要一个「AI 最容易一次写对」的架构。

```
你：用 stackpilot 帮我选个架构：我想做个记账的网页，就我自己用，要能登录
它：（返回 Top1 方案 + 为什么不选别的 + 一段粘回去就能开工的 Prompt）
```

---

## 它解决什么问题

让 AI 帮你写代码时，第一道坎不是写，是**选**。

问 ChatGPT「我该用什么技术栈」，你会得到一个听起来都对、但**每次都不一样**的答案：
它可能推荐 Next.js + Supabase，也可能推荐 SvelteKit + SQLite，还会顺手编一个
你根本没提过的 Redis 缓存。你无法判断哪个更好，也没法复现上一次的结论。

StackPilot 换了个做法：**不让模型自由发挥。**

| | 直接问 LLM | StackPilot |
|---|---|---|
| 结论来源 | 模型当场生成 | **12 套预定义架构里算出来的** |
| 同一问题问两次 | 可能不一样 | **必然一样**（纯函数，无随机） |
| 为什么是这套 | 「它更现代」 | **可核对的分数 + 落选方案的对比** |
| 会不会编 | 会（编组件、编坑） | **三层校验拦截，不过就退回模板** |
| 能不能测试 | 不能 | **193 条断言，四套回归** |

模型只负责把理由说成人话。**选哪套、装什么、第一步做什么，全部由确定性引擎算出。**

---

## 快速开始

### 1. 装

```bash
git clone https://github.com/qingfeng092802/StackPilot.git
cd StackPilot
npm install && npm run build
```

产出 `build/mcp.js` 一个文件，没有别的服务要起。

### 2. 配

**Cursor** — `~/.cursor/mcp.json`（或项目内 `.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "stackpilot": {
      "command": "node",
      "args": ["/绝对路径/StackPilot/build/mcp.js"]
    }
  }
}
```

**Claude Desktop** — `claude_desktop_config.json`
（Windows `%APPDATA%\Claude\`，macOS `~/Library/Application Support/Claude/`）：

```json
{
  "mcpServers": {
    "stackpilot": {
      "command": "node",
      "args": ["/绝对路径/StackPilot/build/mcp.js"],
      "env": { "ANTHROPIC_API_KEY": "" }
    }
  }
}
```

**Claude Code**：

```bash
claude mcp add stackpilot -- node /绝对路径/StackPilot/build/mcp.js
```

配完重启编辑器（Cursor：`Cmd/Ctrl+Shift+P` → `Reload Window`）。

### 3. 用

在对话里直接说，不用记工具名：

> 用 stackpilot 帮我选个架构：我想做个记账的小程序，大概 10 个人用

> stackpilot 推荐一下，我不会写代码，想让 Cursor 帮我写

**你要的是返回结果里最后那块「给 AI 的启动指令」**——整段复制，粘回对话，AI 就照着开工。

> **不配 API Key 也能用。** 没配时走关键词规则解析 + 模板文案（免费、即时），
> 配了走模型解析（更准）。输出里会标明走的是哪条路。

---

## 它返回什么

````markdown
# 推荐：Next.js + Supabase 全栈托管

> 置信度 **medium**　·　分数 4.88　·　候选 11 套

## 技术栈
- **前端**：Next.js —— 前端框架（含服务端渲染能力）
- **接口层**：Supabase —— 托管后端（登录 / 数据库 / 存储）
- **数据库**：PostgreSQL —— 关系型数据库
- **部署**：Vercel —— 托管部署

## 为什么不选其他
| 方案 | 为什么没选 | 什么时候值得回头看 |
|---|---|---|
| Next.js 纯前端 + Edge Functions | 分数 4.62，低于 Top2 | 当你确实需要登录或多用户共享数据时 |
| Nuxt + Supabase | 分数 3.78，低于 Top2 | 当你能找到足够多的中文教程时 |

引擎侧的分数（可核对）：C01 4.88 > C12 4.62 > C11 4.62 > C05 3.78

## 给 AI 的启动指令
```text
你在帮我搭一个项目。技术选型已经定了，请不要替换成别的框架。

## 技术栈（Next.js + Supabase 全栈托管）
- 前端：Next.js ……

## 第一步：只做这一件事，做完停下来告诉我
打开 supabase.com，用 GitHub 登录建一个 project，把 Project URL 和 anon key 抄到记事本

## 写的时候特别注意这几个坑
1. Supabase 国内访问不稳定，第一次连不上会误以为是自己代码错了
2. 把 service_role key 写进前端环境变量，会泄露全部数据权限
3. RLS 没开就上线，任何人都能读到别人的数据

## 协作方式
- 一次只做一步，改完告诉我改了哪些文件、为什么这么改。
- 遇到需要我提供 key、账号、域名的地方，先停下来问我，不要自己编一个。
```
````

注意最后那段「启动指令」**不是模型写的**，是模板填出来的。
原因：它必须只包含这套架构里真实存在的组件。让模型自由生成，它很容易顺手写出
「再配个 Redis 缓存」——而 Redis 可能根本不在这套组合里，用户会照着它装一堆不该装的东西。

---

## 工作原理

```
自然语言
   │
   ├─ ① 解析层 ── 抽取约束（交付形态 / AI 参与方式 / 需要的能力…）
   │              每个字段都必须能指回原文的**逐字片段**，指不回就丢掉
   │
   ├─ ② 打分引擎 ─ 12 套组合 × 5 维加权 × 匹配度乘数
   │              硬约束过滤 → 加权排序 → 强制 Top1/Top2 不同范式
   │
   └─ ③ 解释层 ── 模型写「为什么」，过三道校验；不过就退回模板
                  另外并行生成一段给 AI 的启动指令（模板，确定性）
```

**12 套组合**覆盖 5 种架构范式：全栈自建 / 前后端分离 / BaaS 托管 / 小程序多端 / 纯静态零后端。
每套都带自己的组件清单、基准分、匹配规则、新手坑、以及「什么情况下该换掉它」。

**三层防幻觉**：

1. **闭集约束**——组合 ID 必须在 12 套里，解释里提到的技术必须来自这套组合
2. **Evidence 逐字溯源**——解析出的每个字段都要能在原文里找到连续片段
3. **极性校验**——用户说「只存浏览器里」不能被读成「需要数据库」

任一层不过，就退回模板文案。**宁可说套话，不说假话。**

---

## 测试

```bash
npm test              # 四套回归，193 条断言
npm run mcp:smoke     # 真起子进程走 JSON-RPC，调两个工具
```

| 套件 | 断言数 | 管什么 |
|---|---|---|
| `check-consistency` | 86 | 数据一致性、权重表、规则方向、防回退 |
| `test-intake` | 54 | 解析层：evidence 溯源、极性、字段名对不上 |
| `test-guards` | 26 | 解释层闸门：照抄、编造数字、越界组合 |
| `test-view-model` | 27 | 渲染层：三态、分组顺序、推断依据透出 |

`mcp:smoke` 不是 import 一下直接调函数——它真的 spawn 子进程、发 JSON-RPC。
因为有三件事只有真客户端能测出来：stdio 上有没有多余输出把协议弄坏、
schema 客户端能不能解析、打包产物本身能不能跑。

---

## 设计决策

这个项目留下了一批决策记录，比代码本身更能说明问题：

- [`docs/ADR-002-vibe-coding-pivot.md`](docs/ADR-002-vibe-coding-pivot.md) —— 为什么把目标用户从「自己写代码的人」改成「用 Cursor 写代码的人」，以及**实测发现「只删掉旧字段，产品行为完全不变」**的过程
- [`docs/ADR-001-m0-verdict.md`](docs/ADR-001-m0-verdict.md) —— 10 条真实案例的基线、真实产出率 29.6%、以及为什么先验证输出侧而不是先做功能
- [`docs/F1-natural-language-intake.md`](docs/F1-natural-language-intake.md) —— 解析层：三道闸、`dropped` 机制、以及一个「语义极性读反」bug 的完整复盘
- [`docs/M1-LLM-explanation-layer.md`](docs/M1-LLM-explanation-layer.md) —— 解释层：为什么宁可退回模板也不让模型自由发挥
- [`docs/M3-frontend-rendering.md`](docs/M3-frontend-rendering.md) —— 为什么 SSE 按模块边界分块，而不是按 token

---

## 已知限制

写在前面，省得你踩了以为是 bug：

1. **只有 12 套组合。** 超出范围（桌面端、复杂 CLI）会直接说「覆盖不了」，不给勉强方案。这是设计，不是缺陷。
2. **`ai_friendliness` 的 12 个权重是人工判断，不是实测。** 判断依据写在 `src/data/combos.json` 的 `ai_friendliness_note` 里（单语言全栈优先、语料丰富度、报错可定位性），但**尚未用真实 AI 生成结果校准**。这是当前最虚的一块。
3. **没有 Key 时解析较粗。** 关键词规则读不出「十来个用户」这类中文数量，这些字段会留空并按默认值处理，输出里会标出来。
4. **MCP 只在官方 SDK 客户端验证过**（子进程 + JSON-RPC 端到端），未在真实 Cursor 里跑过完整交互。
5. **无 prompt 注入防护。** 用户可以在输入里写「忽略以上指令」，解析层可能照做——evidence 闸拦不住，因为注入话术本身就在原文里。

---

## 仓库结构

```
src/lib/
  scoring.ts            选型内核：能力匹配、5 维加权、匹配度乘数、排序
  confidence.ts         置信度三态 + 从原文推断隐性约束
  intake/               解析层：prompt / 三道闸 / 追问模板
  explain/              解释层：prompt / 三道校验 / 模板兜底 / 启动指令生成
  facts/                事实层：给解释层提供「能说的真话」
src/data/
  combos.json           12 套组合的全部知识（组件、基准分、规则、坑）
mcp/                    MCP Server：stdio + 两个工具 + Markdown 渲染
server/ + web/          Web 调试台（改渲染逻辑时比走 MCP 快）
scripts/                构建、测试、评测、探针
tests/                  D1 真实案例集（10 条）+ 候选池（60 条）
docs/                   决策记录与设计文档
PRD-StackPilot-v1.7.0-定稿.md   产品规格（定位 / 数据模型 / 打分 / 三阶段链路）
```

---

## 数据来源

`tests/d1-holdout.json` 里的 10 条案例来自 V2EX 的公开帖子，
**已改写为第一人称的需求描述，并剥离了原帖 ID 与链接**，只保留需求语义与人工标注的
ground truth（真实用了什么栈）。它们的用途是回归基线：改任何规则，先跑一遍确认 Top1 没漂。

`tests/d1-candidates.json` 是 60 条候选帖的分类池（交付形态 / 是否产品），只保留标题与分类。

---

## License

MIT
