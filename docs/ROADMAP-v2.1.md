# ROADMAP v2.1：从「选型问答器」到「架构生命周期工具」

> 文档版本 v2.1.0 · 2026-10-30
> 组织主轴：**一份骨架资产，喂三个工具**。按"资产"分节，不按"工具"分节——
> scaffold（脚手架发布）/ eval（实测校准）/ inspect（反查基线）共享同一个单一事实源，
> 本文档把它们固化为一件事，后来人不再拆开。
>
> 两条不可协商的红线（任何条目都不得突破）：
> **① 启动 Prompt / 架构契约永远模板确定性生成；② 闭集兜底，不让模型自由发挥选型。**

---

## 第一节 · 单一事实源：骨架模板（P1 核心）

### 资产

**组件片段库（`src/data/scaffold-parts/`）+ 确定性拼装器（`src/lib/scaffold.ts`）**

- 片段按**组件 ID**（FE-01…DP-03，共 23 个）组织，不是按组合——23 个片段拼出 12 套，
  避免为每套组合手写一遍模板树。
- 每个片段声明：npm/pypi 依赖（**版本号从 `src/data/facts-snapshot.json` 取，锁定精确版本**）、
  目录结构、hello-world 入口文件、`.env.example` 行。
- facts 快照没有版本的组件（FE-05 原生小程序、DB-01/DB-02 数据库本体、AI-04 的 JS 侧），
  片段显式声明 `no_package: true` 或给部署配置文件，**不允许写一个没出处的版本号**。

### 消费它的三个工具

| 工具 | 用法 | 与骨架的关系 |
|---|---|---|
| `scaffold_blueprint` | combo_id + workspace_path（**必须为空目录或不存在，创建之**） | 把拼装结果落盘为可运行项目 |
| eval harness（`scripts/eval-scaffold.ts`） | AI 按启动 Prompt 生成 → 拼装预期基线对比 → build + 冒烟 | 骨架 = fixture 与期望基线 |
| `inspect_project` | 读存量项目依赖 → 对照拼装基线报偏离 | 骨架 = "正确形态"的期望值 |

### 验收断言

- 每套组合可拼装；package.json 可 JSON.parse；所有依赖版本能在 facts 快照中溯源（`test-scaffold.ts`）。
- 本地抽查真实可跑：C12（最简单）与 C01（最常用）执行 `npm install && npm run build` 通过。**【2026-10-30 实跑达成】C01 于 Windows（npmmirror 源）install 328 包 + next build 通过；C12 于 eval 管线中 AI 生成项目两轮 install+build 通过。实跑同时抓到并修复 scaffold 落盘的 Windows 路径 bug（dirname 而非 lastIndexOf('/')）。**
- 拼装器输出可复现：同一 combo 两次拼装逐字节一致（写入测试）。
- `scaffold_blueprint` 拒绝非空目录（防覆盖用户文件）；拒绝闭集外 combo_id。

---

## 第二节 · 信任地基：last_reviewed + eval 校准（P0 + P1）

### 资产 A：`last_reviewed` 时效元数据（P0-2）

- **独立字段，不从 `verified_at` 推导**：组合级审核日期与组件级事实快照日期语义不同——
  一个组件更新不该静默刷新整个组合的"最近复核于"标签。抄 `verified_at` 的**模式**，不抄**数据流**。
- combos.json 每套组合新增 `"last_reviewed": "YYYY-MM-DD"`，人工/审核流程更新。
- 消费工具：`check-consistency` 断言（字段存在、格式合法、距今 < 180 天）；
  `recommend_stack` / `get_detailed_prompt` / blueprint / scaffold 输出标注"最近复核于 YYYY-MM"。
- 验收断言：consistency 新增 3 条；渲染输出含标注（view-model 测试）。

### 资产 B：eval 校准 harness（P1，前置 = DeepSeek key 就绪）

- `scripts/eval-scaffold.ts --combo C01 --model deepseek-flash`：
  用真实模型按该组合启动 Prompt 生成项目 → 与骨架基线 diff → `npm install && npm run build` + 冒烟 →
  统计一次成功率 / 返工轮数 / 卡点分布 → 结果 JSONL 追加到 `out/eval/`（gitignore）。
- 结果回填 `combos.json` 的 `ai_friendliness`（`ai_friendliness_note` 记录评测批次），
  从"判断"变成"实测"，对外成为硬卖点。
- 多模型：Provider 抽象只支持 Anthropic 协议，多模型走 OpenRouter 一层，不做每家适配。
- 验收断言：harness 用 MockProvider 可离线测管道（不依赖 key）；结果文件含 verified_at 溯源字段。
- **当前阻塞**：本机无有效 key（P0-1b，用户侧并行）。

---

## 第三节 · 边界扩张：inspect + 参数化闭集（P1 + P2）

### 资产 A：`inspect_project` 反查（P1）

- 只读；输入 `workspace_path` 绝对路径；**回显读到的文件清单**（用户可核对它看了什么）。
- 识别链：`package.json`（Node 单包）→ `project.config.json`（小程序）→ 均无 → 明确"覆盖不了 + 替代问法"。
- **monorepo（workspaces / pnpm-workspace.yaml / lerna.json）MVP 直接拒绝**——不为覆盖面硬猜，与产品哲学一致。
- 输出：最接近的组合（按组件命中数）+ 偏离清单（多装的组件、缺的组件，附包名）+ 下一步建议。
- 验收断言：`test-inspect.ts`（识别 / 偏离 / monorepo 拒绝 / 无清单拒绝 / 回显清单）；工具永不写文件。

### 资产 B：离线参数化生成器（P2，生成候选，人工复核入库）

- 用 `fit_rules` 已有的 `ComboCondition` DSL 做约束求解，**离线**枚举组件组合 → 候选清单 → 人工评审 → 入库。
- **运行时绝不动态生成组合**（保住"同一输入同一输出"与 D1 基线可比性）。
- **组合上限 20**；每次扩集的同一 PR 必须同步扩 `tests/d1-holdout.json` 盲标集——
  否则组合集一变，ai_friendliness 实测失去跨版本可比性。
- 验收断言：生成器输出过闭集校验；候选含 evidence 与 last_reviewed（入库前为空并标"待复核"）。

### 资产 C：本地匿名反馈 JSONL（P2，默认关）

- `SP_TELEMETRY=1` 时开启；写到 `~/.stackpilot/usage.jsonl`（用户目录，**不放项目 out/**，避免误提交）。
- 事件只有：timestamp、mode、confidence、top1_id、candidateCount、missing 字段数——**不含原文、不含路径**。
- 用途：校准追问频次、为参数化生成器提供真实分布。用户显式开启，纯本地，随时删文件即撤。

---

## 第四节 · P3 小项（按场景取舍）

| 项 | 内容 | 状态 |
|---|---|---|
| 追问合并指引 | `EXTRACTED_CONSTRAINTS_HINT` 模板常量进追问文案；测试断言文案包含该常量（防润色丢失） | ✅ 本版落地 |
| 跨字段矛盾检测 | `validate.ts` 增 2 条保守规则（compliance 有 payment 但 capabilities 无 payment；selfhost + budget=0），**提示型进 notes，不丢字段** | ✅ 本版落地 |
| 团队蓝图 | `apply_stack_blueprint` 对齐组织标准——**需组织标准数据源，不空实现**，待 B 端场景再评估 | 待办 |
| 规则文件分文件 | `.cursor/rules/` 按 fe/be/deploy 拆分、宿主按需加载 | 待办（收益待观察） |

---

## 落地顺序（已确认）

```
P0-1a  GitHub + 最小 CI（test + smoke，无 key 依赖）        ← 立即（CI 文件本版交付，推送命令见 README）
P0-1b  DeepSeek key 更换/充值（用户侧，与 P0-1a 并行）      ← P1 eval 的前置，不阻塞 P0
P0-2   last_reviewed 独立字段 + 闸门 + 渲染标注             ← 本版落地
P1     骨架模板工程（23 片段 → 12 套，版本锁定自 facts）    ← 本版落地（scaffold/eval/inspect 三工具底座）
P1     inspect_project MVP（只读，单包，边界外明确拒绝）    ← 本版落地
P2     离线参数化生成器（候选评审清单）+ 本地匿名 JSONL     ← 本版落地（闭集扩集待人工评审）
P3     追问指引 + 跨字段矛盾 + 团队蓝图待办                 ← 本版落地（团队蓝图除外，见上）
```
