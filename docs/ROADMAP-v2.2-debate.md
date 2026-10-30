# ROADMAP v2.2：多 Agent 对抗式生成与红队裁决

> 文档版本 v2.2.0 · 2026-10-30
> 设计核心原则：**把复杂度留在离线，把确定性和速度留给 MCP 运行时。**
> 不破坏 stdio 极速响应与 100% 确定性模板生成两条红线——对抗辩论全部离线跑，
> 结果沉淀为 `combos.json` 的静态 `debate` 字段，运行时只做模板渲染。
>
> 背景动机：LLM 技术选型存在「顺从性偏见（Sycophancy）」——任何方案都能被 AI 找到选它的理由。
> 引入「代言人（正方）+ 红队（反方）+ 集成评估师 + Lead 法官」的多 Agent 对抗流程，
> 把「这套方案在什么情况下会死、死了换哪套」变成产品的一等信息。

---

## 落地差异说明（相对原始提案）

| 提案原文 | 实际落地 | 原因 |
|---|---|---|
| 示例 JSON 的 `name` / `stack` 字段 | 保留现有 combos.json 结构（`components.fe/be/db/...`），只**新增** `debate` 字段 | 示例里的 name/stack 是示意性虚构，现有闭集 Schema 是权威 |
| 渲染落点 `src/lib/render.ts` | `mcp/render.ts`（现有渲染层实际位置） | 文件路径对齐现状 |
| 红队警告示例含「冷启动可能高达 1.5s」 | 首版 `debate` 数据**定性为主，禁编造数字**；consistency 闸门禁止 4 位以上数字 | 量化门槛必须有出处（与 test-guards 的 inventedQuantifiers 同一哲学）；真实数字等 eval 法庭接上事实源后再回填 |
| `debate` 内容来源 | v2.2 首版由架构师**人工撰写**（`author: "manual"` 标注），待 V2.2-3 法庭跑真实辩论后由人工复核替换（`author: "debate-court@<批次>"`） | 诚实标注数据来源，不假装是 AI 辩论的产物 |
| 争议模式动态路由（提案第 5 节） | **不实现，记入待办**（需 key、异步兜底、与追问协议的交互需先设计） | 提案自身标注 P2+，任务表未列入 |

---

## V2.2-1 · 数据结构演进（✅ 本版落地）

`combos.json` 每套组合新增：

```json
{
  "debate": {
    "author": "manual",
    "reviewed_at": "2026-10-30",
    "proponents": [
      { "target": "FE-01", "argument": "……" }
    ],
    "red_team_warnings": ["……"],
    "plan_b": { "trigger": "……", "alternative_combo": "C02" }
  }
}
```

**consistency 闸门**（全部钉死）：
- 每套组合必须有 `debate`，且 `red_team_warnings` ≥ 1 条、每条 ≥ 12 字
- `proponents[].target` 必须是**该组合 components 里真实存在的组件 ID**（代言人不代言别人家的组件）
- `plan_b.alternative_combo` 必须在闭集内且 ≠ 自身 id
- `red_team_warnings` 禁止 4 位以上数字（防「日活 10000」类无出处量化门槛；短数字放行）
- `author` 必须为 `manual` 或 `debate-court@<批次>`（来源可追溯）

## V2.2-2 · 渲染层「判决书」区块（✅ 本版落地）

`mcp/render.ts` 新增纯函数 `renderDebateSection(combo, combos)`，挂在「为什么不选其他」之后：

```markdown
### ⚖️ 红队质疑与辩护

**为什么可能是错的（红队警告）：**
- ……

**如果这套方案翻车了（Plan B）：**
- **触发条件**：……
- **平替方案**：左转 C02（Next.js + Route Handlers + Postgres 自建）
```

红线守卫：区块 100% 由 `debate` 字段模板渲染，无任何模型参与；旧数据无 `debate` 字段时整块跳过（向后兼容）。
断言：test-view-model + test-registry 两层验证输出包含区块标题；无 debate 数据不产生空区块。

## V2.2-3 · 离线多 Agent 法庭（⛔ 2026-10-30 封存至 scripts/experimental/，实验性非主流程）

> **产品裁决**：对 12 套闭集的静态数据，五角色三阶段是过度工程——debate 字段由单次 Prompt + 人工撰写覆盖即可。
> 本节保留为设计存档。仍有真实价值的部分：integrator 的 npm registry 检查并入 eval/facts 管线；
> **ai_friendliness 校准的唯一正统路径是骨架实跑（eval-scaffold）**，不是 LLM 互辩。

`scripts/debate-court.ts`——三阶段对抗流程，产出人工复核材料（`src/data/candidates-pending/debate-results.json`）：

1. **Phase 1 独立深挖（禁止通信）**：3 个代言人分别从「框架 / 数据层 / 开发体验」维度辩论；
   红队专找致命缺陷；**集成评估师真实接入 npm registry**（`registry.npmjs.org` 公开 API）查
   peerDependencies 与版本状态——这一角色不依赖 key，是真数据源。
2. **Phase 2 法庭辩论**：调度器把 5 份报告互相分发（mailbox），1–2 轮反驳/再挑刺。
3. **Phase 3 Lead 裁决**：不参与辩论，综合记录输出最终 `ai_friendliness` 建议 +
   `red_team_warnings` / `plan_b` 草案 → **人工复核后才写入 combos.json**（运行时绝不动态改闭集）。

验收：`--mock` 模式 5 角色 → mailbox → 裁决 JSON 全链路跑通（无 key、确定性）；
真实模式需要 key（P0-1b 同一条外部条件线）。

## V2.2-4 · 文档（✅ 本文档）

## 待办（P2+）

- **争议模式动态路由**：对矛盾输入并行 3 份不同侧重（速度/性能/成本）的抽取 → 内部红队互证 →
  冲突追问协议。需先设计它与现有追问协议（`EXTRACTED_CONSTRAINTS_HINT` 闭环）的关系，且仅限有 key 场景。
- **红队接事实源**：GitHub Issues / CVE / deprecated API 检查（真实模式），替代纯 LLM 红队。
- **法庭结果回填自动化**：debate-results → 人工复核 UI → combos.json 的半自动管线。
