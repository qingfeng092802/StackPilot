/**
 * 解释层入口：把"引擎选好的方案"变成"人话交付包"。
 *
 * 调用链：
 *   buildExplainContext()  ← 从 rank() 的结果里抽取 LLM 允许看到的事实
 *        ↓
 *   explain()              ← 调模型 / 解析 / 校验 / 重试 / 兜底
 *        ↓
 *   ExplanationPackage     ← 结构化交付物（JSON），可再渲染成纯文本
 *
 * 三条不可协商的边界：
 *   1. 这个模块**不参与选型**。combo 由调用方传入，explain() 没有能力改它。
 *   2. LLM 看到的上下文只有 ExplainContext 里的字段，没有任何检索、联网、工具调用。
 *   3. 校验不过就降级到 fallback，**绝不把未通过校验的内容交给用户**。
 */

import type { Combo, ConstraintVector, RankOutcome } from '../scoring.ts';
import { buildFallback } from './fallback.ts';
import { buildRetryPrompt, buildUserPrompt, SYSTEM_PROMPT } from './prompt.ts';
import type { LLMProvider } from './provider.ts';
import type { ExplainContext, ExplainResult, ValidationIssue } from './types.ts';
import { validate } from './validate.ts';

export * from './types.ts';
export { AnthropicProvider, MockProvider, BrokenProvider } from './provider.ts';
export { buildFallback, invertWhenToLeave } from './fallback.ts';
export { validate, checkFirstStep, pitfallOverlaps, inventedQuantifiers } from './validate.ts';
export { SYSTEM_PROMPT, buildUserPrompt } from './prompt.ts';

/** 从 rank 结果里抽出"LLM 允许看到的事实"。越权的东西一律不传。 */
export function buildExplainContext(
  r: RankOutcome & { ok: true },
  combos: Combo[],
  vector: ConstraintVector,
): ExplainContext {
  const byId = new Map(combos.map((c) => [c.id, c]));
  const top = byId.get(r.top1.id);
  if (!top) throw new Error(`top1 ${r.top1.id} 不在闭集里，数据不一致`);

  // 不选清单候选：被淘汰的（带原因）+ 差一点的（带分数），最多各取 2/3 条
  const rejected: ExplainContext['rejected'] = [
    ...r.filteredOut.slice(0, 3).map((f) => {
      const c = byId.get(f.id);
      return {
        id: f.id,
        name: c?.name ?? f.id,
        tier: '被硬过滤' as const,
        score: null,
        reason: f.reasons.join('；'),
        when_to_leave: c?.when_to_leave ?? '',
      };
    }),
    ...r.runnerUps.slice(0, 3).map((s) => {
      const c = byId.get(s.id);
      return {
        id: s.id,
        name: c?.name ?? s.id,
        tier: '差一点入选' as const,
        score: Math.round(s.score * 100) / 100,
        reason: `分数 ${s.score.toFixed(2)}，低于 Top2，但通过了全部硬过滤`,
        when_to_leave: c?.when_to_leave ?? '',
      };
    }),
  ];

  // 更轻的候选：组件数严格少于当前方案，且本身也通过了硬过滤。
  // 排序按组件数升序（最轻的排第一），不是按分数——"降档建议"要的是最轻，
  // 不是"次优但分数高"。H06 就是典型：C11 分数 4.10 高于 C12 的 3.70，
  // 但访谈里两个人都说"纯静态 + LocalStorage 就够"，要推的是 C12。
  const lighterCandidates = [r.top2, ...r.runnerUps]
    .filter((s) => s.componentCount < r.top1.componentCount)
    .sort((a, b) => (a.componentCount !== b.componentCount ? a.componentCount - b.componentCount : b.score - a.score))
    .slice(0, 2)
    .map((s) => {
      const c = byId.get(s.id);
      return {
        id: s.id,
        name: c?.name ?? s.id,
        one_liner: c?.one_liner ?? '',
        score: Math.round(s.score * 100) / 100,
        // 更轻 = 少东西 = 一定有代价。用它的第一条坑当代价说明，避免"只说好处"。
        tradeoff: c?.beginner_pitfalls?.[0] ?? '',
      };
    });

  // 推断出来的能力并进 required_capabilities 一起给（否则 LLM 会写"你不需要存数据"）
  const shownVector: Record<string, unknown> = { ...vector };
  if (r.inferred_capabilities.length) {
    const caps = Array.isArray(vector.required_capabilities) ? [...vector.required_capabilities] : [];
    shownVector.required_capabilities = [...caps, ...r.inferred_capabilities];
  }

  return {
    combo: {
      id: top.id,
      name: top.name,
      one_liner: top.one_liner,
      paradigm: top.paradigm,
      components: top.components as unknown as Record<string, string | null>,
      first_step: (top as any).first_step ?? '',
      first_step_minutes: (top as any).first_step_minutes ?? 15,
      when_to_leave: top.when_to_leave,
      beginner_pitfalls: top.beginner_pitfalls,
    },
    vector: shownVector,
    confidence: r.confidence,
    inferred: { capabilities: r.inferred_capabilities, evidence: r.inference_evidence },
    rejected,
    lighterCandidates,
  };
}

/** 去掉 ```json 围栏 / 前后解释性文字，只留最外层的 {...} */
export function extractJson(text: string): string | null {
  let t = String(text ?? '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return t.slice(start, end + 1);
}

export interface ExplainOptions {
  context: ExplainContext;
  provider: LLMProvider;
  /** 总尝试次数（含首次）。默认 2：一次失败带问题重试一次，再失败就兜底 */
  maxAttempts?: number;
}

/**
 * 生成解释包。永不抛错——最差情况返回 source='fallback' 的可用内容。
 * 这一点很重要：解释层是"锦上添花"，不能因为模型挂了就让整个产品不出结果。
 */
export async function explain({ context, provider, maxAttempts = 2 }: ExplainOptions): Promise<ExplainResult> {
  const started = Date.now();
  const allIssues: ValidationIssue[] = [];

  if (!provider.available()) {
    return {
      ok: true,
      pkg: buildFallback(context),
      source: 'fallback',
      attempts: 0,
      failure: { stage: 'transport', detail: `provider ${provider.name} 不可用：${provider.unavailableReason()}` },
      issues: [],
      latency_ms: Date.now() - started,
    };
  }

  const baseUser = buildUserPrompt(context);
  let user = baseUser;
  let usage: ExplainResult['usage'];
  let rawText: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let text: string;
    let stopReason: string | undefined;
    try {
      const res = await provider.complete({ system: SYSTEM_PROMPT, user, ctx: context });
      text = res.text;
      stopReason = res.stopReason;
      rawText = text;
      if (res.usage) usage = res.usage;
    } catch (e) {
      // 传输层错误（401 / 超时 / 网络）不值得重试：重试也是同样的结果
      return {
        ok: true,
        pkg: buildFallback(context),
        source: 'fallback',
        attempts: attempt,
        failure: { stage: 'transport', detail: String((e as Error)?.message ?? e).slice(0, 300) },
        issues: allIssues,
        usage,
        latency_ms: Date.now() - started,
      };
    }

    // 截断必须先于 JSON 解析判掉。否则报出来的是"JSON 语法错（Unexpected end of input）"，
    // 指向"模型不会写 JSON"，而真因是"输出长度到顶了"——两个完全不同的修法。
    if (stopReason === 'max_tokens') {
      allIssues.push({
        code: 'parse.truncated',
        field: '$',
        detail: `输出被 max_tokens 截断（output_tokens=${usage?.output_tokens ?? '?'}），末尾：「…${text.slice(-60)}」`,
      });
      user = `${baseUser}\n\n${buildRetryPrompt([
        { field: '$', detail: '上一次输出超出长度上限被截断。请把每条说明压到一句话内，并确保 JSON 完整闭合。' },
      ])}`;
      continue;
    }

    const json = extractJson(text);
    if (!json) {
      allIssues.push({ code: 'parse.no_json', field: '$', detail: `输出里找不到 JSON 对象：${text.slice(0, 80)}…` });
      user = `${baseUser}\n\n${buildRetryPrompt([{ field: '$', detail: '输出里找不到 JSON 对象，请只输出 JSON' }])}`;
      continue;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      allIssues.push({ code: 'parse.invalid_json', field: '$', detail: String((e as Error).message).slice(0, 160) });
      user = `${baseUser}\n\n${buildRetryPrompt([{ field: '$', detail: `JSON 解析失败：${String((e as Error).message).slice(0, 80)}` }])}`;
      continue;
    }

    const v = validate(parsed, context);
    if (v.ok) {
      return { ok: true, pkg: parsed, source: 'llm', attempts: attempt, issues: allIssues, usage, raw_text: rawText, latency_ms: Date.now() - started };
    }
    allIssues.push(...v.issues);
    user = `${baseUser}\n\n${buildRetryPrompt(v.issues)}`;
  }

  return {
    ok: true,
    pkg: buildFallback(context),
    source: 'fallback',
    attempts: maxAttempts,
    failure: { stage: 'validate', detail: `${maxAttempts} 次尝试均未通过校验` },
    issues: allIssues,
    usage,
    raw_text: rawText,
    latency_ms: Date.now() - started,
  };
}

/** 渲染成纯文本（M1 不做 SSE，先给一个能直接贴给人看的形态） */
export function renderText(pkg: ExplanationPackageLike): string {
  const L: string[] = [];
  L.push(`【一句话】${pkg.one_pager.headline}`);
  L.push(`【为什么】${pkg.one_pager.why}`);
  L.push(`【今晚第一步】${pkg.one_pager.first_step.action}（约 ${pkg.one_pager.first_step.minutes} 分钟）`);
  L.push('');
  L.push('【为什么不选那个】');
  for (const n of pkg.not_chosen) {
    L.push(`· ${n.what}：${n.why}`);
    L.push(`  什么时候回头看：${n.reconsider_when}`);
  }
  L.push('');
  L.push('【接下来三步】');
  pkg.next_three_steps.forEach((s, i) => {
    L.push(`${i + 1}. ${s.action}（约 ${s.minutes} 分钟）`);
    L.push(`   可能卡在：${s.blocker}`);
  });
  if (pkg.pitfalls.length) {
    L.push('');
    L.push('【新手最容易踩的坑】');
    for (const p of pkg.pitfalls) L.push(`· ${p.text}`);
  }
  if (pkg.lighter_alternative.needed) {
    L.push('');
    L.push(`【更轻的替代】${pkg.lighter_alternative.why}`);
  }
  return L.join('\n');
}

/** 只为 renderText 服务的最小结构约束 */
interface ExplanationPackageLike {
  one_pager: { headline: string; why: string; first_step: { action: string; minutes: number } };
  not_chosen: Array<{ what: string; why: string; reconsider_when: string }>;
  next_three_steps: Array<{ action: string; minutes: number; blocker: string }>;
  pitfalls: Array<{ text: string }>;
  lighter_alternative: { needed: boolean; why: string };
}
