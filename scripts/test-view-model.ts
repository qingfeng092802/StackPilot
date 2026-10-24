/**
 * 视图模型回归测试：把 M3 的三个 UI 决策钉成断言。
 *
 * 为什么单独一个文件：`test-guards.ts` 管的是**事实层**（LLM 有没有编），
 * 这里管的是**展示层**（三个 UI 决策有没有被改掉）。两者失败的含义完全不同，
 * 混在一起时，一条红色断言分不清"模型编了"还是"页面串了"。
 *
 * 用法：npx tsx scripts/test-view-model.ts
 */

import { readFileSync } from 'node:fs';
import combosRaw from '../src/data/combos.json' with { type: 'json' };
import { rank } from '../src/lib/scoring.ts';
import type { Combo, ConstraintVector } from '../src/lib/scoring.ts';
import type { ExplanationPackage } from '../src/lib/explain/types.ts';
import { buildBlockedPayload, buildConfidenceBanner, buildMeta, buildPlanPayload } from '../server/view-model.ts';

const combos = (combosRaw as any).combos as Combo[];
const holdout = JSON.parse(readFileSync(new URL('../tests/d1-holdout.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../tests/fixtures/plan-H06.json', import.meta.url), 'utf8')) as ExplanationPackage;

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `｜${extra}` : ''}`); }
}

const h06 = holdout.cases.find((c: any) => c.id === 'H06');
const VEC_MEDIUM: ConstraintVector = h06.blind_constraint_vector;
const VEC_HIGH: ConstraintVector = { ...VEC_MEDIUM, timeline_weeks: 8, budget_cny_month: 0, expected_users: 200 } as ConstraintVector;
const VEC_LOW: ConstraintVector = {
  delivery: 'web', team_size: '1', skills: null, timeline_weeks: null,
  budget_cny_month: null, expected_users: null, required_capabilities: null,
  compliance: null, goal_type: null,
} as ConstraintVector;

const RAW = h06.raw_input;

function planFor(vec: ConstraintVector) {
  const r = rank(combos, vec, { raw_input: RAW });
  if (!r.ok) throw new Error('预期出方案，实际被阻断：' + r.reason);
  return { r, plan: buildPlanPayload(r, pkg, combos) };
}

// ────────────────────────────────────────────────────────────
console.log('\n[决策 ①] not_chosen：先「差一点入选」，后「被硬性条件排除」');
{
  const { r, plan } = planFor(VEC_MEDIUM);
  const mod = plan.modules.find((m) => m.module === 'not_chosen')!;
  const groups = (mod.payload as any).groups as Array<{ tier: string; items: any[] }>;

  ok('第一组是 runner_up', groups[0]?.tier === 'runner_up', JSON.stringify(groups.map((g) => g.tier)));
  ok('如果两组都存在，filtered 一定在后面',
    groups.length < 2 || groups.findIndex((g) => g.tier === 'filtered') > groups.findIndex((g) => g.tier === 'runner_up'),
    JSON.stringify(groups.map((g) => g.tier)));

  // 组内条目必须真的属于该档：runner_up 的分数来自 rank，filtered 的有硬过滤原因
  const near = groups.find((g) => g.tier === 'runner_up');
  if (near) {
    const runnerIds = new Set(r.runnerUps.map((s) => s.id));
    ok('runner_up 组里的 combo 都在 rank.runnerUps 里', near.items.every((i) => runnerIds.has(i.combo_id)),
      near.items.map((i) => i.combo_id).join(','));
    ok('runner_up 组每一条都有分数', near.items.every((i) => typeof i.score === 'number'));
  }
  const filtered = groups.find((g) => g.tier === 'filtered');
  if (filtered) {
    const fIds = new Set(r.filteredOut.map((f) => f.id));
    ok('filtered 组里的 combo 都在 rank.filteredOut 里', filtered.items.every((i) => fIds.has(i.combo_id)),
      filtered.items.map((i) => i.combo_id).join(','));
    ok('filtered 组每一条都有硬过滤原因', filtered.items.every((i) => Boolean(i.filter_reason)));
  }

  // 不丢条目：LLM 给了几条，UI 就必须渲染几条
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  ok('not_chosen 条目一条不丢', total === pkg.not_chosen.length, `${total} vs ${pkg.not_chosen.length}`);
}

// ────────────────────────────────────────────────────────────
console.log('\n[决策 ②] source_when_to_leave 绝对不进 UI');
{
  const { plan } = planFor(VEC_MEDIUM);
  const json = JSON.stringify(plan);
  ok('payload 里没有 source_when_to_leave 这个键', !json.includes('source_when_to_leave'));
  // 兜底断言：原始 when_to_leave 原文也不能出现在任何渲染字段里
  const wtl = combos.find((c) => c.id === 'C11')!.when_to_leave!;
  ok('when_to_leave 原文没有被当成展示文案漏出去', !json.includes(wtl), wtl.slice(0, 30));
  // 但翻转后的 reconsider_when 必须在
  const mod = plan.modules.find((m) => m.module === 'not_chosen')!;
  const items = (mod.payload as any).groups.flatMap((g: any) => g.items);
  ok('翻转后的 reconsider_when 仍然渲染', items.every((i: any) => typeof i.reconsider_when === 'string' && i.reconsider_when.length > 0));
}

// ────────────────────────────────────────────────────────────
console.log('\n[决策 ③] confidence 三态');
{
  // high：没有警告条
  const hi = planFor(VEC_HIGH);
  ok('high 时没有 confidence 警告条', hi.plan.meta.confidence === 'high' && hi.plan.meta.confidence_banner === null);

  // medium：黄色警告条，含用户指定的句式
  const md = planFor(VEC_MEDIUM);
  ok('medium 时 confidence 是 medium', md.plan.meta.confidence === 'medium');
  ok('medium 有警告条', typeof md.plan.meta.confidence_banner === 'string' && md.plan.meta.confidence_banner.length > 0);
  ok('警告条含用户指定句式', (md.plan.meta.confidence_banner ?? '').includes('该方案仅供参考，建议补充信息后重跑'));
  ok('警告条说清缺什么（中文）', /上线时间|预算|预计用户量|语言基础|需要的能力/.test(md.plan.meta.confidence_banner ?? ''),
    md.plan.meta.confidence_banner ?? '');
  ok('警告条不暴露英文字段名', !/timeline_weeks|budget_cny_month|expected_users/.test(md.plan.meta.confidence_banner ?? ''),
    md.plan.meta.confidence_banner ?? '');

  // low：直接阻断，只给追问表单
  const low = rank(combos, VEC_LOW, { raw_input: RAW });
  ok('low 时 rank 不出方案', low.ok === false && low.reason === 'low_confidence', JSON.stringify((low as any).reason));
  const blocked = buildBlockedPayload(low as any);
  ok('阻断态带追问问题', blocked.questions.length > 0, `${blocked.questions.length} 条`);
  ok('阻断态带 suggested_fields（前端要靠它建表单）', blocked.suggested_fields.length > 0, blocked.suggested_fields.join(','));
  ok('阻断态没有方案内容（不含 modules）', !('modules' in (blocked as any)));
  ok('阻断态标题说明"先不给方案"', blocked.title.includes('不给方案'), blocked.title);

  // 反向：high / medium 时绝不能出现阻断
  ok('high 时不会阻断', (rank(combos, VEC_HIGH, { raw_input: RAW }) as any).ok === true);
}

// ────────────────────────────────────────────────────────────
console.log('\n[附带] 警告条文案不嵌套括号、不重复');
{
  const r = rank(combos, VEC_MEDIUM, { raw_input: RAW }) as any;
  const banner = buildConfidenceBanner(r)!;
  const open = (banner.match(/（/g) ?? []).length;
  const close = (banner.match(/）/g) ?? []).length;
  ok('括号成对', open === close, `${open} 开 ${close} 闭`);
  ok('没有嵌套括号', !/（[^（）]*（/.test(banner), banner);
}

// ────────────────────────────────────────────────────────────
console.log('\n[附带] meta 只依赖 rank，不依赖解释包');
{
  const r = rank(combos, VEC_MEDIUM, { raw_input: RAW });
  if (!r.ok) throw new Error('预期出方案');
  const a = buildMeta(r, combos);
  const b = buildMeta(r, combos);
  ok('同一输入两次构建结果一致（纯函数）', JSON.stringify(a) === JSON.stringify(b));
  ok('meta 含组件槽位与显示名', a.components.length === 5 && a.components.every((c) => c.slotLabel));
  ok('推断依据透出（data_persistence 的原文证据）',
    a.inferred.capabilities.includes('data_persistence') && Boolean(a.inferred.evidence),
    JSON.stringify(a.inferred));
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
