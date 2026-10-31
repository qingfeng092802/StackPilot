<!-- README_SYNC: source=working-tree@1ae6ff7; updated=2026-10-31 -->

<p align="center">
  简体中文 · <a href="./README_EN.md">English</a>
</p>

# StackPilot MCP

> 面向用 Cursor / Claude Code 写代码的人：一句大白话 → **一套可核对的架构选型 + 可直接运行的骨架 + 自动落盘的项目规则**。选型、组件、版本全部来自闭集与实测数据，同一句话永远同一个答案。

<p align="center">
  <a href="https://github.com/qingfeng092802/StackPilot/stargazers"><img src="https://img.shields.io/github/stars/qingfeng092802/StackPilot?style=flat&color=yellow" alt="Stars"></a>
  <a href="https://github.com/qingfeng092802/StackPilot/releases/tag/v3.0.0"><img src="https://img.shields.io/badge/version-3.0.0-blue" alt="Version 3.0.0"></a>
  <a href="https://github.com/qingfeng092802/StackPilot/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/qingfeng092802/StackPilot/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/qingfeng092802/StackPilot/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520.11-brightgreen" alt="Node >= 20.11">
  <a href="https://github.com/qingfeng092802/StackPilot/issues"><img src="https://img.shields.io/github/issues/qingfeng092802/StackPilot" alt="Issues"></a>
</p>

**如果它帮你省下了选型和踩坑的时间，点一个 [Star](https://github.com/qingfeng092802/StackPilot/stargazers) 方便收藏，也让更多被"AI 推荐架构"坑过的人能发现它。**

---

## 为什么需要它

直接问 AI"我该用什么技术栈"，它会自信地给你一套方案——然后你在真机上踩完所有的坑。我们用 12 套架构 × 3 轮真实跑批（AI 一次生成 → `npm install` → `npm run build`，2026-10-30，deepseek-flash）把这条路实测了一遍：

| 裸问 LLM 的实测结果 | StackPilot 的做法 |
|---|---|
| **39 轮中 36 轮（92%）完全没有部署工件**（vercel.json / wrangler.toml / docker-compose），剩余 3 轮也仅部分覆盖 | 骨架 100% 提供部署配置与 `.env.example`，版本号逐个溯源到事实快照 |
| AI 自选 `better-sqlite3`（原生编译模块），Windows 上 **3 轮 install 全部编译失败** | 数据层定死纯 JS 的 `@libsql/client`，换库对照实验中同组合成功率 **0% → 100%** |
| 用了 `openai` 却不写进 package.json，build 阶段 `Module not found` | 启动指令带实测提炼的「AI 生成纪律」，确定性模板保证清单与 import 一致 |
| 答案无法核对，换个问法就换方案 | 12 套闭集打分排序，每条结论附原文依据与可复算的分数 |

> 📊 完整数据：[eval 批次报告](docs/eval-batch-2026-10-30-flash-v1.md)（42 轮记录、失败分类、归因，全部可复算）。

## 五个工具

| 工具 | 一句话 |
|---|---|
| `recommend_stack` | 自然语言（或宿主模型传入的结构化约束）→ 闭集选型 + 启动 Prompt + 避坑预警；低置信度时返回追问协议而非硬猜 |
| `get_detailed_prompt` | 指定组合直接取启动指令 |
| `apply_stack_blueprint` | 架构契约幂等写入 `.cursor/rules/stackpilot.mdc` 与 `CLAUDE.md`，AI 打开项目自动遵守 |
| `scaffold_blueprint` | 生成可运行骨架：锁定版本的 package.json、目录结构、`.env.example`、部署配置（永不覆盖已有文件） |
| `inspect_project` | 只读反查存量项目：离哪套蓝图最近、缺了什么、多了什么（monorepo 明确拒绝） |
| `deep_architecture_review` | **复杂需求专属**（约 30 秒 + 额外费用，需配 key）：三视角盲评 → 红队挑刺 → 法官裁决；闭集外方案自动记为候选并给出带实测纪律的手动搭建指令。常规选型请用 `recommend_stack` |

三级解析路由，**没有 API key 也能用**：宿主结构化传入（零成本，首选）→ 内部 LLM → 离线关键词 + 中文数量规则。

## 快速开始

```bash
git clone https://github.com/qingfeng092802/StackPilot.git stackpilot
cd stackpilot
npm install && npm run build   # produces build/mcp.js (single file, zero runtime deps)
npm test                       # 10 regression suites, 452 assertions
npm run mcp:smoke              # real subprocess, JSON-RPC end to end
```

接入 Cursor（`~/.cursor/mcp.json`）：

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

Claude Code 一行：`claude mcp add stackpilot -- node D:/StackPilot/build/mcp.js`。

对话里说"用 stackpilot 帮我选个架构：我想做个记账的小程序，我自己一个人做，要能登录"即可。其他客户端两个要点：**Claude Desktop** 需在 `env` 里显式配置（可选配 DeepSeek key 走 LLM 路径）；**WorkBuddy** 必须把 `ANTHROPIC_API_KEY` 写成空串 `""`（其子进程会继承宿主凭据，不覆盖会 401），并在连接器管理里手动信任 stackpilot。完整示例见 [CHANGELOG 同版仓库历史](CHANGELOG.md) 或提 Issue 索取。

## 工程边界（说实话的部分）

- **闭集 12 套组合**：桌面端、复杂 CLI 超出范围会明确拒绝，不给勉强方案——这是设计而非缺陷；
- **确定性红线**：启动指令与架构契约 100% 模板生成，模型只负责约束提取与解释文案，且两者都要过本地证据闸门；
- **注入防御**：用户原文先过高置信注入检测（含 XML 边界逃逸），命中剥离并留痕；
- **无 key 降级**：关键词规则 + 中文数量映射，输出明确标注走了哪条路；
- **遥测默认关闭**：`SP_TELEMETRY=1` 才写本地匿名统计（无原文无路径），删除 `~/.stackpilot/usage.jsonl` 即撤回。

已知限制与历史决策全文见 [CHANGELOG](CHANGELOG.md) 与 [ROADMAP](docs/ROADMAP-v2.1.md)。

## License

[MIT](LICENSE) © StackPilot contributors

---

如果这个项目解决了你的实际问题，可以点一个 [Star](https://github.com/qingfeng092802/StackPilot/stargazers)，方便以后回来，也让更多有同样需求的人更容易发现它。问题和改进建议请直接提 [Issue](https://github.com/qingfeng092802/StackPilot/issues)。
