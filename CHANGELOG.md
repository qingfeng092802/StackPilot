# Changelog

所有显著变更记录在本文件。格式参考 Keep a Changelog；版本遵循 SemVer。

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
