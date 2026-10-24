# M3 前端渲染（2026-10-24）

## 1. 这一阶段做了什么

把 M1 产出的 `ExplanationPackage`（JSON）渲染成一个人能读、能照着动手的交付页，并且用 SSE 分模块下发。

**没做**：移动端适配、构建工具链、多轮对话、真实用户体系。

## 2. 为什么是零依赖自建服务

项目至今没有 `package.json`，全靠 `npx tsx` 跑。为了一个渲染页引入 Next.js / Vite，
会把"改一行立刻看到效果"变成"等热更新"，而 M3 要验证的是**渲染结构**，不是构建工具。

所以：`node:http` 一个文件（`server/index.ts`）+ 三个静态文件（`web/`）。

```
npx tsx server/index.ts          # http://localhost:8787
```

| 路由 | 作用 |
|---|---|
| `GET /` | 渲染页 |
| `GET /api/demo?state=high\|medium\|low` | 用冻结的真实交付包跑完整 SSE，不调模型 |
| `POST /api/plan` | 真实链路：rank → explain → SSE 分模块下发 |

## 3. 三条 UI 决策怎么落地的

决策全部实现在 `server/view-model.ts`（纯函数），前端只负责照着渲染。
不放在 HTML 模板或 `app.js` 里，是因为改一处漏一处；放视图模型可以被 `test-view-model.ts` 直接断言。

### ① not_chosen 先「差一点入选」，后「被硬性条件排除」

分组依据来自 `rank()` 的 `runnerUps` / `filteredOut`，**不是 LLM 的输出顺序**——
LLM 只决定"提哪几条"，不决定"怎么归类"，否则模型换个顺序就能改 UI 结构。

两组各带一句 `hint` 解释这组是什么（"被硬性条件排除"对普通用户不是自明的）。
"差一点入选"的条目显示分数（4.10 分），"被硬性条件排除"的显示硬冲突原因。

### ② `source_when_to_leave` 绝对不进 UI

从结构上排除：`UiNotChosenItem` 这个类型里**没有这个字段**，不是"渲染时忘了过滤"。
以后加字段也不会顺手把它带进来。`test-view-model.ts` 断言序列化后的 payload 里
既不含 `source_when_to_leave` 这个键，也不含 `when_to_leave` 的原文。

翻转后的 `reconsider_when` 照常渲染，视觉上单独一块灰底 + `↩` 标记，
让它读起来是"什么时候回头用它"，而不是"为什么没选"。

### ③ confidence 三态

| 状态 | 渲染 |
|---|---|
| `high` | 正常。右上角绿色「信息充分」 |
| `medium` | 顶部黄色警告条，方案照常给 |
| `low` | **阻断**。不渲染方案，只给追问表单 |

`low` 的阻断发生在引擎层——`rank()` 直接返回 `RankBlocked`，**根本不调模型**。
这既省钱，也兑现了 M0 立的"不知道绝不当懂王"。

追问表单按 `suggested_fields` 动态生成控件（select / 数字 / chips / 滑块），
答完合并进向量重跑。语言基础用滑块而不是文本框：自由文本没法回填成 `{js, python, sql, ops}`。

## 4. SSE 分块策略

事件只有 6 种：

```
meta      方案身份 + confidence 三态 + 组件构成（最先到）
progress  模型调用期间的心跳（每 700ms 一次 elapsed_ms）
module    一个模块的完整内容，带 module / seq
blocked   不出方案（low / uncovered / insufficient_candidates）
done      source（llm|fallback）、attempts、latency_ms
error     服务端异常
```

模块顺序：`one_pager` → `not_chosen` → `next_three_steps` → `pitfalls` → `lighter_alternative`。

### 为什么分块边界是「模块」而不是「token」

`validate()` 是**全有或全无**的：它要拿到完整 JSON 才能判"坑有没有编、combo_id 有没有被换"。
边流边渲染就等于把未校验的内容交给用户，直接违反 M1 定的"绝不把未通过校验的内容交给用户"。

所以：**模型流式输出 → 累积 → 解析 → 校验 → 再按模块切片下发**。
用户看到的是"一页纸先出现，其余模块逐块出现"，但这个节奏来自**校验后的模块边界**，
不是模型的 token 节奏。

模块之间 180ms 的间隔是**人为的**（`M3_MODULE_STAGGER_MS` 可调，设 0 关闭），
目的是让"增量出现"在视觉上成立。这一点写在代码注释里，不假装是模型节奏。

### 前端怎么增量渲染

不用 `EventSource`：它只能 GET、不能带 body、不能加 header，而真实链路是 `POST + JSON`。
统一用 `fetch` + `ReadableStream` 手写 SSE 解析，让演示和真实请求走**同一套**代码——
两套解析逻辑迟早不一致。

每收到一个 `module` 就 `appendChild` 一个 `<section>`，CSS `animation: slideIn` 负责进场。

## 5. 实测节奏（真实模型，POST /api/plan）

```
11:46:47.322  meta          ← rank 是同步的，先给方案身份
11:46:47.971  progress      ← 心跳开始
...（6 次心跳）...
11:46:52.546  module        ← 模型 5.2s 返回并通过校验
11:46:52.920  module        ← +180ms
11:46:53.272  module
11:46:53.612  module
11:46:53.957  module
11:46:54.312  done          ← latency 5551ms, source=llm, attempts=1, issues=[]
```

用户视角：0s 看到方案身份 → 5.2s 内一直有心跳（不是空白屏）→ 5.2–6.0s 五个模块逐块落下。

## 6. 遇到的新坑

### 6.1 `msedge --screenshot` 截不到流式页面

`--virtual-time-budget` 会和 SSE 长连接打架：流还没读完就截图，
抓到的永远是"正在生成说明文案…"那半屏。试过把 budget 加到 12s 也没用。

改用 CDP：起一个带 `--remote-debugging-port` 的 headless 浏览器，
用 Node 22 原生 `WebSocket` 连上去，轮询页面里的 `.progress-line` 直到出现"完成"，
再 `Page.captureScreenshot` + `captureBeyondViewport` 抓整页。见 `scripts/shot.mjs`。

### 6.2 本机 HTTP 代理把 localhost 也劫持了

`HTTP_PROXY=http://127.0.0.1:65087` 存在时，`curl http://127.0.0.1:8787/` 返回
**502 upstream connect failed**——不是服务没起，是请求被代理转走了。
必须 `curl --noproxy '*'`。排查时这个假象很有迷惑性：日志里服务明明在 listen。

### 6.3 后台进程随工具调用结束而死

`(cmd &)` 起的服务在 bash 调用结束时被回收，下一次 curl 就是连接拒绝。
改用受管的后台任务，进程才活得住。

### 6.4 `require` 在 ESM 下不可靠

`server/index.ts` 是 ESM（用了 `with { type: 'json' }`），里面写 `require(...)` 会炸。
改成顶部静态 `import`。

### 6.5 警告条一开始读起来像嵌套函数调用

第一版是 `注意：你提供的信息还不够完整（${confidence_warning}）`，
而引擎文案本身带括号（"补充信息缺 3 项（a、b、c）"），拼出来是
`…不够完整（补充信息缺 3 项（…），补上就会更准）`。

而且引擎文案里写的是 schema 字段名（`timeline_weeks`），直接给用户看等于让人读代码。
改成：视图层做中文字段映射 + 用句号断开，不用括号包。

### 6.6 演示态和左侧表单各说各话

演示用的是服务端冻结的向量，左侧表单还显示着预填值 → 右边说"信息不足"、左边显示 JS 0.8。
改成服务端随 `meta` / `blocked` 下发 `demo_vector`，前端回填表单。
不让前端自己存一份副本——两份数据迟早不一致。

## 7. 验证

```
npx tsx scripts/test-view-model.ts     # 27 项断言，覆盖三个 UI 决策
npx tsx scripts/test-guards.ts         # 27 项，事实层（未改动）
npx tsx scripts/check-consistency.ts   # 81 项全绿（未改动）
```

截图：`out/ui-high.png` / `out/ui-medium.png` / `out/ui-low.png`

## 8. 已知局限

1. **没有真流式**。模块级分块是校验后的切片，不是模型 token 流。真流式要先改
   `validate()` 的契约（改成"边到边校验"），那会削弱防幻觉，不在 M3 范围。
2. 需求输入是**结构化表单**，没有自然语言解析。原文只用于推断 `data_persistence`。
   NL → ConstraintVector 是独立课题，M3 没做。
3. 模块间隔 180ms 是人为节奏，不是性能指标。
4. 没有并发控制、没有请求取消（关页面靠 `req.on('close')` 兜底）。
5. 桌面优先，未做移动端。
