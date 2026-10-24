# StackPilot MCP

> 在 Cursor / Claude Code 里问一句"我该用什么技术栈"，它给你**一套架构 + 一段能直接粘给 AI 的启动指令**。

## 一分钟快速上手

### 第 1 步 · 装（约 30 秒）

```bash
git clone <你的仓库地址> stackpilot
cd stackpilot
npm install && npm run build
```

装完会生成 `build/mcp.js` —— 就这一个文件，没有别的服务要起。

### 第 2 步 · 配（约 20 秒）

**Cursor**：编辑 `~/.cursor/mcp.json`（全局）或项目里的 `.cursor/mcp.json`，把下面整段贴进去（路径换成你自己的）：

```json
{
  "mcpServers": {
    "stackpilot": {
      "command": "node",
      "args": ["D:/StackPilot/build/mcp.js"]
    }
  }
}
```

**Claude Desktop**：编辑 `claude_desktop_config.json`
（Windows 在 `%APPDATA%\Claude\`，macOS 在 `~/Library/Application Support/Claude/`）：

```json
{
  "mcpServers": {
    "stackpilot": {
      "command": "node",
      "args": ["D:/StackPilot/build/mcp.js"],
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        "ANTHROPIC_API_KEY": "你的 key（可选，不填也能用）",
        "ANTHROPIC_MODEL": "deepseek-flash"
      }
    }
  }
}
```

**Claude Code**：一行命令，不用手改 JSON。

```bash
claude mcp add stackpilot -- node D:/StackPilot/build/mcp.js
```

配完**重启编辑器**（Cursor 里是 `Cmd/Ctrl+Shift+P` → `Reload Window`）。

### 第 3 步 · 用（约 10 秒）

在对话里直接说，不用记工具名：

> **用 stackpilot 帮我选个架构**：我想做个记账的小程序，大概 10 个人用，我自己一个人做

> **stackpilot 推荐一下**：我不会写代码，想让 Cursor 帮我写，做什么合适？

> **用 stackpilot 的 C11 给我生成启动 Prompt**，需求是做个随机听电台的网页

它会返回一段 Markdown。**你要的东西是最后那块「给 AI 的启动指令」**——
把它整段复制，粘回同一个对话（或新开一个），AI 就会照着那套架构开始搭。

> 💡 **不用配 key 也能用。** 没配 `ANTHROPIC_API_KEY` 时它走关键词规则解析 + 模板文案，
> 免费、即时，输出里会标明走的是哪条路。配了 key 会换成模型解析，更准。

---

把一句大白话变成**技术选型 + 一段可以直接粘给 AI 的启动 Prompt**。

给谁用：用 Cursor / Claude Code / Qoder 写代码、但不想自己纠结"该用什么技术栈"的人。
你只要说"我想做个 XX"，它给你一套架构，再给你一段能直接丢给 AI 的指令。

底层是一个**闭集**：12 套真实组合（C01–C12）+ 一张人工打分的维度表。
它不是让模型自由发挥——模型只负责"把理由说成人话"，**选哪套、装什么、第一步做什么，
全部由确定性的引擎算出来**。这样同一句需求永远得到同一个答案。

> **形态说明**：MCP 是主形态。仓库里的 Web 页面（`npm run dev`）保留为**调试台**，
> 改渲染逻辑时用它比走 MCP 快得多，但它不再是用户入口。
> 为什么这么定，见 `docs/ADR-002-vibe-coding-pivot.md`。

---

## 一、接入（三种方式，按可用性排序）

### 方式 A：本地路径（现在就能用）

先把仓库 clone 下来并构建：

```bash
git clone <你的仓库地址> stackpilot
cd stackpilot
npm install
npm run build        # 产出 build/mcp.js
```

**Claude Desktop** — 编辑 `claude_desktop_config.json`：

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "stackpilot": {
      "command": "node",
      "args": ["D:/StackPilot/build/mcp.js"],
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        "ANTHROPIC_API_KEY": "你的 key（可选，不填也能用）",
        "ANTHROPIC_MODEL": "deepseek-flash"
      }
    }
  }
}
```

**Cursor** — 编辑 `~/.cursor/mcp.json`（全局）或项目里的 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "stackpilot": {
      "command": "node",
      "args": ["D:/StackPilot/build/mcp.js"]
    }
  }
}
```

**Claude Code** — 一行命令：

```bash
claude mcp add stackpilot -- node D:/StackPilot/build/mcp.js
```

### 方式 B：`npx`（需要先发布到 npm）

```bash
npx stackpilot-mcp
```

对应的配置写法：

```json
{
  "mcpServers": {
    "stackpilot": { "command": "npx", "args": ["-y", "stackpilot-mcp"] }
  }
}
```

> ⚠️ **这一步现在还不能用。** `npx stackpilot-mcp` 只有在包被发布到 npm 之后才生效，
> 而发布需要你自己的 npm 账号（`npm login && npm publish`）。仓库里已经配好了
> `bin` / `files` / `version`，发布后即可直接用。没发布之前请用方式 A。

### 方式 C：不接 MCP，直接问

Web 调试台还留着（它现在只是调试用，不是主入口）：

```bash
npm run dev          # 打开 http://localhost:8787
```

---

## 二、两个工具

### `recommend_stack`

根据自然语言需求推荐架构，并给出启动 Prompt。

| 参数 | 类型 | 说明 |
|---|---|---|
| `raw_input` | string | 用户的自然语言需求，**尽量保留原话**（原话里的语气词也是信息） |

返回一段 Markdown，包含：

1. **推荐**：Top1 方案名、置信度、分数
2. **为什么是这套**
3. **技术栈**：前端 / 接口层 / 数据库 / AI / 部署，逐项列出
4. **为什么不选其他**：落选方案 + 什么时候值得回头看 + 引擎侧分数（可核对）
5. **给 AI 的启动指令**：一整段可以直接复制粘贴的 Prompt
6. **接下来三步**
7. **输入解读**：读到了什么（附原文依据）、哪些用了默认值

### `get_detailed_prompt`

已经知道要用哪套时，只取启动 Prompt，不重新选型。

| 参数 | 类型 | 说明 |
|---|---|---|
| `combo_id` | string | 组合 ID，如 `C01` / `C11` / `C12` |
| `user_requirements` | string | 你的需求，会被原样写进 Prompt |

---

## 三、没有 API key 也能用

这是刻意的设计：MCP 的用户大多没配模型 key，如果没 key 就不可用，等于没人会用。

| | 有 `ANTHROPIC_API_KEY` | 没有 key |
|---|---|---|
| 需求解析 | 模型抽取 + evidence 逐字校验 | 关键词规则 |
| 解释文案 | 模型生成 + 三道校验，不过就退回模板 | 模板兜底 |
| 启动 Prompt | **始终**由模板确定性生成 | 同左 |
| 成本 | 一次约 2 次模型调用 | 0 |
| 输出里的标记 | 无 | 顶部会写"用的是关键词规则" |

**启动 Prompt 永远不交给模型写。** 原因：它必须只包含组合里真实存在的组件。
让模型自由生成，它很容易顺手写出"再配个 Redis 缓存"——而那可能根本不在这套组合里。
用户会照着它让 AI 装一堆不该装的东西。所以这一段是模板填充，确定性、可测试。

关键词规则层**故意保守**：只认"写出来就一定是这个意思"的词，读不出就留空，
并在「输入解读」里明确写出"用了默认值"。

---

## 四、环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 否 | 不填走规则解析 + 模板兜底 |
| `ANTHROPIC_BASE_URL` | 否 | 默认 `https://api.anthropic.com`；DeepSeek 用 `https://api.deepseek.com/anthropic` |
| `ANTHROPIC_MODEL` | 否 | 默认 `deepseek-flash` |

> MCP Server 通过 **stdio** 通信。**任何写到 stdout 的内容都会破坏协议**，
> 所以本项目的日志一律走 stderr（`[stackpilot] ...`）。如果你自己改代码，
> 千万别在里面 `console.log`——客户端只会说"连接失败"，不会告诉你原因。

---

## 五、开发与测试

```bash
npm run build        # 打包 build/server.js（Web）与 build/mcp.js（MCP）
npm test             # 四套回归：一致性 / 闸门 / view-model / 解析层
npm run mcp:smoke    # 真起一个 MCP 客户端子进程，走 JSON-RPC 调两个工具
```

`mcp:smoke` 不是"import 一下直接调函数"，它真的 spawn 子进程、发 JSON-RPC。
因为有三件事只有真客户端能测出来：stdio 上有没有多余输出、schema 客户端能不能解析、
打包产物本身能不能跑。

---

## 六、已知限制

1. **只有 12 套组合。** 超出范围的形态（桌面端、纯 CLI 的复杂工具）会直接说"覆盖不了"，
   不给勉强方案。这是设计，不是缺陷。
2. **没有 key 时解析较粗。** 关键词规则读不出"十来个用户""两个月内"这类中文数量，
   这些字段会留空并按默认值处理，输出里会标出来。
3. **`ai_friendliness` 的 12 个数字是判断不是实测。** 与 `beginner_pitfalls` 同属 opinion，
   需要用真实的 AI 生成结果校准。详见 `docs/vibe-coding-pivot.md`。
4. **无 key 模式下"为什么不选其他"的措辞偏生硬。** 那是 M1 的模板兜底文案
   （"等你不再处于「…」这种情况时，再回来看它"），语义正确但读着拗口。
   配了 key 走模型就不会这样。

---

## 七、许可

MIT
