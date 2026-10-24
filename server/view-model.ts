/**
 * 视图模型层：把「引擎结果 + 解释包」翻译成前端能直接渲染的结构。
 *
 * 为什么单独一层，而不是让前端直接吃 ExplanationPackage：
 *   1. `ExplanationPackage` 是**校验契约**的产物，字段设计服务于"能不能溯源"，
 *      不服务于"怎么展示"。两者混在一起，改 UI 就会碰校验字段。
 *   2. 三条 UI 决策（not_chosen 分组顺序 / source 字段不进 UI / confidence 三态）
 *      必须在一个地方实现，不能散在 HTML 模板和 JS 里——否则改一处漏一处。
 *   3. 这里做的是**纯函数**，可以被 test-guards 直接断言，不需要起浏览器。
 *
 * 三条硬规则（M3 用户裁决，2026-10-24）：
 *   ① not_chosen 先展示「差一点入选」（runnerUps），后展示「被硬过滤」（filteredOut）。
 *      用户更想知道"我是不是错过了更好的"，而不是"我避开了哪些坑"。
 *   ② `source_when_to_leave` **绝对不进 UI**。它是给校验器用的元数据，
 *      用户看到"离开条件"会困惑。本文件从结构上就不往 payload 里放它。
 *   ③ confidence 三态：
 *      high   → 正常渲染
 *      medium → 顶部黄色警告条，方案照常给
 *      low    → 阻断，只渲染追问表单（引擎的 rank() 已经返回 RankBlocked，不会走到解释层）
 */

import { COMPONENT_NAMES, SLOT_LABELS } from '../src/data/component-names.ts';
import type { Combo, RankBlocked, RankResult } from '../src/lib/scoring.ts';
import type { ExplanationPackage } from '../src/lib/explain/types.ts';

// ────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────

export interface UiComponent {
  slot: string;
  slotLabel: string;
  /** 人话名，如 "Next.js"；空槽位为 null */
  name: string | null;
  /** 组件 ID，只在"技术细节"折叠区展示，不放在主标题里 */
  id: string | null;
  role: string | null;
}

export interface UiMeta {
  combo_id: string;
  combo_name: string;
  one_liner: string;
  paradigm: string;
  components: UiComponent[];
  confidence: 'high' | 'medium' | 'low';
  /** medium 时的黄色警告条文案；high 时为 null */
  confidence_banner: string | null;
  coverage_status: string;
  coverage_warning: string | null;
  /** 引擎从原文推断出的隐性需求（如 data_persistence），必须透出依据 */
  inferred: { capabilities: string[]; evidence: string | null };
}

export interface UiNotChosenItem {
  combo_id: string;
  what: string;
  why: string;
  /** 已翻转的"何时回头看" */
  reconsider_when: string;
  /** 该候选的分数；被硬过滤的没有分数 */
  score: number | null;
  /** 被硬过滤时的排除原因（引擎给的） */
  filter_reason: string | null;
}

export interface UiNotChosenGroup {
  tier: 'runner_up' | 'filtered';
  /** UI 小标题 */
  title: string;
  /** 一句话解释这一组是什么，避免用户不知道"被硬过滤"是什么意思 */
  hint: string;
  items: UiNotChosenItem[];
}

export type UiModule =
  | { module: 'one_pager'; seq: number; payload: {
      headline: string;
      why: string;
      first_step: { action: string; minutes: number };
    } }
  | { module: 'not_chosen'; seq: number; payload: { groups: UiNotChosenGroup[] } }
  | { module: 'next_three_steps'; seq: number; payload: {
      steps: Array<{ index: number; action: string; minutes: number; blocker: string }>;
    } }
  | { module: 'pitfalls'; seq: number; payload: { items: string[] } }
  | { module: 'lighter_alternative'; seq: number; payload: {
      needed: boolean; combo_id: string | null; combo_name: string | null; why: string;
    } };

export interface UiPlan {
  kind: 'plan';
  meta: UiMeta;
  modules: UiModule[];
}

export interface UiBlocked {
  kind: 'blocked';
  reason: 'uncovered' | 'low_confidence' | 'insufficient_candidates';
  title: string;
  message: string;
  /** 可以直接渲染成表单的追问；uncovered / insufficient 时为空 */
  questions: string[];
  suggested_fields: string[];
  coverage_status: string;
  confidence: 'high' | 'medium' | 'low';
}

export type UiPayload = UiPlan | UiBlocked;

// ────────────────────────────────────────────────────────────
// 组装
// ────────────────────────────────────────────────────────────

function componentsOf(c: Combo): UiComponent[] {
  const order = ['fe', 'be', 'db', 'ai', 'deploy'];
  return order.map((slot) => {
    const id = (c.components as Record<string, string | undefined>)[slot] ?? null;
    const meta = id ? COMPONENT_NAMES[id] : undefined;
    return {
      slot,
      slotLabel: SLOT_LABELS[slot] ?? slot,
      name: id ? (meta?.name ?? id) : null,
      id,
      role: meta?.role ?? null,
    };
  });
}

/**
 * 不选清单分组：**runnerUps 在前，filteredOut 在后**（UI 决策 ①）。
 *
 * 分组依据来自 rank() 的原始结果，不是 LLM 的输出顺序——
 * LLM 只决定"提哪几条"，不决定"怎么归类"。否则模型换个顺序就能改 UI 结构。
 */
function groupNotChosen(
  pkg: ExplanationPackage,
  r: RankResult,
): UiNotChosenGroup[] {
  const scoreById = new Map<string, number>();
  for (const s of [r.top1, r.top2, ...r.runnerUps]) scoreById.set(s.id, s.score);
  const filterReasonById = new Map(r.filteredOut.map((f) => [f.id, f.reasons.join('；')]));

  const toItem = (n: ExplanationPackage['not_chosen'][number]): UiNotChosenItem => ({
    combo_id: n.combo_id,
    what: n.what,
    why: n.why,
    reconsider_when: n.reconsider_when,
    score: scoreById.has(n.combo_id) ? Math.round((scoreById.get(n.combo_id) as number) * 100) / 100 : null,
    filter_reason: filterReasonById.get(n.combo_id) ?? null,
    // 注意：这里**没有** source_when_to_leave。UI 决策 ② —— 结构性排除，
    // 不是"忘了写"，所以以后加字段也不会顺手把它带进来。
  });

  const near: UiNotChosenItem[] = [];
  const filtered: UiNotChosenItem[] = [];
  for (const n of pkg.not_chosen) {
    // 归类只认引擎的分档；两边都查不到说明数据不一致，归到 filtered 并保留原因
    if (scoreById.has(n.combo_id) && !filterReasonById.has(n.combo_id)) near.push(toItem(n));
    else filtered.push(toItem(n));
  }

  const groups: UiNotChosenGroup[] = [];
  if (near.length) {
    groups.push({
      tier: 'runner_up',
      title: '差一点入选',
      hint: '这些方案通过了全部硬性筛选，只是分数低一点。你如果更看重它们的长处，可以换。',
      items: near,
    });
  }
  if (filtered.length) {
    groups.push({
      tier: 'filtered',
      title: '被硬性条件排除',
      hint: '这些方案和你的硬性要求冲突（比如没有数据库、语言不匹配），不是"差一点"，是不适用。',
      items: filtered,
    });
  }
  return groups;
}

/**
 * 字段名的中文映射。
 *
 * 引擎的 confidence_warning 里写的是 schema 字段名（timeline_weeks / expected_users…），
 * 那是给开发和报表看的。直接怼到用户脸上等于让用户读代码。
 * 映射放在视图层做，不改引擎——引擎的文案还要用于日志对齐和 D1 指标复算。
 */
const FIELD_CN: Record<string, string> = {
  delivery: '交付形态',
  team_size: '团队规模',
  ai_workflow: 'AI 参与方式',
  timeline_weeks: '上线时间',
  budget_cny_month: '预算',
  expected_users: '预计用户量',
  required_capabilities: '需要的能力',
  compliance: '合规要求',
  goal_type: '做这个的目标',
};

function localizeFields(text: string): string {
  return text.replace(/\b(delivery|team_size|ai_workflow|timeline_weeks|budget_cny_month|expected_users|required_capabilities|compliance|goal_type)\b/g,
    (m) => FIELD_CN[m] ?? m);
}

/**
 * medium 的警告条文案（UI 决策 ③）。
 *
 * 注意这里用句号断开，不用括号包住引擎文案——
 * 引擎文案自身带一层括号（"补充信息缺 3 项（a、b、c）"），再包一层就变成
 * "还不够完整（补充信息缺 3 项（a、b、c），补上就会更准）"，读起来像嵌套函数调用。
 */
export function buildConfidenceBanner(r: RankResult): string | null {
  if (r.confidence !== 'medium') return null;
  // 中文化之后补两个冒号：引擎原文是「关键信息缺 required_capabilities」，
  // 换成中文变成「关键信息缺 需要的能力」，两个字面中文挤在一起读起来像病句。
  // 只在这两个固定前缀上补，不做通用正则——通用替换会把「补充信息缺 3 项（…）」也改坏。
  const detail = r.confidence_warning
    ? `${localizeFields(r.confidence_warning).replace('关键信息缺 ', '关键信息缺：').replace('优先补 ', '优先补：')}。`
    : '';
  return `注意：你提供的信息还不够完整。${detail}该方案仅供参考，建议补充信息后重跑。`;
}

/**
 * 方案身份 + confidence 三态。
 *
 * 单独抽出来，是因为它**只依赖 rank 结果**、不依赖解释包——
 * SSE 里 meta 必须早于模型返回就发出去，让用户先知道"引擎选了哪套、要不要打警告条"。
 * 如果硬塞进 buildPlanPayload，服务端就得先造一份假 pkg 才能拿 meta，
 * 那种"占位数据"迟早会被误当成真数据渲染出去。
 */
export function buildMeta(r: RankResult, combos: Combo[]): UiMeta {
  const combo = combos.find((c) => c.id === r.top1.id);
  if (!combo) throw new Error(`top1 ${r.top1.id} 不在闭集里`);
  return {
    combo_id: combo.id,
    combo_name: combo.name,
    one_liner: combo.one_liner,
    paradigm: combo.paradigm,
    components: componentsOf(combo),
    confidence: r.confidence,
    confidence_banner: buildConfidenceBanner(r),
    coverage_status: r.coverage_status,
    coverage_warning: r.coverage_warning ?? null,
    inferred: {
      capabilities: r.inferred_capabilities,
      evidence: r.inference_evidence ?? null,
    },
  };
}

export function buildPlanPayload(r: RankResult, pkg: ExplanationPackage, combos: Combo[]): UiPlan {
  const lighterCombo = pkg.lighter_alternative.combo_id
    ? combos.find((c) => c.id === pkg.lighter_alternative.combo_id)
    : null;

  const meta = buildMeta(r, combos);

  const modules: UiModule[] = [
    {
      module: 'one_pager',
      seq: 1,
      payload: {
        headline: pkg.one_pager.headline,
        why: pkg.one_pager.why,
        first_step: pkg.one_pager.first_step,
      },
    },
    {
      module: 'not_chosen',
      seq: 2,
      payload: { groups: groupNotChosen(pkg, r) },
    },
    {
      module: 'next_three_steps',
      seq: 3,
      payload: {
        steps: pkg.next_three_steps.map((s, i) => ({
          index: i + 1,
          action: s.action,
          minutes: s.minutes,
          blocker: s.blocker,
        })),
      },
    },
    {
      module: 'pitfalls',
      seq: 4,
      payload: { items: pkg.pitfalls.map((p) => p.text) },
    },
    {
      module: 'lighter_alternative',
      seq: 5,
      payload: {
        needed: pkg.lighter_alternative.needed,
        combo_id: pkg.lighter_alternative.combo_id,
        combo_name: lighterCombo?.name ?? null,
        why: pkg.lighter_alternative.why,
      },
    },
  ];

  return { kind: 'plan', meta, modules };
}

/** 阻断态（UI 决策 ③ 的 low 分支 + 超出范围 + 候选不足） */
export function buildBlockedPayload(r: RankBlocked): UiBlocked {
  const titles: Record<RankBlocked['reason'], string> = {
    uncovered: '这个场景目前不在我的能力范围内',
    low_confidence: '信息还不够，我先不给方案',
    insufficient_candidates: '你的要求之间互相冲突，筛不出两套方案',
  };
  const messages: Record<RankBlocked['reason'], string> = {
    uncovered:
      '我能给的是 Web / 小程序 / 自部署这三类形态的架构方案。桌面客户端、命令行工具、浏览器插件这些我没有对应模板，硬给会误导你。',
    low_confidence:
      '下面几个问题决定了方案的主心骨（交付形态、你的语言基础、需要哪些能力）。答完再跑一次，结果会靠谱得多。',
    insufficient_candidates:
      '按当前条件过滤后剩下的方案不足两套。可以放宽其中一条约束（比如预算或用户量）再试。',
  };
  return {
    kind: 'blocked',
    reason: r.reason,
    title: titles[r.reason],
    message: messages[r.reason],
    questions: r.questions,
    suggested_fields: r.suggested_fields,
    coverage_status: r.coverage_status,
    confidence: r.confidence,
  };
}
