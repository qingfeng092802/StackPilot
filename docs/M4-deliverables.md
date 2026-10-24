# M4 产出物清单（验收与归档）

> 生成时间：2026-10-24
> 仓库：`D:\StackPilot`（git 已初始化，首个提交 `8b9a36d`，共 72 个文件）
> 这份清单回答两件事：**验收时按什么顺序看**、**归档时哪些必须留**。

---

## 0. 验收顺序（按这个走，20 分钟）

| 步 | 做什么 | 通过标准 |
|---|---|---|
| 1 | `npm install && npm run build` | 输出 `server.js 143 KB / 凭据 无 / 依赖 无` |
| 2 | `npm test` | 四套全绿：consistency + 27 + 27 + 53 |
| 3 | `npm run dev`，打开 `localhost:8787` | 页面能开、能出追问、能出方案 |
| 4 | 删掉 `ANTHROPIC_API_KEY` 再启动 | **起不来**，退出码 1（证明安全检查生效） |
| 5 | 读 `docs/final-test-execution-manual.md` §3.4 | 自己跑一遍三个案例，Top1 对得上 |

第 4 步是**反向验收**，别跳过——它是"凭据隔离"唯一能被亲眼验证的地方。

---

## 1. 文档（`docs/`）

| 文件 | 一句话说明 |
|---|---|
| **`final-test-execution-manual.md`** | **★ 终测操作手册**：预热步骤、三组案例原文、八步流程、解析错误怎么记、备用方案 |
| **`final-user-test-plan.md`** | 终测**设计**：测试目标、问题清单、记录模板、判定口径（与 framework 一致） |
| `interview-analysis-framework.md` | 判定口径的权威定义：p 怎么算、达标/半步/未达标、主因分类、反模式。**访谈前不要打开** |
| `interview-question-list.md` | M0 那轮的问题清单（D4 三问的出处） |
| `interview-record-template.md` | M0 那轮的记录模板（终测版在 `final-user-test-plan.md` §4） |
| `interview-question-sheet.md` | M0 访谈现场用的问题速查卡 |
| `interview-round1-analysis.md` | 第一轮访谈复盘（样本问题：3 人看了同一份材料） |
| `interview-round2-analysis.md` | 第二轮访谈复盘（n=5，p=0.60，方向性支持） |
| `ADR-001-m0-verdict.md` | M0 的架构决策记录：为什么先验证输出侧，而不是先做解析层 |
| `M1-LLM-explanation-layer.md` | 解释层设计：三层防幻觉、fit 乘数、confidence 三态、兜底方向相反 |
| `M3-frontend-rendering.md` | 前端渲染：SSE 模块级分块、三态渲染、view-model 的三条 UI 决策 |
| `F1-natural-language-intake.md` | **解析层**：三道闸、`dropped` 机制、§7.6 极性 bug 全过程 |
| `output-validation-preview.md` | M0 给受访者看的方案材料（历史资产） |
| `deploy-safe.md` | **★ 安全部署指南**：Zeabur / Render 步骤、环境变量清单、故障对照表 |
| `deploy-report.md` | 旧平台的三关实测（**已作废**，保留作为"为什么不能用"的证据） |

---

## 2. 代码（`src/` `server/` `web/`）

### 2.1 选型内核（`src/lib/`）

| 文件 | 一句话说明 |
|---|---|
| `scoring.ts` | 唯一的选型逻辑：能力匹配、fit 乘数、加权求和、rank。`CAPABILITY_VALUES` 里含 `no_persistence` |
| `confidence.ts` | 置信度三态判定 + `isLocalOnlyEvidence`（极性检查的关键词表） |
| `facts/index.ts` | 事实层：给解释层提供"能说的真话"，防止模型编造 |
| `explain/prompt.ts` | 解释层 Prompt（**冻结**，M1 结项后未改） |
| `explain/validate.ts` | 解释层校验（**冻结**）：闭集 + evidence 逐字溯源 + 结构完整性 |
| `explain/index.ts` | 解释层编排：调模型 → 校验 → 不过就退回模板 |
| `explain/fallback.ts` | 模板兜底文案（校验不过时用，内容完整） |
| `explain/provider.ts` | LLM 抽象：`AnthropicProvider` / `MockProvider` / `BrokenProvider`（对抗测试） |
| `explain/types.ts` | 解释包的类型定义 |
| `intake/prompt.ts` | 解析层 Prompt：三道闸 + 极性铁律 + 三个 few-shot |
| `intake/validate.ts` | 解析层校验：逐字子串 evidence、空数组需否定表述、unknown-key、**两道极性检查** |
| `intake/index.ts` | 解析层编排：模型 → 校验 → 追问模板 |

### 2.2 数据（`src/data/`）

| 文件 | 一句话说明 |
|---|---|
| `combos.json` | **12 套组合（C01–C12）** + 各自的 fit_rules / 坑 / 第一步 / when_to_leave |
| `component-names.ts` | 组件显示名映射（技术名 → 人话） |
| `facts-snapshot.json` | 事实快照（价格、能力等可核验的事实） |

### 2.3 服务端（`server/`）

| 文件 | 一句话说明 |
|---|---|
| `index.ts` | 零依赖 `node:http` 服务：4 条路由 + SSE + **启动期环境变量自检** + 单路径折叠模式 |
| `view-model.ts` | 把引擎/解释包转成前端能直接渲染的结构（含三条 UI 决策） |

### 2.4 前端（`web/`）

| 文件 | 一句话说明 |
|---|---|
| `index.html` | 单页结构：大白话输入 → 追问区 → 结果区 |
| `app.js` | 交互：端点解析（`EP`）、追问渲染、答案合并、SSE 手写解析 |
| `styles.css` | 全部样式 |

---

## 3. 脚本（`scripts/`）

### 3.1 测试与校验（**归档必须留**）

| 文件 | 一句话说明 |
|---|---|
| `check-consistency.ts` | **86 项**数据一致性检查（组合、fit 规则、极性、兜底文案） |
| `test-intake.ts` | **53 条**解析层断言（含第十组 10 条极性回归） |
| `test-guards.ts` | 27 条闸门断言（逐字子串、否定表述、unknown-key） |
| `test-view-model.ts` | 27 条 view-model 断言（三态、分组顺序、推断依据透出） |
| `top1-baseline.ts` | Top1 基线快照（改代码后对比"有没有悄悄改掉别的用例结论"） |
| `d1-coverage.ts` | D1 闭集覆盖诊断（10 个案例落在哪套组合） |
| `eval.ts` | 解释层评测（7 条用例，跑真实模型） |
| `smoke-test.ts` | 端到端冒烟 |
| `d3-harness.ts` / `build-facts.ts` / `gen-preview.ts` | M0/M1 期的生成与评测脚手架 |
| `intake-probe.ts` | 解析层真实模型探针（5 条用例） |
| `diag-raw.ts` | 单条原文的诊断（看模型到底回了什么） |

### 3.2 构建与部署（**归档必须留**）

| 文件 | 一句话说明 |
|---|---|
| `build.mjs` | 打包成 `build/server.js`（143 KB，零运行时依赖）+ **构建期凭据扫描** |
| `dev.mjs` | 本地启动器：读 `.env.local` 并**覆盖**同名变量（解决 `--env-file` 不覆盖的坑） |
| `local-gateway.mjs` | 本地代理网关：真 key 留本机，线上只拿可撤销令牌（沙箱兜底） |
| `uptime-probe.mjs` | 可用性探针：N 次请求的失败率 + p50/p95，>5% 退出码 1 |

### 3.3 截图工具

| 文件 | 一句话说明 |
|---|---|
| `shot.mjs` | CDP 全页截图（等页面稳定 + 等 SSE 跑完再截） |
| `ui-shot-public.js` | 线上单路径部署的完整闭环截图脚本 |
| `ui-shot-ask.js` / `ui-shot-manual.js` / `ui-shot-plan.js` / `ui-shot-uncovered.js` | 四种 UI 状态的截图脚本 |

---

## 4. 数据与测试（`tests/`）

| 文件 | 一句话说明 |
|---|---|
| `d1-holdout.json` | **H01–H10 十个真实案例**（原文 + ground_truth），终测的刺激材料就从这里取 |
| `d1-candidates.json` | 候选组合池（闭集的来源） |
| `cases.json` | 引擎用例集 |
| `fixtures/plan-H06.json` | H06 的冻结交付包（演示 tab 用，不调模型） |

---

## 5. 根目录

| 文件 | 一句话说明 |
|---|---|
| `package.json` | `build` / `start` / `dev` / `test`；无 `dependencies`，devDep 只有 esbuild |
| `.gitignore` | 排除 `.env*` / `build/` / `out/` / `node_modules/` |
| `.env.example` | 环境变量模板（**不含真 key**，故意不用 `sk-` 开头避免误报） |
| `PRD-StackPilot-v0.4.4-定稿.md` | **最新 PRD**（v0.2 → v0.4.4 五版演进都在） |
| `PRD-StackPilot-技术选型推荐系统.md` | 最初的 PRD |
| `D1-数据采集与闭集覆盖诊断.md` | D1 期的覆盖诊断报告 |
| `M0-D3-方案生成Prompt.md` | M0 期的方案生成 Prompt |

---

## 6. 不归档的东西

| 路径 | 为什么 | 需要时怎么重建 |
|---|---|---|
| `build/` | 构建产物，`.gitignore` 排除 | `npm run build` |
| `out/` | 截图、临时日志、探测输出 | 跑对应脚本重生成 |
| `node_modules/` | 依赖 | `npm install` |
| `.env.local` | **真凭据**，绝不能归档或提交 | 从 `.env.example` 复制后填 |

---

## 7. 归档建议

**必须留（重建成本极高或不可重建）**

- `tests/d1-holdout.json` —— 10 个案例的原文和标注，是全部评测的地基
- `src/data/combos.json` —— 12 套组合的全部知识（坑、第一步、when_to_leave）
- `docs/` 全部 —— 决策过程比代码更难重建
- `scripts/check-consistency.ts` + `test-intake.ts` —— 改任何东西之前的安全网

**可以删**

- `out/` 里的中间产物（截图留 `public-plan.png` 一张即可）
- `PRD-StackPilot-v0.2` / `v0.3` / `v0.4` / `v0.4.3` —— 只留 v0.4.4 定稿，历史在 git 里
- `docs/interview-question-sheet.md`、`output-validation-preview.md` —— M0 的现场材料，已归档完成使命

---

## 8. 一键验收命令

```bash
cd D:\StackPilot

# 构建（顺带跑凭据扫描）
npm run build

# 全量回归（四套）
npm test

# 起服务
npm run dev

# 反向验收：缺 key 应该起不来
# （临时把 .env.local 里的 key 清空，再 npm run dev，应看到 ✗ 启动失败）
```
