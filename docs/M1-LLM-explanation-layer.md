# M1 第二阶段：LLM 解释层与防幻觉治理

> 代码：`src/lib/explain/`（types / prompt / provider / validate / fallback / index）
> 评测：`scripts/eval.ts`
> 边界：**LLM 只负责"怎么说"，不参与"选什么"**。选型仍由 `scoring.ts` 的闭集打分决定。

---

## 1. 这一层解决什么，不解决什么

| 解决 | 不解决 |
|---|---|
| 把"引擎选好的组合"翻译成人话 | 不选方案、不改方案、不加方案 |
| 给出可执行的第一步与接下来三步 | 不做前端渲染、不做 SSE（M3） |
| 解释"为什么不选那个" | 不联网、不检索、不调工具 |
| 给出降档建议与代价 | 不做 OpenAPI 导出（P1） |

---

## 2. 数据流

```
rank()  ──►  buildExplainContext()  ──►  buildUserPrompt()  ──►  provider.complete()
             （只抽允许 LLM 看到的事实）      （结构化文本）          （Anthropic Messages 协议）
                                                                        │
                     ┌──────────────────────────────────────────────────┘
                     ▼
              extractJson()  ──►  JSON.parse()  ──►  validate()  ──►  ✅ 交付
                     │                  │                │
                     └──── 失败：带问题重试 1 次 ◄────────┘
                                        │
                                  仍失败 ──►  buildFallback()  ──►  ✅ 交付（标注 source=fallback）
```

`explain()` **永不抛错**。最差情况返回一份 `source='fallback'` 的可用内容——
解释层是锦上添花，不能因为模型挂了就让整个产品不出结果。

---

## 3. 输出 Schema

```jsonc
{
  "combo_id": "C01",                       // 必须等于引擎给的那个，写错即 reject
  "one_pager": {
    "headline": "一句话结论",
    "why": "为什么是这套（必须引用用户约束里的具体字段）",
    "first_step": { "action": "今晚第一步", "minutes": 10 }
  },
  "not_chosen": [                          // 三段式：没选什么 → 为什么 → 何时回头看
    { "combo_id": "C03", "what": "...", "why": "...",
      "reconsider_when": "...",
      "source_when_to_leave": "该组合 when_to_leave 的原文片段" }
  ],
  "next_three_steps": [                    // 正好 3 条，每条带耗时与卡点
    { "action": "...", "minutes": 30, "blocker": "..." }
  ],
  "pitfalls": [                            // 2–4 条，每条必须指向 allowed_pitfalls 的下标
    { "text": "改写后的话", "source_index": 0 }
  ],
  "lighter_alternative": {                 // 降档建议（用户要求"太重就降档"）
    "needed": true, "combo_id": "C12", "why": "必须写清代价"
  }
}
```

**为什么每个"事实"字段都带一个指针**：
`pitfalls[].source_index` 和 `not_chosen[].source_when_to_leave` 是这套设计的关键。
LLM 说"这条坑来自第 1 条"不算数，代码去 `beginner_pitfalls[1]` 取原文比对；
对不上就 reject。**指针有效，就不可能出现"编造的坑"。**

---

## 4. 防幻觉的四道闸

### 闸一：上下文封闭（prompt.ts）

LLM 只能看到四样东西：选中的 combo、用户约束向量、该 combo 的 `beginner_pitfalls`、被淘汰候选的 `when_to_leave`。
没有检索、没有联网、没有工具调用。system prompt 里写死五条禁令（不换方案 / 不引入输入外技术名 / 不编坑 / 不编换方案时机 / 不写废话第一步）。

同一个约束会在 user prompt 里以"数据"形态再出现一次——**模型对结构化数据的遵从度，明显高于对抽象规则句的遵从度**。

### 闸二：溯源指针（validate.ts）

| 错误码 | 含义 |
|---|---|
| `fact.wrong_combo` | 换了方案 |
| `fact.unknown_combo` | 不选清单里出现了没给过的 combo |
| `fact.no_source` / `fact.source_mismatch` | 换方案时机不是原文片段 |
| `fact.paraphrase_drift` | 改写句与原文几乎无重合（可能自己编的） |
| `fact.bad_index` | 坑点下标越界 |
| `fact.pitfall_invented` | 坑点与原文无 2-gram 重合 |
| `fact.lighter_unknown` | 降档建议指向了不在候选里的方案 |

### 闸三：行动可执行（`checkFirstStep`）

第一步必须同时满足：
1. 含命令（`npx / npm / pnpm / pip / docker / git / create-*` …）**或**具体平台动作（打开 / 注册 / 建一个 / 安装）；
2. 不能是"先去学习 / 了解一下 / 再想想"这类废话；
3. **必须提到该方案的主工具**（KB 的 `first_step` 里抽出的 token）。这一条最狠：它把"写了一段很像第一步、但其实是另一套方案的动作"挡在门外。

### 闸四：兜底文案（fallback.ts）

不合格就降级，**绝不把未通过校验的内容交给用户**。

---

## 5. 为什么只重试 1 次

连续两次同样的失败，说明 prompt 对这类输入就是不适配，再试只是烧 token，用户等的是结果不是重试日志。
所以 `maxAttempts = 2`，且**传输层错误（401 / 超时）不重试**——重试也是同样的结果。

---

## 6. 兜底文案为什么必须"独立成立"

它是 LLM 挂掉时用户唯一能看到的东西，所以不能是占位符。全部内容来自闭集已有事实：

| 字段 | 来源 |
|---|---|
| headline / why | `combo.name` + `one_liner` + 用户约束（人数 / 预算） |
| first_step | **`combo.first_step`（v1.6.0 为 12 套逐条手写，含真实命令）** |
| next_three_steps | 按 `components` 推导（有 db 就接数据层，没有就做纯前端交互） |
| pitfalls | `beginner_pitfalls` 原文 |
| not_chosen | `rejected[].reason` + `when_to_leave`（第三人称已转第二人称） |
| lighter_alternative | `lighterCandidates[0]` + **它的第一条坑作为代价** |

两条设计取舍：
- **降档候选按组件数升序排，不按分数排。** "降档"要的是最轻，不是"次优但分高"。H06 里 C11 分数 4.10 高于 C12 的 3.70，但访谈中两个人都说"纯静态 + LocalStorage 就够"，所以要推 C12。
- **降档必须说代价。** 只讲"更轻"不讲"少了什么"，等于诱导用户选一个不满足他需求的方案。

---

## 7. 评测口径（scripts/eval.ts）

| 指标 | 目标 | 口径 |
|---|---|---|
| JSON 解析成功率 | > 95% | 只在**真的拿到模型输出**的样本上算 |
| 第一步可执行率 | > 80% | 只在**通过校验**的样本上算 |
| 降档建议比例 | 无阈值 | 同上，看分布 |
| 校验通过率 | 无阈值 | 看拦截原因分布 |
| fallback 比例 | 越低越好 | 单独列，避免它污染前两项 |

**口径纪律：兜底文案不计入前两项的分子。**
fallback 的第一步是从 KB 抄的，天然可执行；混进来会让"第一步可执行率"虚高到接近 100%——
那测的就不是模型，是我们自己的模板。

**传输层失败算"未测量"，不算"解析成功"也不算"解析失败"。**
第一版实现把它算成了 `parsed=true`，于是凭据失效时脚本报告"JSON 解析 100%"——这种数字比没有数字更危险。

---

## 8. 接真模型

```bash
# 任意 Anthropic Messages 兼容端点（DeepSeek 的 /anthropic 端点也走这套）
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_API_KEY=sk-...
export ANTHROPIC_MODEL=deepseek-flash
export EXPLAIN_THINKING=disabled   # 默认就是 disabled，见 §10.1
export EXPLAIN_MAX_TOKENS=8192     # 默认 8192

npx tsx scripts/eval.ts                  # 跑评测
npx tsx scripts/eval.ts --show=H06       # 打印 H06 的完整交付包
npx tsx scripts/eval.ts --debug-overlap=1 # 打印每条坑的 2-gram 重合度
npx tsx scripts/eval.ts --provider=mock  # 管道自测（不代表模型能力）
npx tsx scripts/eval.ts --provider=broken # 对抗测试（验证校验器会拦）
npx tsx scripts/test-guards.ts           # 校验器回归（用真实模型产生过的原文当 fixture）
npx tsx scripts/diag-raw.ts --id=H06     # 抓模型原文（含 thinking 块），排查"为什么解析失败"
```

本轮改动后的文件指纹（sha256 前 16 位，2026-10-24 M1 结项）：

| 文件 | 指纹 |
|---|---|
| `src/lib/explain/provider.ts` | `362ba8b7aa159b7c` |
| `src/lib/explain/index.ts` | `abaa22c95be49a0b` |
| `src/lib/explain/validate.ts` | `d1b10dc521e91c99` |
| `src/lib/explain/prompt.ts` | `3d5d8640d90f89fc` |
| `src/lib/explain/fallback.ts` | `39903c6f5c7c6a41` |
| `src/lib/explain/types.ts` | `efb195220f10fa1f` |
| `scripts/eval.ts` | `40d35c4c4d03eac7` |
| `scripts/test-guards.ts` | `36364893e94e2c1d` |
| `scripts/check-consistency.ts` | `6114a92ef9868f7c`（未改） |
| `src/lib/scoring.ts` | `ef2b617d67d8aed0`（未改） |
| `src/data/combos.json` | `70d7e733a87b93e7`（未改） |

> `scoring.ts` / `combos.json` / `check-consistency.ts` 指纹与 M0 结项时完全一致——
> 说明 M1 第二阶段只动了"怎么说"，没有回头改"选什么"。

---

## 9. 首次接真模型的实测结果（2026-10-23，deepseek-flash）

| 指标 | 结果 | 阈值 |
|---|---|---|
| JSON 解析成功率 | **7/7 = 100%** | >95% ✅ |
| 第一步可执行率 | **7/7 = 100%** | >80% ✅ |
| 降档建议比例 | 0/1 有效样本（另 6 条无更轻候选） | 无阈值 |
| fallback 比例 | **0/7 = 0%** | 越低越好 |
| 平均延迟 | 6.4s（thinking 关）/ 12.6s（thinking 开） | — |

参与用例 7 条（H01/H02/H04/H05/H06/H08/H10），不出方案的 3 条不参与。

---

## 10. 实测发现的四个问题

### 10.1 thinking 块吃掉 max_tokens，把"截断"伪装成"模型不会写 JSON"

第一次跑，7 条里 6 条 `parse.invalid_json`。日志只写
`Unexpected end of JSON input`，看起来像模型不会写 JSON。

真因：`deepseek-flash` 默认开 thinking，返回 `content: [thinking, text]`，
**thinking 与正文共用 `max_tokens` 额度**。原来写死 2000，thinking 先吃掉 1500+，
正文写到一半被砍断。最极端的一条（H10）2000 全被 thinking 吃光，text 块为空，
报出来是"响应里没有 text 块"——同样指向不了真因。

处置：
- 默认发 `thinking: {type:'disabled'}`。这是"照给定事实写文案"的活，不需要长链推理。
  实测关掉后同一批用例 100% 通过，延迟从 12.6s 降到 6.4s，**质量指标没有下降**。
- `max_tokens` 抬到 8192。
- `stop_reason === 'max_tokens'` 单独报 `parse.truncated`，不许混成 JSON 语法错。

### 10.2 `pitfall_invented` 没有误杀（用户预判的方向不成立）

21 条坑点的 2-gram 重合度实测区间 **13–59**，阈值是 2，最低值也是阈值的 6.5 倍。
一次都没触发。**因此"把 `pitfall_invented` 降级为只校验 `source_index`"这个授权不需要执行。**

按方案分：C01（H04/H06/H10）改写幅度最大，重合 13–27；C11/C12 的坑模型基本原样引用，重合 40–59。
两类都远高于阈值。

### 10.3 `reconsider_when` 的语义在 prompt / 校验器 / 渲染文案三者之间互相矛盾（**已修，2026-10-24**）

这是本轮最严重的问题，比 2-gram 误杀严重得多。

三处定义：
- `renderText` 渲染成「**什么时候回头看**」→ 语义是"何时值得重新考虑这个选项"
- KB 的 `when_to_leave` 是「**何时该离开这个选项**」→ 语义相反
- prompt 第 4 条要求「只能从 when_to_leave 里摘」，`paraphrase_drift` 要求与 when_to_leave 有 ≥3 个 2-gram 重合
  → **实际在奖励"原样照抄"**

后果（H06 实测，同一用例两次调用的对照）：

第一次（被 `paraphrase_drift` 判错）：
> C03 reconsider_when =「当你以后愿意长期维护两套服务、并且 Python 补上来时再回头看」← **语义正确**

重试后（通过校验）：
> C03 reconsider_when =「当团队只有你一个人、且不打算长期维护两套服务时，退回 C01」← **原文照抄**

第二句作为"什么时候回头看 C03"来读是自相矛盾的：它说的是"你一个人时退回 C01"，
而"一个人"恰恰是不该用 C03 的场景。**校验器把对的判错，把错的放行。**

同一批输出里 C11/C12 也是照抄，所以这不是偶发，是重试路径的稳定行为。

**修复（2026-10-24 用户裁决后执行）：**

1. prompt（`prompt.ts`）
   - 删掉「只能从 when_to_leave 里摘」。
   - system 第 4 条改为「必须是 when_to_leave 的**逻辑翻转**，不许摘抄」。
   - 新增第 6 条：不许在 reconsider_when 里加原文没有的数字门槛。
   - user prompt 增加独立小节「关于 reconsider_when：必须做逻辑翻转，不许照抄」，含 3 组 few-shot
     （每组给出 ✗ 照抄 / ✗ 照抄加字 / ✓ 翻转三种写法）。
   - 渲染上下文时把字段标注成「when_to_leave（这是"什么条件下该离开它"，你写的 reconsider_when 必须是它的反面）」。
2. 校验器（`validate.ts`）
   - **删除 `fact.paraphrase_drift`**（它衡量的是"是否照抄"，与该字段语义相反）。
   - 新增 `fact.reconsider_copied`：`reconsider_when` 去标点后与 `when_to_leave` 相同，
     或**双向 2-gram 覆盖率取最大值 > 0.9** 时判失败。
     用双向是因为单向会漏「照抄 + 加几个字」：新句子自身的 2-gram 有 4 个是原文没有的，
     单向只有 87.9%，但反过来看**原文 100% 被搬进来了**，这才是照抄的本质。
   - `fact.quantifier_invented` 继续对 `reconsider_when` 生效。
   - `fact.source_mismatch` 保留：`source_when_to_leave` 仍须是原文逐字片段（只用于溯源，不渲染给用户）。
3. 兜底文案（`fallback.ts`）与 mock（`provider.ts`）也一并改。
   这两个不过校验器，但会把内容**直接交给用户**，照抄同样是把话说反。
   新增 `invertWhenToLeave()`：只保留「当<条件>时，…」里的条件部分，套进
   「等你不再处于「<条件>」这种情况时，再回来看它」的框里——不做同义词替换，不引入新事实，
   所以语义上永远和原文互补。

改造后实测（三轮连续跑）：7 条全部**一次通过**，零重试；三条 `reconsider_when` 全部完成翻转：

| 落选 | when_to_leave 原文 | 模型写的 reconsider_when |
|---|---|---|
| C03 | 当团队只有你一个人、且不打算长期维护两套服务时，退回 C01 | 等你有了团队、并且愿意长期维护前后端两套服务时，再回头看它 |
| C11 | 当需要登录、需要多用户共享数据…离开这套，改用 C01 | 等你的产品确定不做登录、也不需要多用户共享数据时，它才够用 |
| C09 | 当工具调用少于 5 步时，退回 C01 用 AI SDK 的 streamText 即可 | 等你的工具调用步骤多到 AI SDK 的 streamText 撑不住时，再考虑它 |

> 副作用：改造前 7 条里有 3 条要走重试（全部卡在 `reconsider_when`），改造后 0 条。
> few-shot 把"翻转"这个动作说清楚了，第一次就能写对。

### 10.4 模型会凭空造量化门槛（已加校验拦住）

H10 里模型给 C02 写的 `reconsider_when` 是「当日活超过 1 万、或需要复杂服务端定时任务与事务时」，
而 C02 的 `when_to_leave` 原文是「当需要独立扩缩容后端、或有超过 30 秒的长任务时，考虑 C03 或 C09」。
**"日活超过 1 万"原文里没有，是模型自己加的门槛。**

它当时通过了全部校验：`source_when_to_leave` 是逐字片段（过 `source_mismatch`），
`reconsider_when` 与原文有 4 个 2-gram 重合（过 `paraphrase_drift` 的阈值 3）。

这类幻觉比"编一条坑"更危险：坑是清单式的、用户能对照；
而"日活 1 万再换方案"会被用户当成产品建议记下来，直接误导技术决策。

已加 `fact.quantifier_invented`：`reconsider_when` 里的量化门槛必须能在 `when_to_leave` 原文里查到。
口径刻意收窄，只抓两类高置信信号——① 数字 + 万/千/百/倍；② 四位以上纯数字。
不抓"30 秒""5 步"这类小数字（多半是原文自带或通用量词，误杀代价高于收益）。
复跑时该条被拦住，模型重试后自行改对。

### 10.5 `action.filler` 曾被命令词开后门（已修）

原判定是 `FILLER_RE.test(a) && !CMD_RE.test(a)`，意思是"句子里只要出现命令词就不算废话"。
对抗测试发现这等于给废话开后门：「先去学习一下 Docker 和 K8s 的基本概念」含 `Docker`
→ 被豁免 → 一路放行。而它恰恰是最典型的废话第一步。

改为看"废话前缀之后还有没有落到具体动作上"，与句子里出现哪个工具名无关。

---

## 11. 已知局限

1. `temperature: 0.2` 是拍的，没有做 A/B。
2. `pitfall_invented` 用的是 2-gram 重合度，是启发式而非语义判断。
   实测区间 13–59，离阈值 2 很远，但换个改写幅度更大的模型仍可能误伤。
3. `reconsider_when` 的"是否真的翻转了"仍然靠启发式（覆盖率 ≤90%）判断，**不理解语义**。
   一个既没照抄、又逻辑没翻转的句子（比如"当你需要更强的服务端能力时"）能通过校验。
   防编造靠的是"逐字溯源 + 量化门槛"两条，不是"语义正确"。
4. 删掉 `paraphrase_drift` 之后，`reconsider_when` 不再有"必须和原文有关"的约束，
   只剩"不许照抄"。理论上模型可以写一句和原文毫无关系的话。当前 prompt 的 few-shot 压住了这个风险，
   但这是**靠 prompt 而非校验器**在防，属于薄弱环节。
5. 单次调用未做并发与重试退避；真实流量下需要加限流。
6. 评测集只有 7 条（另有 3 条不出方案），样本量小，100% 不代表线上 100%。
7. `第一步可执行率 100%` 是正则判的（有没有命令/平台动作/主工具），
   只能挡住"先去学习一下"这类，挡不住"命令对但方案错"。它是下限，不是上限。

---

## 12. M1 结项（2026-10-24）

M1「解释层」闭环完成，判定 **Go**。

| 项目 | 状态 |
|---|---|
| 三项指标 | JSON 解析 100%（7/7）、第一步可执行 100%（7/7）、fallback 0% |
| 稳定性 | 连续 3 轮复跑，7 条全部**一次通过**，零重试 |
| 平均延迟 | 4.7–5.5s / 条（thinking 关闭） |
| `check-consistency` | 81 项全绿 |
| `test-guards` | 27 项全绿 |
| 对抗测试（`--provider=broken`） | 7/7 全部被拦，fallback 100% |
| 管道自测（`--provider=mock`） | 7/7 通过 |

**M1 做完了什么**

1. 选型（M0）与解释（M1）彻底分离：`explain()` 没有能力改 `combo_id`，LLM 不参与选型。
2. 四道闸 + 两条实测补丁（`quantifier_invented`、`reconsider_copied`）构成事实层防线。
3. 兜底文案与 LLM 走同一份契约——`buildFallback()` 的输出本身必须能通过 `validate()`，
   这条由 `test-guards` 第 5 组守着。降级不等于降标准。
4. 校验器有了固定 fixture 回归（27 条断言），不再靠"重跑碰运气"。

**M1 明确没做**

- 不做 SSE 流式渲染（M3 再说）。
- 不做多轮对话与追问。
- 不做 prompt 的 A/B（`temperature` 仍是拍的）。
- 7 条评测集不构成线上质量承诺。

**下一步：M3 前端渲染**

M3 要消费的是 `ExplanationPackage`（JSON）与 `renderText()` 的纯文本形态。
M3 开工前需要确认的三件事：
1. `not_chosen` 的展示顺序（当前按 rejected 顺序：先硬过滤、后差一点入选）。
2. `source_when_to_leave` 是否完全不进 UI（当前不渲染，只用于校验与排查）。
3. `confidence` 三态在界面上如何体现（当前只在 prompt 里用到，UI 还没有对应设计）。

