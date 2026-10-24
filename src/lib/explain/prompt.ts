/**
 * Prompt 构造。防幻觉的第一道闸在这里，不在校验器。
 *
 * 三条硬规则写死在 system prompt 里，并在 user prompt 里用"输入数据"的形式再喂一遍：
 *   1. 方案已经定死（combo_id），不许换、不许加、不许推荐闭集外的技术
 *   2. 坑点只能改写 allowed_pitfalls 里已有的，逐条给下标；不许新增坑
 *   3. 不选清单的"何时回头看"必须是 when_to_leave 的**逻辑翻转**，严禁照抄
 *
 * 为什么要"再喂一遍"：模型对 user 消息里的结构化数据的遵从度，明显高于对 system 里
 * 抽象规则句的遵从度。同一个约束换个形态出现两次，比写一遍加三个感叹号管用。
 *
 * 【第 3 条的来历 · 2026-10-24】
 * 原来写的是"必须抄 when_to_leave 的原文片段"。但 when_to_leave 的语义是
 * "什么条件下该**离开**这个落选方案"，而 reconsider_when 的语义是
 * "什么条件下值得**重新捡起**它"——两者是互补条件，照抄等于把话说反。
 * 实测 H06 就出过这个错：模型第一次写对了（"当你以后愿意长期维护两套服务时再回头看"），
 * 被旧校验器判成"编造"；重试后照抄原文（"当团队只有你一个人…退回 C01"）反而通过了。
 * 校验器把对的判错、把错的放行。现在改为要求翻转 + 禁止照抄。
 */

import type { ExplainContext } from './types.ts';

export const SYSTEM_PROMPT = `你是一个技术方案解释器，不是技术顾问。

你的唯一工作：把一份【已经决定好的】技术方案，翻译成一个人能看懂、能立刻动手的中文说明。

## 你绝对不能做的事
1. 不能更换方案、不能增加方案、不能建议别的技术栈。方案由引擎选定，你只负责解释。
2. 不能引入输入数据里没有出现过的技术名、产品名、库名、公司名。
3. 不能编造"新手常踩的坑"。坑点只能来自 allowed_pitfalls，每一条都要标注它来自第几条。
4. 不能编造"什么时候该换方案"。not_chosen 里的 reconsider_when 必须是 when_to_leave 的**逻辑翻转**，不许摘抄原文。
5. 不能写"先去学习一下""了解一下""看看文档""再想想"这类没有动作的话。第一步必须是今晚就能敲下去的动作。
6. 不能在 reconsider_when 里加入 when_to_leave 原文没有的数字门槛（比如"日活到 1 万""用户到 5000"）。
   这类凭空造的门槛会被用户当成金科玉律记住，是本产品最不能容忍的错误。

## 输出格式
只输出一个 JSON 对象，不要 markdown 代码围栏，不要任何解释性文字。字段必须齐全，不能多字段也不能少字段。`;

/** 把上下文渲染成 LLM 能稳定读的结构化文本（比裸 JSON 更省 token，也更容易被引用） */
function renderContext(ctx: ExplainContext): string {
  const c = ctx.combo;
  const lines: string[] = [];

  lines.push('### 已选定的方案（不可更改）');
  lines.push(`combo_id: ${c.id}`);
  lines.push(`name: ${c.name}`);
  lines.push(`one_liner: ${c.one_liner}`);
  lines.push(`paradigm: ${c.paradigm}`);
  lines.push(`components: ${Object.entries(c.components).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  lines.push(`参考的第一步（你必须写得比它更具体，且必须提到同一个主工具）: ${c.first_step}`);
  lines.push(`参考耗时（分钟）: ${c.first_step_minutes}`);
  lines.push(`什么时候该离开这套: ${c.when_to_leave}`);

  lines.push('');
  lines.push('### allowed_pitfalls（坑点只能从这里选，index 从 0 开始）');
  c.beginner_pitfalls.forEach((p, i) => lines.push(`[${i}] ${p}`));

  lines.push('');
  lines.push('### 用户约束（写"为什么"时要引用这里的字段，不要泛泛而谈）');
  lines.push(JSON.stringify(ctx.vector, null, 0));
  lines.push(`confidence: ${ctx.confidence}`);
  if (ctx.inferred.capabilities.length) {
    lines.push(`引擎从原文推断出的隐性需求: ${ctx.inferred.capabilities.join(', ')}（依据：${ctx.inferred.evidence ?? '原文表述'}）`);
    lines.push('注意：推断出来的需求是"建议级"，写的时候要说清"如果你想省事可以不做"，不要说成硬性要求。');
  }

  lines.push('');
  lines.push('### 被淘汰的候选（不选清单只能从这里面挑，最多 3 条）');
  ctx.rejected.forEach((r) => {
    lines.push(`- combo_id: ${r.id} | name: ${r.name} | tier: ${r.tier} | score: ${r.score ?? '—'}`);
    lines.push(`  reason: ${r.reason}`);
    lines.push(`  when_to_leave（这是"什么条件下该离开它"，你写的 reconsider_when 必须是它的反面）: ${r.when_to_leave}`);
  });

  lines.push('');
  lines.push('### 更轻的候选（只有这些可以用来做降档建议）');
  if (ctx.lighterCandidates.length === 0) lines.push('（无）');
  ctx.lighterCandidates.forEach((l) => {
    lines.push(`- combo_id: ${l.id} | ${l.name} | ${l.one_liner} | score: ${l.score}`);
    if (l.tradeoff) lines.push(`  代价（必须写进 why）: ${l.tradeoff}`);
  });

  return lines.join('\n');
}

export function buildUserPrompt(ctx: ExplainContext): string {
  return `${renderContext(ctx)}

### 关于 reconsider_when：必须做逻辑翻转，不许照抄

when_to_leave 回答的是"什么条件下该**离开**这个落选方案"。
reconsider_when 回答的是"什么条件下值得**重新把它捡起来**"。
这两句是互补条件，方向相反。照抄 when_to_leave 会让整句话变成自相矛盾的建议。

示范（只学怎么翻转，不要照抄这几个例子的字）：

  例 1  when_to_leave：「当团队只有你一个人、且不打算长期维护两套服务时，退回 C01」
        ✗ 错（照抄）：「当团队只有你一个人、且不打算长期维护两套服务时，退回 C01」
        ✗ 错（照抄加字）：「当团队只有你一个人、且不打算长期维护两套服务时，就该退回 C01 了」
        ✓ 对（翻转）：「等你有了团队、并且愿意长期维护两套服务时，再回头看它」

  例 2  when_to_leave：「当需要登录、需要多用户共享数据时，离开这套，改用 C01」
        ✗ 错（照抄）：「当需要登录、需要多用户共享数据时，离开这套，改用 C01」
        ✓ 对（翻转）：「等你的产品确定不做登录、也不需要多用户共享数据时，它才够用」

  例 3  when_to_leave：「当需要独立扩缩容后端、或有超过 30 秒的长任务时，考虑 C03 或 C09」
        ✗ 错（照抄）：「当需要独立扩缩容后端、或有超过 30 秒的长任务时，考虑 C03 或 C09」
        ✓ 对（翻转）：「等你一直不需要独立扩缩容、任务也都在 30 秒以内跑完时，它够用」

翻转的写法要点：
- 把"当…时"换成"等…时/如果…时"，把条件说成"这个条件不再成立"的样子。
- 不要引入原文没有的数字门槛（"日活 1 万""用户 5000"一律不许写）。
- source_when_to_leave 仍然要一字不差地摘 when_to_leave 的原文片段——它只用于溯源，不会展示给用户。

### 你要产出的 JSON（字段一个都不能少，也不能多）

{
  "combo_id": "${ctx.combo.id}",
  "one_pager": {
    "headline": "一句话结论，≤28 字，不要出现技术名词堆砌",
    "why": "为什么是这套，≤80 字，必须引用用户约束里的具体字段（比如'你只有一个人''预算 0'）",
    "first_step": {
      "action": "今晚第一步，必须含具体命令（如 npx / npm / pnpm / git / pip / docker）或具体平台动作（如 打开某网站、注册、建项目），≤60 字",
      "minutes": ${ctx.combo.first_step_minutes}
    }
  },
  "not_chosen": [
    {
      "combo_id": "从上面被淘汰的候选里选",
      "what": "没选什么，≤24 字",
      "why": "为什么没选，≤60 字",
      "reconsider_when": "when_to_leave 的翻转：什么条件下值得重新捡起它，≤60 字，严禁照抄原文",
      "source_when_to_leave": "上面那个候选的 when_to_leave 里的一段原文，必须一字不差地摘（只用于溯源）"
    }
  ],
  "next_three_steps": [
    { "action": "第一步之后的第二个动作", "minutes": 30, "blocker": "这一步最可能卡在哪" },
    { "action": "第三个动作", "minutes": 60, "blocker": "最可能卡在哪" },
    { "action": "第四个动作", "minutes": 120, "blocker": "最可能卡在哪" }
  ],
  "pitfalls": [
    { "text": "把 allowed_pitfalls[0] 改写成对这个用户说的话", "source_index": 0 }
  ],
  "lighter_alternative": {
    "needed": false,
    "combo_id": null,
    "why": "如果用户明显扛不住这套（单人、零预算、时间紧），needed 置 true，combo_id 从更轻的候选里选；否则 false 且 combo_id 为 null"
  }
}

### 最后四个要求
1. next_three_steps 必须正好 3 条，minutes 是 5–480 的整数。
2. pitfalls 至少 2 条、最多 4 条，source_index 必须真实存在于 allowed_pitfalls。
3. 全文用简体中文，不要用"我们""本方案"这类客套，直接对用户说"你"。
4. reconsider_when 不能和 when_to_leave 相同或近似相同（会被判为照抄直接打回），必须真的翻转。`;
}

/** 解析失败时的重试提示：把校验问题原样回喂，比"请重新输出"有效得多 */
export function buildRetryPrompt(issues: Array<{ field: string; detail: string }>): string {
  const list = issues.map((i) => `- ${i.field}: ${i.detail}`).join('\n');
  return `你上一次的输出没有通过校验，问题如下：

${list}

请只修正这些问题，其余内容保持不变，重新输出完整 JSON（不要代码围栏，不要解释）。`;
}
