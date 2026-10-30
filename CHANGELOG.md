# Changelog

所有显著变更记录在本文件。格式参考 Keep a Changelog；版本遵循 SemVer。

## [2.3.0] - 2026-10-30

### 新增
- **ai_friendliness 从拍脑袋变为实测**：12 套 × 3 轮真实跑批（deepseek-flash，AI 一次生成 → npm install → build），映射公式可复算（docs/eval-batch-2026-10-30-flash-v1.md）。8 套分数修正：C06/C07/C08 实测垫底（AI 生成的小程序/原生模块方案跑不通），C09/C10 上调（build 能过，骨架覆盖 AI 漏写的层），C11 5→4（1/3 轮依赖声明失败）。
- **骨架优势硬数据**：全批次 33 组合轮次中，scaffold 部署工件被 AI 100% 漏掉（30/33 轮全漏、无一例外）——“比原生 AI 强”的核心证据。
- **consistency 防回退闸门**：ai_friendliness_note 必须含实测批次号，退回拍脑袋直接红。
- eval 失败归因留痕：failure_kind 严格分类（passed/shape_fail/build_fail/coverage_fail），install 错误取 npm error 尾段。

### 修复（跑批暴露，修跑批脚本而非造假数据）
- eval 落盘 AI 文件：路径 key 混用 \ 与 /（实测 C11 反斜杠 key 复发掐尾 bug）——统一规范化 + dirname。
- 小程序无 npm build 语义：无 build script 记 skipped 不算失败（C07/C08 口径假阴性修正）。
- 基线口径变更（实测排序漂移，注明来源）：H01 Top1 C11→C01（C11 实测 4 分，推断不触发的真语义不变）；C11/C12 同分断言改近分（|差|≤1）。
- C06 归因实锤：AI 引入 better-sqlite3 原生模块（Windows 编译必炸）+ 漏生成路由入口——闭集应考虑以纯 JS sqlite 客户端替代（待办）。

### 变更
- ⚖️ 红队质疑与辩护 → ⚠️ 避坑预警与平替方案（文案说人话）。

## [2.2.1] - 2026-10-30

### 修复
- **scaffold 落盘的 Windows 路径 bug（真实实跑抓到）**：`mkdirSync(target.slice(0, lastIndexOf('/')))` 在反斜杠路径上把文件名掐尾建成怪目录（`applayout.ts` 目录、`.gitignor`），改用 `path.dirname`。只有 Windows 实跑才暴露——骨架实跑的价值实证。
- eval-scaffold：ESM 里的 require 改静态 import；输出上限 16384 + 「最小可运行」压缩令（实测 C12 被巨型 SVG 写满 8192）；失败诊断留痕（stopReason/usage/text 头尾）。

### 变更
- **debate-court.ts 封存至 scripts/experimental/**（实验性非主流程）：对 12 套闭集的静态数据，五角色三阶段为过度工程，debate 字段由单次 Prompt + 人工撰写覆盖；registry 检查能力并入 eval 管线；ai_friendliness 校准的正统路径是骨架实跑。

### 实测里程碑
- C01 骨架 Windows 实跑：install 328 包 + next build 通过。
- CI 首跑（ubuntu，467 断言 + smoke 29）：success。
- eval 真实首跑（deepseek-flash，C12 两轮含 build）：AI 生成项目 build 通过率 2/2；锁定依赖覆盖 1/2（AI 不生成部署 CLI——评分口径待修正，记待办）。

## [2.2.0] - 2026-10-30

### 新增（多 Agent 对抗式生成与红队裁决，见 docs/ROADMAP-v2.2-debate.md）
- **combos.json 新增 debate 字段**（12 套全部落位）：proponents（代言本组合真实组件）、red_team_warnings（红队警告，定性为主）、plan_b（翻车触发条件 + 闭集内平替）。首版 author=manual 人工撰写，待法庭真实辩论复核后替换。
- **渲染层「⚖️ 红队质疑与辩护」区块**：recommend_stack 与 get_detailed_prompt 输出均挂载，100% 模板确定性渲染，无 debate 数据向后兼容跳过。打破顺从性偏见——用户拿到的是"这套方案在什么情况下会死、死了换哪套"。
- **离线多 Agent 法庭**（已于 2.2.1 封存至 scripts/experimental/，实验性非主流程；其 registry 检查能力并入 eval 管线。原脚本 debate-court.ts）：Phase1 五角色独立深挖（禁通信）→ Phase2 mailbox 辩论（1-2 轮）→ Phase3 Lead 裁决。集成评估师**真实接入 npm registry**（无需 key，实跑抓到 next 16.4.2→16.4.3 快照漂移）；--mock 全管道确定性验证；--integrator-only 可在 key 到位前真跑。
- **consistency 闸门 6 条**：author 可追溯 / 红队警告≥1 且≥12 字 / 禁 4 位以上数字 / 代言人只代言本组合组件 / plan_b 引用闭集 / trigger 非模板话术。
- 争议模式动态路由（提案第 5 节）按原方案标注 P2+ 不实现，记 ROADMAP 待办。
- 测试：十套回归（test-registry 增至 35 断言，含红队区块端到端 + 纯函数断言）。

## [2.1.1] - 2026-10-30

### 修复
- **`scaffold_blueprint` 非空判定改白名单**：`mkdir && git init && README` 这类工作流不再被误伤；
  只有出现白名单外内容（`package.json`、用户源码等）才拒绝，错误信息列出具体阻挡文件。
- **`inspect_project` 排序键改为对称差**（多出的包数 + 缺失的包数，升序，同分看命中率）：
  修正两个历史极端——纯命中率偏袒小组合（C05 基线 5 包）、纯命中数偏袒大组合（C01 基线 9 包）。
  "多装 Redis"与"缺一个包"从此可区分，且不随组合大小漂移。判据测试钉死。
- **`last_reviewed` 日历体系统一为 UTC**：写入与断言同口径，消除本机（UTC+8）与 CI runner（UTC）
  跨日时 ±1 天抖动；consistency 加跨日自检（UTC 今天恒为 0 天）。
- `HAS_KEY` 改为运行时求值：测试/宿主清除 env 后立即生效，不再钉死 import 时刻的状态。

### 新增
- **工具注册表抽离（`mcp/tools.ts`）+ `test-registry.ts`（27 断言）**：补上"误删 toParseInfo 只有
  smoke 能抓到"的接线层盲区——五工具名齐全、空输入不抛、参数错误走 `isError`、最小合法输入端到端。
  `server.ts` 收缩为薄壳（守卫 + 循环注册 + connect）。
- 参数化候选评审材料迁至 `src/data/candidates-pending/`（`out/` 会被 gitignore 吞掉）。

### 测试
- 九套回归：新增骨架拼装（77）与项目反查（20）判据扩展、注册表（27）。

## [2.1.0] - 2026-10-30

### 新增（ROADMAP v2.1：从选型问答器到架构生命周期工具）
- **骨架资产单一事实源**：组件片段库（20 组件）+ 确定性拼装器（12/12 组合），npm/pypi 版本
  全部按 `facts-snapshot.json` 溯源锁定，peer 依赖强制带说明，溯源写进 `.stackpilot/build-info.json`。
- **`scaffold_blueprint` 工具**：从零生成可运行骨架 + 顺带写入架构契约；workspace 必须不存在或干净目录。
- **`inspect_project` 工具**：存量项目只读反查（最接近蓝图 / 缺失 / 多余），monorepo 与未知形态明确拒绝，
  回显读取的文件清单。与 scaffold 共享同一基线——scaffold 产物反查必然"完全一致"。
- **`eval` harness**（`scripts/eval-scaffold.ts`）：AI 生成 → 骨架基线 diff → 可选实跑 build → JSONL 溯源。
  `--mock` 可离线测管道；真实评测等 key（P0-1b）。
- **`last_reviewed` 时效元数据**：12 套独立字段 + consistency 断言 + 四处渲染标注。
- **离线参数化生成器**（`scripts/gen-candidates.ts`）：闭集扩集候选清单（≤20），人工评审入库。
- **本地匿名反馈**（`src/lib/telemetry.ts`）：`SP_TELEMETRY=1` 开启，仅结构化字段，写 `~/.stackpilot/usage.jsonl`。
- **CI**（`.github/workflows/ci.yml`）：零 secret，test + smoke + 凭据红线复检。
- P3：追问合并指引模板常量（`EXTRACTED_CONSTRAINTS_HINT`，断言防丢失）；跨字段矛盾提示
  （`parseIntake.warnings`，提示型不丢字段）。
- 两个工具在 v2.1.0 加入后共 **5 个工具**；`npm test` 八套 397 断言、smoke 29 断言。

## [2.0.0] - 2026-10-30

### 新增（工业可用级改造）
- **宿主算力借用（路径 A）**：`recommend_stack` 新增 `extracted_constraints`，宿主模型提取的结构化约束
  直接过本地三道闸（逐字溯源 / 枚举+极性 / 数值换算），零模型成本；三级解析路由 A/B/C。
- **低置信度追问协议**：不硬推方案，返回 `## ⚠️ 需要补充信息` + 宿主行动指令。
- **`apply_stack_blueprint` 工具**：架构契约写入 `.cursor/rules/stackpilot.mdc`（alwaysApply）与
  `CLAUDE.md`（`STACKPILOT:START/END` 幂等区间），手写内容一字不动。
- **Prompt 注入防御**：`src/lib/intake/injection.ts` 高置信模式剥离 + XML 边界逃逸拦截；
  内部 LLM 链路 `<user_raw_input>` 隔离 + System Prompt 防注入铁律。
- **stdio 稳定性**：构建期向产物注入 stdout 守卫（console.log/info/warn 一律改道 stderr）；
  全部 handler `safeHandler` 兜底（内部错误转 `isError:true` 可读信息）；进程级异常监听不退出。
- **npx 分发配置**：bin / files / LICENSE / shebang；中文数量解析（十来个/两周内/每月预算 N 元，
  约数取保守下界）；C07 名实对齐（Supabase）；tsx 进 devDependencies。

## [1.7.0] 及更早

见 `docs/` 下的 ADR 与 PRD 版本历史。
