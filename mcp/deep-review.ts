/**
 * deep_architecture_review 的核心逻辑（v3.1.0）——「降维法庭」。
 * ------------------------------------------------------------------
 * 对 12 套闭集装不下的复杂需求，提供多视角对抗式评审。与被封存的
 * scripts/experimental/debate-court.ts（五角色三阶段 Mailbox）相比刻意降维：
 *
 *   Phase 1  并发盲评（禁止通信）：3 个视角同时独立评估——成本 / 性能 / 开发速度，
 *            每路 12s 超时，单路失败不炸整体；
 *   Phase 2  红队挑刺（单次）：只看三份盲评找**矛盾点**与盲区，8s 超时；
 *   Phase 3  Lead 裁决：强约束输出结构化 JSON，10s 超时；解析失败降级为
 *            "渲染已有材料"，绝不让乱 JSON 崩掉工具。
 *
 * 最长串行 ≈ 30s，卡在宿主超时边缘内；任何阶段超时都带"当前进度"降级返回。
 *
 * 【与闭集的关系】
 *   - Lead 只允许在给出 combo_id 时引用闭集（本地二次校验，不信模型自报）；
 *   - 闭集外的裁决**不写回 combos.json**，落盘 src/data/candidates-pending/
 *     deep-review-<ts>.json 作为未来扩集的人工评审材料；
 *   - 渲染由 render.ts 的纯函数完成，本模块不产出任何面向用户的排版。
 *
 * 【费用与耗时】多路模型调用，工具 description 明示"约 30 秒、产生额外费用，
 * 常规选型请用 recommend_stack"。无 key 时 handler 直接 isError，不走降级渲染。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Combo } from '../src/lib/scoring.ts';
import { extractJson } from '../src/lib/explain/index.ts';
import type { LLMProvider } from '../src/lib/explain/provider.ts';
import { AI_GENERATION_DISCIPLINE } from '../src/lib/explain/bootstrap.ts';

export interface DeepReviewInput {
  raw_input: string;
}

export interface DeepReviewPerspective {
  angle: string;
  payload: { verdict: string; top_risks: string[] } | null;
  degraded?: string;
}

export interface DeepReviewVerdict {
  headline: string;
  recommended_stack: Array<{ layer: string; choice: string; reason: string }>;
  red_team_warnings: string[];
  plan_b: { trigger: string; fallback: string };
  open_questions: string[];
  combo_id: string | null;
}

export interface DeepReviewResult {
  ok: boolean;
  perspectives: DeepReviewPerspective[];
  redTeam: { contradictions: string[]; blind_spots: string[] } | null;
  verdict: DeepReviewVerdict | null;
  /** Lead 输出无法解析时的原文（降级渲染用，正常为 null） */
  rawVerdictText: string | null;
  degraded: string[];
  elapsed_ms: number;
  in_closed_set: boolean;
  combo: Combo | null;
  candidatesPath: string | null;
  discipline: string[];
}

/** 单个 Promise 的超时竞速；超时抛 TimeoutError，由调用方降级 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`__timeout_${ms}`)), ms)),
  ]);
}

function safeJson(text: string): any | null {
  const json = extractJson(text);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const PERSPECTIVES: Array<{ angle: string; focus: string }> = [
  { angle: '成本视角', focus: '服务器/托管费用、免费额度、隐性成本（带宽、构建时长、第三方服务）。预算敏感的取舍优先。' },
  { angle: '性能视角', focus: '并发模型、冷启动、数据一致性、实时协作的可扩展路径。瓶颈在哪、什么时候会撞墙。' },
  { angle: '开发速度视角', focus: 'AI 辅助开发的一次生成成功率、生态语料厚度、脚手架到上线的步数。' },
];

function perspectivePrompt(rawInput: string, focus: string): { system: string; user: string } {
  return {
    system:
      `你是架构评审的独立视角，只从你的维度评估，不全面权衡。规则：结论必须指向具体机制，禁止空泛形容词；` +
      `输出 JSON：{"verdict": "本维度结论 40-80 字", "top_risks": ["该维度最大风险 1-2 条, 每条 15-40 字"]}。只输出 JSON。`,
    user: `需求：${rawInput}\n\n你的评估维度：${focus}`,
  };
}

function redTeamPrompt(rawInput: string, perspectives: DeepReviewPerspective[]): { system: string; user: string } {
  const digest = perspectives
    .map((p) => `【${p.angle}】${JSON.stringify(p.payload)}`)
    .join('\n\n');
  return {
    system:
      '你是红队，任务是找出三份独立评审之间的**矛盾点**与共同盲区。规则：只针对已给出的材料，不引入新事实；' +
      '矛盾点要指出"谁与谁冲突、冲突在哪"；输出 JSON：{"contradictions": ["…"], "blind_spots": ["…"]}。只输出 JSON。',
    user: `需求：${rawInput}\n\n三份盲评：\n${digest}`,
  };
}

function leadPrompt(rawInput: string, perspectives: DeepReviewPerspective[], redTeam: DeepReviewResult['redTeam'], comboIds: string): { system: string; user: string } {
  const materials = [
    ...perspectives.map((p) => `【${p.angle}】${JSON.stringify(p.payload)}`),
    `【红队】${JSON.stringify(redTeam)}`,
  ].join('\n\n');
  return {
    system:
      '你是 Lead 架构法官，不参与辩论，只综合材料做最终裁决。规则：' +
      '1. 不要长篇大论，每个字段短而实；2. red_team_warnings 必须吸收红队的矛盾点，不许和稀泥；' +
      '3. recommended_stack 的每一层都要给理由；4. combo_id 只能从给定闭集列表选，闭集装不下就填 null——不许编造 ID；' +
      '5. 输出 JSON：{"headline": "一句话结论≤40字", "recommended_stack": [{"layer": "层名", "choice": "选什么", "reason": "为什么"}], ' +
      '"red_team_warnings": ["…"], "plan_b": {"trigger": "什么情况下推翻", "fallback": "换什么"}, "open_questions": ["还需要向用户确认什么"], "combo_id": "CXX 或 null"}。只输出 JSON。',
    user: `需求：${rawInput}\n\n全部材料：\n${materials}\n\n可选 combo_id：${comboIds}`,
  };
}

export async function runDeepReview(
  input: DeepReviewInput,
  deps: { provider: LLMProvider; combos: Combo[] },
): Promise<DeepReviewResult> {
  const started = Date.now();
  const rawInput = String(input.raw_input ?? '').trim();
  // 运行时兜底：调用方漏传 combos 时按空闭集处理（全部走 candidates 路径），不抛 ReferenceError
  const combos = deps.combos ?? [];
  const degraded: string[] = [];
  const perspectives: DeepReviewPerspective[] = [];
  let redTeam: DeepReviewResult['redTeam'] = null;
  let verdict: DeepReviewVerdict | null = null;
  let rawVerdictText: string | null = null;
  let candidatesPath: string | null = null;

  const ask = async (p: { system: string; user: string }) => {
    const res = await deps.provider.complete(p);
    return res.text;
  };

  // ── Phase 1：并发盲评（禁止通信，单路 12s）──
  await Promise.all(
    PERSPECTIVES.map(async ({ angle, focus }) => {
      const { system, user } = perspectivePrompt(rawInput, focus);
      try {
        const payload = safeJson(await withTimeout(ask({ system, user }), 12_000));
        if (payload?.verdict) {
          perspectives.push({ angle, payload: { verdict: String(payload.verdict).slice(0, 200), top_risks: (payload.top_risks ?? []).map(String).slice(0, 3) } });
        } else {
          perspectives.push({ angle, payload: null, degraded: '输出不可解析' });
          degraded.push(`${angle}：输出不可解析，已降级`);
        }
      } catch (e) {
        perspectives.push({ angle, payload: null, degraded: String((e as Error)?.message ?? e).includes('timeout') ? '超时' : '调用失败' });
        degraded.push(`${angle}：${String((e as Error)?.message ?? e).includes('timeout') ? '超时' : '调用失败'}，已降级`);
      }
    }),
  );

  const usable = perspectives.filter((p) => p.payload);
  if (usable.length > 0) {
    // ── Phase 2：红队挑刺（单次，8s）──
    try {
      const { system, user } = redTeamPrompt(rawInput, perspectives);
      redTeam = safeJson(await withTimeout(ask({ system, user }), 8_000));
      if (!redTeam) degraded.push('红队：输出不可解析，已降级');
    } catch (e) {
      degraded.push(`红队：${String((e as Error)?.message ?? e).includes('timeout') ? '超时' : '调用失败'}，已降级`);
    }

    // ── Phase 3：Lead 裁决（10s，强约束 JSON；解析失败降级为渲染原文）──
    try {
      const { system, user } = leadPrompt(rawInput, perspectives, redTeam, combos.map((c) => c.id).join(' / '));
      rawVerdictText = await withTimeout(ask({ system, user }), 10_000);
      const parsed = safeJson(rawVerdictText ?? '');
      if (parsed?.headline && Array.isArray(parsed.recommended_stack)) {
        verdict = {
          headline: String(parsed.headline).slice(0, 60),
          recommended_stack: (parsed.recommended_stack ?? []).slice(0, 6).map((r: any) => ({
            layer: String(r?.layer ?? '').slice(0, 20),
            choice: String(r?.choice ?? '').slice(0, 60),
            reason: String(r?.reason ?? '').slice(0, 120),
          })),
          red_team_warnings: (parsed.red_team_warnings ?? []).map(String).slice(0, 5),
          plan_b: {
            trigger: String(parsed.plan_b?.trigger ?? '').slice(0, 120),
            fallback: String(parsed.plan_b?.fallback ?? '').slice(0, 120),
          },
          open_questions: (parsed.open_questions ?? []).map(String).slice(0, 4),
          combo_id: typeof parsed.combo_id === 'string' ? parsed.combo_id.toUpperCase() : null,
        };
      } else {
        degraded.push('Lead：裁决 JSON 不可解析，按原始材料降级渲染');
      }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        const at = ((e as Error)?.stack ?? '').split('\n')[1]?.trim().slice(0, 140) ?? '';
        degraded.push(`Lead：${msg.includes('__timeout') ? '超时' : `调用失败: ${msg.slice(0, 100)}`}，按当前最优降级返回 [${at}]`);
      }
  }

  // ── 闭集判定（本地二次校验，不信模型自报）──
  let inClosedSet = false;
  let combo: Combo | null = null;
  if (verdict?.combo_id) {
    combo = deps.combos.find((c) => c.id === verdict!.combo_id) ?? null;
    inClosedSet = Boolean(combo);
  }

  // ── 闭集外：落盘候选（人工评审材料，绝不写回 combos.json）──
  if (verdict && !inClosedSet) {
    try {
      const dir = resolve(import.meta.dirname, '..', 'src', 'data', 'candidates-pending');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const path = join(dir, `deep-review-${Date.now()}.json`);
      writeFileSync(
        path,
        JSON.stringify({ generated_at: new Date().toISOString(), raw_input: rawInput, verdict, perspectives, red_team: redTeam }, null, 2) + '\n',
        'utf8',
      );
      candidatesPath = path;
    } catch {
      degraded.push('候选落盘失败（不影响评审输出）');
    }
  }

  return {
    ok: Boolean(verdict) || usable.length > 0,
    perspectives,
    redTeam,
    verdict,
    rawVerdictText: verdict ? null : rawVerdictText,
    degraded,
    elapsed_ms: Date.now() - started,
    in_closed_set: inClosedSet,
    combo,
    candidatesPath,
    discipline: AI_GENERATION_DISCIPLINE,
  };
}
