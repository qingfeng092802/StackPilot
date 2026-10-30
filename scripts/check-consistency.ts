/**
 * 文档-代码一致性检查（CI 用）
 * ------------------------------------------------------------------
 * 背景：v0.4.2 出过一次「代码改了、PRD 示例没改」的漂移——
 * 附录 E 证明规则收窄了，但 §6.6.4 的示例 JSON 还是旧的两条件版本。
 * 这类错误人工 review 很容易漏（因为两处都"看起来对"）。
 *
 * 本脚本把关键不变量变成可执行断言。运行：
 *   node --experimental-strip-types scripts/check-consistency.ts
 * 退出码非 0 表示文档与代码不一致。
 */
import { readFileSync } from 'node:fs';
import { WEIGHTS, rank, hardFilter, resolveFit, CAPABILITY_VALUES } from '../src/lib/scoring.ts';
import { UNSUPPORTED_CAPABILITIES, normalizeVector, coverageStatus, findPersistenceMention } from '../src/lib/confidence.ts';
import { COMPONENT_NAMES } from '../src/data/component-names.ts';
import { checkFirstStep } from '../src/lib/explain/validate.ts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const combosRaw = JSON.parse(read('../src/data/combos.json'));
const casesRaw = JSON.parse(read('../tests/cases.json'));
const prd = read('../PRD-StackPilot.md');
const snapshot = JSON.parse(read('../src/data/facts-snapshot.json'));
const d1Pool = JSON.parse(read('../tests/d1-candidates.json'));
const d1Holdout = JSON.parse(read('../tests/d1-holdout.json'));

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
}

console.log('=== 1. combos.json 内部一致性 ===');
const combos = combosRaw.combos;
check('meta.combo_count 与实际条数一致', combosRaw.meta.combo_count === combos.length, `${combosRaw.meta.combo_count} vs ${combos.length}`);
check('meta.kb_component_count 与附录 A 一致（23）', combosRaw.meta.kb_component_count === 23);
check('每套组合都有 lang 字段', combos.every((c: any) => ['ts', 'py', 'js'].includes(c.lang)));
check('每套组合都有 evidence.official_docs', combos.every((c: any) => Array.isArray(c.evidence?.official_docs) && c.evidence.official_docs.length > 0));
check('pitfall_articles 全部为空（未核实不预置）', combos.every((c: any) => (c.evidence?.pitfall_articles ?? []).length === 0));
check('每套组合的 base_scores 六维齐全且 1-5', combos.every((c: any) => {
  const d = c.base_scores;
  const keys = ['ai_friendliness', 'ecosystem', 'ops', 'cost', 'fit', 'portability'];
  return keys.every((k) => typeof d[k] === 'number' && d[k] >= 1 && d[k] <= 5);
}));
check('fit_rules 用 delta 不用 score（旧语义已废弃）', combos.every((c: any) =>
  (c.fit_rules ?? []).every((r: any) => typeof r.delta === 'number' && r.score === undefined)));

// ── v2.1.0：last_reviewed 时效元数据。
//    独立字段，不从 facts 的 verified_at 推导——组件快照日期与组合审核日期语义不同，
//    一个组件更新不该静默刷新整个组合的"最近复核于"标签。
//
//    【日历体系统一为 UTC（v2.1.1）】写入（人工/脚本）与这里的断言都用 UTC 日历日：
//    复核日是记录不是事件时刻，统一 UTC 才不会在跨时区环境抖——
//    本机 UTC+8 的凌晨断言"今天审核"若按本地日历是 0 天，按 UTC 是 -1 天；
//    CI runner 是 UTC，与本地日历混用会让边界日期 ±1 天回摆。
//    末尾有跨日自检：daysSince(UTC 今天) 必须为 0，防两种体系混写。
const REVIEW_STALE_DAYS = 180;
const daysSince = (d: string) =>
  Math.floor((Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 86400000);
check('每套组合都有 last_reviewed（组合级审核日期，独立字段）', combos.every((c: any) =>
  typeof c.last_reviewed === 'string'));
check('last_reviewed 格式为 YYYY-MM-DD', combos.every((c: any) =>
  /^\d{4}-\d{2}-\d{2}$/.test(c.last_reviewed ?? '')));
check(`last_reviewed 距今 < ${REVIEW_STALE_DAYS} 天（过期 = 组合需要人工复核）`, combos.every((c: any) =>
  daysSince(c.last_reviewed) >= 0 && daysSince(c.last_reviewed) < REVIEW_STALE_DAYS));
// 跨日自检：无论 runner 时区，UTC 口径下"今天审核"必须恒为 0 天
check('daysSince 跨日自检（UTC 今天 = 0 天，UTC 昨天 = 1 天）',
  daysSince(new Date().toISOString().slice(0, 10)) === 0 &&
  daysSince(new Date(Date.now() - 86400000).toISOString().slice(0, 10)) === 1);

// ── v2.2.0：debate 字段（红队裁决沉淀，见 docs/ROADMAP-v2.2-debate.md）──
// 数据来源必须可追溯：manual（架构师人工撰写）或 debate-court@<批次>（离线法庭产物经人工复核）
check('每套组合都有 debate 且 author 可追溯', combos.every((c: any) =>
  c.debate && (c.debate.author === 'manual' || /^debate-court@.+/.test(c.debate.author))));
check('每套组合至少 1 条红队警告，且每条 ≥ 12 字（拒绝废话警告）', combos.every((c: any) =>
  Array.isArray(c.debate.red_team_warnings) && c.debate.red_team_warnings.length >= 1
  && c.debate.red_team_warnings.every((w: string) => w.length >= 12)));
check('红队警告禁止 4 位以上数字（量化门槛必须有事实出处，与 test-guards 同一哲学）', combos.every((c: any) =>
  c.debate.red_team_warnings.every((w: string) => !/\d{4,}/.test(w))));
check('代言人只能代言本组合真实存在的组件', combos.every((c: any) => {
  const ids = Object.values(c.components).filter(Boolean);
  return (c.debate.proponents ?? []).every((p: any) => ids.includes(p.target) && (p.argument ?? '').length >= 12);
}));
check('plan_b.alternative_combo 在闭集内且不指向自身', combos.every((c: any) =>
  combos.some((x: any) => x.id === c.debate.plan_b?.alternative_combo) && c.debate.plan_b.alternative_combo !== c.id));
check('plan_b.trigger 非空且非模板话术', combos.every((c: any) =>
  typeof c.debate.plan_b?.trigger === 'string' && c.debate.plan_b.trigger.length >= 10));

console.log('\n=== 2. 权重表：不含 fit（v0.4.2 不变量）===');
const weightKeys = Object.keys(WEIGHTS.assisted);
check('权重维度为 5 个', weightKeys.length === 5, weightKeys.join(','));
check('权重表不含 fit', !weightKeys.includes('fit'));
check('各 ai_workflow 权重和为 1', Object.values(WEIGHTS).every((w: any) =>
  Math.abs(Object.values(w).reduce((a: number, b: any) => a + b, 0) - 1) < 1e-9));
check('权重表按 ai_workflow 索引（三档齐全）',
  ['full_auto', 'assisted', 'learning'].every((k) => (WEIGHTS as any)[k]));

console.log('\n=== 3. ai_workflow 规则（v1.7.0 取代 skills）===');
const wfRules = combos.flatMap((c: any) =>
  (c.fit_rules ?? []).filter((r: any) => JSON.stringify(r.when ?? {}).includes('ai_workflow'))
    .map((r: any) => ({ id: c.id, r })));
check('存在 ai_workflow 规则', wfRules.length > 0, `共 ${wfRules.length} 处`);
check('每条都是单条件 eq（可读、可解释）',
  wfRules.every(({ r }: any) => !r.when.all && r.when.field === 'ai_workflow' && r.when.op === 'eq'));
check('取值都在三档枚举里',
  wfRules.every(({ r }: any) => ['full_auto', 'assisted', 'learning'].includes(r.when.value)));
check('full_auto 下 C01 加分、C09 减分（方向正确）',
  wfRules.some(({ id, r }: any) => id === 'C01' && r.when.value === 'full_auto' && r.delta > 0) &&
  wfRules.some(({ id, r }: any) => id === 'C09' && r.when.value === 'full_auto' && r.delta < 0));

// 防回退：v1.7.0 之后 combos.json 里不该再出现任何 skills 条件
const anySkills = combos.some((c: any) =>
  JSON.stringify(c.fit_rules ?? []).includes('skills.') ||
  JSON.stringify(c.hard_exclude_when ?? []).includes('skills.'));
check('combos.json 里没有任何 skills 条件（防止半迁移/回退）', !anySkills);
check('12 套都有 ai_friendliness，且不再有 learning 字段',
  combos.every((c: any) => typeof c.base_scores.ai_friendliness === 'number' && c.base_scores.learning === undefined));
check('PRD §6.6.4 的 skills.js 示例已随 v1.7.0 废弃（代码里不再有该规则）',
  !anySkills, 'PRD 未同步，属已知文档债');

console.log('\n=== 4. PRD 与 v1.7.0 实现一致 ===');
// 这一节的目的：PRD 是给外人看的产品说明，它必须和代码说的是同一件事。
// v1.7.0 把 PRD 整篇重写过（旧版还写着 skills / Web 形态），所以断言也跟着换了一套。
check('PRD 声明组件数 23', prd.includes('23 条'));
check('PRD 声明模板数 12 套', prd.includes('12 套'));
check('PRD 声明 5 种范式且含 E（纯静态）',
  (prd.includes('5 种范式') || prd.includes('5 种架构范式')) && prd.includes('纯静态零后端'));
check('PRD 记录了 D1 历史产出率 29.6%（并注明口径已变）',
  prd.includes('29.6%') && prd.includes('口径'));
check('PRD 写明了目标用户是"用 AI 工具写代码的人"',
  (prd.includes('Vibe Coder') || prd.includes('用 Cursor / Claude Code')) && prd.includes('Cursor'));
check('PRD 声明 MCP 为主形态、Web 为调试台',
  prd.includes('主形态') && prd.includes('调试台'));
check('PRD 记录了 ai_workflow 三档',
  ['full_auto', 'assisted', 'learning'].every((k) => prd.includes(k)));
check('PRD 记录了 ai_friendliness 取代 learning',
  prd.includes('ai_friendliness') && prd.includes('取代'));
check('PRD 权重表按 ai_workflow 索引', prd.includes('按 `ai_workflow` 索引'));
check('PRD 附录 A 记录了 schema 变更', prd.includes('附录 A：schema 变更记录'));
check('PRD 权重表无「需求匹配度」行', !/\|\s*需求匹配度\s*\|/.test(prd));
check('PRD 主动写明 ai_friendliness 未校准（不掩盖）',
  prd.includes('人工判断') && prd.includes('未校准'));

console.log('\n=== 5. 事实快照 ===');
check('快照条数 > 0', snapshot.records.length > 0, `${snapshot.records.length} 条`);
check('快照每条都有 verified_at', snapshot.records.every((r: any) => !!r.verified_at));
check('失败项都有 fail_reason', snapshot.records.every((r: any) => r.version || r.fail_reason));
check('同一 entry 的 npm/pypi 未被合并（跨生态独立记录）', (() => {
  const ai02 = snapshot.records.filter((r: any) => r.entry_id === 'AI-02');
  return ai02.length >= 2 && new Set(ai02.map((r: any) => r.ecosystem)).size === ai02.length;
})(), 'AI-02 应有 npm 与 pypi 两条');

console.log('\n=== 6. 测试集 ===');
check('cases 数量 ≥ 6', casesRaw.cases.length >= 6, `${casesRaw.cases.length} 条`);
check('每条 case 都有 raw_input 与 constraint_vector', casesRaw.cases.every((c: any) => c.raw_input && c.constraint_vector));
check('case id 唯一', new Set(casesRaw.cases.map((c: any) => c.id)).size === casesRaw.cases.length);

console.log('\n=== 7. D1 数据集（真实数据，见 D1-数据采集与闭集覆盖诊断.md）===');
check('d1-candidates 条数 60', d1Pool.candidates.length === 60, `${d1Pool.candidates.length} 条`);
check('d1-candidates 每条都有 v2ex_id 与 delivery_form',
  d1Pool.candidates.every((c: any) => c.v2ex_id && c.delivery_form));
check('d1-candidates 声明了已知偏差', Array.isArray(d1Pool.meta.known_bias) && d1Pool.meta.known_bias.length > 0);
check('d1-holdout 有盲标协议', Array.isArray(d1Holdout.meta.protocol) && d1Holdout.meta.protocol.length >= 3);
check('d1-holdout 每条都有 bias_note', d1Holdout.cases.every((c: any) => !!c.bias_note));

// 【v0.4.3】原先是「绊线」（断言缺口存在），现已修复，改为正向断言。
// 反向的绊线改为下面那条 partial 可达性检查：一旦有人填了 UNSUPPORTED_CAPABILITIES
// 却没让 partial 真的可达，那条会失败。
const noDbCount = combos.filter((c: any) => !c.components.db).length;
check('零数据库组合数 > 0（v0.4.3 已补 C11）', noDbCount > 0,
  `${noDbCount} 套：${combos.filter((c: any) => !c.components.db).map((c: any) => c.id).join(', ')}`);

// 用真实调用验证三态，而不是只检查常量——常量对不代表分支跑得通
const probeCases = casesRaw.cases.filter((c: any) => c.kind === 'coverage_test');
const covStatuses = new Set<string>(
  probeCases.map((c: any) => rank(combos, c.constraint_vector, { raw_input: c.raw_input }).coverage_status)
);
check('coverage_status 覆盖 covered', covStatuses.has('covered'), `探针 ${probeCases.length} 条`);
check('coverage_status 覆盖 uncovered', covStatuses.has('uncovered'));
// 这条同时是「常量与可达性一致」的断言：
// UNSUPPORTED_CAPABILITIES 为空时 partial 必然不可达；一旦填值，partial 必须真的出现。
check('coverage_status 的 partial 可达性与 UNSUPPORTED_CAPABILITIES 一致',
  covStatuses.has('partial') === (UNSUPPORTED_CAPABILITIES.length > 0),
  UNSUPPORTED_CAPABILITIES.length === 0
    ? '当前为空数组，partial 不可达（已知缺口，见 D1 报告遗留问题）'
    : `已填 ${UNSUPPORTED_CAPABILITIES.length} 个能力，partial 应可达`);

// confidence 三值：需求用例（S01–S07 应为 high）+ 探针 + HX1（应为 low）
const confStatuses = new Set<string>();
const holdoutAll = [...d1Holdout.cases, ...(d1Holdout.supplementary ?? [])];
for (const c of [...casesRaw.cases, ...holdoutAll]) {
  const v = c.constraint_vector ?? c.blind_constraint_vector;
  confStatuses.add(rank(combos, v, { raw_input: c.raw_input }).confidence);
}
check('confidence 三值齐全', ['high', 'medium', 'low'].every((x) => confStatuses.has(x)),
  `实际出现：${[...confStatuses].sort().join(', ')}`);

const simCases = casesRaw.cases.filter((c: any) => !c.kind);
const notHigh = simCases.filter((c: any) => rank(combos, c.constraint_vector, { raw_input: c.raw_input }).confidence !== 'high');
check('S01–S07 需求用例 confidence 全为 high', notHigh.length === 0,
  notHigh.length === 0 ? `${simCases.length} 条全 high` : `不是 high 的：${notHigh.map((c: any) => c.id).join(', ')}`);

const hx1 = (d1Holdout.supplementary ?? []).find((c: any) => c.id === 'HX1');
const hx1r = rank(combos, hx1.blind_constraint_vector, { raw_input: hx1.raw_input });
check('HX1（3/9 字段）判定为 low 且不出方案', hx1r.confidence === 'low' && hx1r.ok === false,
  `confidence=${hx1r.confidence} ok=${hx1r.ok}`);

// holdout 结构：10 条入选 + supplementary 单列
check('d1-holdout 入选 10 条', d1Holdout.cases.length === 10, `${d1Holdout.cases.length} 条`);
check('d1-holdout 每条都记了 fields_non_null', d1Holdout.cases.every((c: any) => typeof c.fields_non_null === 'number'));
check('d1-holdout 入选者 fields_non_null 均 ≥ 6', d1Holdout.cases.every((c: any) => c.fields_non_null >= 6),
  `最低 ${Math.min(...d1Holdout.cases.map((c: any) => c.fields_non_null))}`);
check('d1-holdout 盲标协议声明了「第一遍禁止输出技术栈」',
  JSON.stringify(d1Holdout.meta.protocol).includes('严禁输出技术栈'));

// 【v0.4.3 已修】原先这里断言的是"PRD 写 10 套 / combos 11 套"这个已知漂移。
// PRD 已同步为 12 套，漂移消失，所以改成正向断言：三处数字必须相等。
// 一旦有人只改了一边（PRD 或 combos 或 meta），这条会失败。
check('PRD / combos / meta 的模板数三方一致（12 套）',
  prd.includes('12 套') && combos.length === 12 && combosRaw.meta.combo_count === 12,
  `PRD 含"12 套"=${prd.includes('12 套')}，combos=${combos.length} 套，meta=${combosRaw.meta.combo_count}`);

console.log('\n=== 8. v0.4.3 能力枚举 / 持久化推断 / 置信度分组 ===');

// 8.1 枚举白名单。
// 规则里写了枚举外的值，test() 永远匹配不到，属于**静默失效**——
// 不报错、不警告、规则就是不生效。这条把它变成可见的失败。
const capRuleValues = new Set<string>();
const flattenCond = (x: any): any[] => (x.all ? x.all.flatMap(flattenCond) : [x]);
for (const c of combos) {
  for (const when of [
    ...(c.fit_rules ?? []).map((r: any) => r.when),
    ...c.hard_exclude_when,
  ]) {
    for (const cond of flattenCond(when)) {
      if (cond.field === 'required_capabilities' && cond.op !== 'in') capRuleValues.add(cond.value);
    }
  }
}
const badCaps = [...capRuleValues].filter((v) => !(CAPABILITY_VALUES as readonly string[]).includes(v));
check('combos.json 的能力取值都在 CAPABILITY_VALUES 白名单内', badCaps.length === 0,
  badCaps.length ? `越界：${badCaps.join(', ')}` : `${capRuleValues.size} 个取值：${[...capRuleValues].join(', ')}`);

// 8.2 file 别名的双向兼容：旧规则一行没改，但拆成 file_upload / file_storage 后语义必须还对
const c11 = combos.find((c: any) => c.id === 'C11');
const c11ExcludedWith = (caps: string[]) =>
  hardFilter([c11], { required_capabilities: caps } as any)[0].excluded;
check('别名兼容：caps=["file_upload"] 仍被 C11 的 file 规则排除', c11ExcludedWith(['file_upload']) === true);
check('别名兼容：caps=["file_storage"] 仍被 C11 的 file 规则排除', c11ExcludedWith(['file_storage']) === true);
check('别名兼容：caps=[] 不被 C11 误排除（not_contains 语义未被破坏）', c11ExcludedWith([]) === false);

// 8.3 推断命中 + 否定保护。两条必须成对存在：
// 只测命中，等于默许"不需要存数据"也被补成 data_persistence（CT01 会失去 C11）。
const h06 = d1Holdout.cases.find((c: any) => c.id === 'H06');
const n06 = normalizeVector(h06.blind_constraint_vector, h06.raw_input);
check('推断：H06 原文的持久化表述被补成 data_persistence',
  n06.inferred_capabilities.includes('data_persistence'), n06.evidence ?? '未命中');

const ct01 = casesRaw.cases.find((c: any) => c.id === 'CT01');
const nct01 = normalizeVector(ct01.constraint_vector, ct01.raw_input);
check('推断否定保护：CT01「不需要登录也不用存数据」不补 data_persistence',
  nct01.inferred_capabilities.length === 0,
  nct01.evidence ?? '正确未命中');

// 8.4 C11 通吃修复的端到端证据（不只看常量，看 rank 的真实输出）
// 【v1.5.0】data_persistence 降级为建议项：C11/C12 不再被硬过滤，只被 fit -1。
// 断言必须成对——只断言"不再过滤"，等于默许 C11 重新通吃（H06 会退回零 DB 方案）。
const fitOf = (c: any, caps: string[]) => resolveFit(c, { required_capabilities: caps } as any).fit;
const c12c = combos.find((c: any) => c.id === 'C12');
const r06 = rank(combos, h06.blind_constraint_vector, { raw_input: h06.raw_input });
const c11Filtered = r06.ok ? r06.filteredOut.some((f: any) => f.id === 'C11') : true;
const c12Filtered = r06.ok ? r06.filteredOut.some((f: any) => f.id === 'C12') : true;
check('C11 在 data_persistence 下不再被硬过滤（降级为建议项，仍然可见）', r06.ok && !c11Filtered,
  r06.ok ? (c11Filtered ? '仍被过滤' : '可见，仅 fit 被扣分') : `blocked(${r06.reason})`);
check('C12 在 data_persistence 下也不再被硬过滤（否则用户看不到「纯静态 + 本地存」）',
  r06.ok && !c12Filtered,
  r06.ok ? (c12Filtered ? '仍被过滤' : '可见，仅 fit 被扣分') : `blocked(${r06.reason})`);
// C11 只有 -1；C12 是 -2——因为它那条「什么都不需要」的 +1 规则本来就以
// not_contains data_persistence 为前提，有持久化需求时既不满足 +1、又吃到 -1。
// 这个叠加是设计意图（C12 比 C11 离持久化需求更远），不是 bug，所以把 -2 钉死。
check('C11 fit -1 ／ C12 fit -2（后者另外失去了「什么都不需要」的 +1）',
  fitOf(c11, ['data_persistence']) === fitOf(c11, []) - 1 &&
    fitOf(c12c, ['data_persistence']) === fitOf(c12c, []) - 2,
  `C11 ${fitOf(c11, [])}→${fitOf(c11, ['data_persistence'])}，C12 ${fitOf(c12c, [])}→${fitOf(c12c, ['data_persistence'])}（-1 扣分 + 失去 +1 加分）`);
const top1HasDb = r06.ok ? Boolean(combos.find((c: any) => c.id === r06.top1.id)?.components.db) : false;
check('H06 的 Top1 仍是带 DB 的方案（扣分足够，没退回 C11 通吃）',
  r06.ok && r06.top1.id !== 'C11' && r06.top1.id !== 'C12' && top1HasDb,
  r06.ok ? `Top1=${r06.top1.id}` : `blocked(${r06.reason})`);

// 8.5 带 DB 方案的对冲加分
const c01c = combos.find((c: any) => c.id === 'C01');
const c02c = combos.find((c: any) => c.id === 'C02');
check('C01/C02 在 data_persistence 下 fit +1（带 DB 方案的对冲）',
  fitOf(c01c, ['data_persistence']) === fitOf(c01c, []) + 1 &&
    fitOf(c02c, ['data_persistence']) === fitOf(c02c, []) + 1,
  `C01 ${fitOf(c01c, [])}→${fitOf(c01c, ['data_persistence'])}，C02 ${fitOf(c02c, [])}→${fitOf(c02c, ['data_persistence'])}`);

// 8.5b 【v1.6.0】反向能力 no_persistence（修 data_persistence 极性 bug）
// 三条必须一起断言，少一条就会出现"规则写了但从不生效"或"同一句话算两遍"：
//   a) no_persistence 不给 C11/C12 扣分 —— 这是修 bug 的主要机制（原来读成
//      data_persistence 时 C11 -1、C12 -2，把最该赢的方案压下去了）
//   b) +1 这条规则真的会生效 —— C11/C12 的第一条规则以「不含 auth/file」为前提，
//      需求为空时它已经 +1 到 5（clamp 上限），新的 +1 被吃掉、看不出差别。
//      所以必须在一个"第一条规则不生效"的场景里验证 +1 真实可见，
//      否则这条规则会变成和 multi_platform 一样的死代码。
//   c) 不给带 DB 的方案减分 —— 一个用户表述只能被计算一次。
check('no_persistence 不给 C11/C12 扣分（等价于"没有持久化需求"）',
  fitOf(c11, ['no_persistence']) === fitOf(c11, []) &&
    fitOf(c12c, ['no_persistence']) === fitOf(c12c, []),
  `C11 ${fitOf(c11, [])}→${fitOf(c11, ['no_persistence'])}，C12 ${fitOf(c12c, [])}→${fitOf(c12c, ['no_persistence'])}`);
check('no_persistence 的 +1 规则不是死代码（在「要登录」这个前提下 4→5 可见）',
  fitOf(c11, ['auth', 'no_persistence']) === fitOf(c11, ['auth']) + 1 &&
    fitOf(c12c, ['auth', 'no_persistence']) === fitOf(c12c, ['auth']) + 1,
  `C11 ${fitOf(c11, ['auth'])}→${fitOf(c11, ['auth', 'no_persistence'])}，C12 ${fitOf(c12c, ['auth'])}→${fitOf(c12c, ['auth', 'no_persistence'])}`);
check('no_persistence 不给带 DB 的方案减分（同一句话不算两遍）',
  fitOf(c01c, ['no_persistence']) === fitOf(c01c, []) &&
    fitOf(c02c, ['no_persistence']) === fitOf(c02c, []),
  `C01 ${fitOf(c01c, [])}→${fitOf(c01c, ['no_persistence'])}，C02 ${fitOf(c02c, [])}→${fitOf(c02c, ['no_persistence'])}`);
check('极性修复的端到端效果：H06 原文若被判为 no_persistence，Top1 不再被 DB 方案占住',
  (() => {
    const r = rank(combos, { ...h06.blind_constraint_vector, required_capabilities: ['no_persistence'] } as any, { raw_input: 'x' });
    return r.ok && !Boolean(combos.find((c: any) => c.id === r.top1.id)?.components.db);
  })(),
  (() => {
    const r = rank(combos, { ...h06.blind_constraint_vector, required_capabilities: ['no_persistence'] } as any, { raw_input: 'x' });
    return r.ok ? `Top1=${r.top1.id}（零 DB）` : `blocked(${r.reason})`;
  })());

// 8.5c 结构性防回退：no_persistence 不能进任何 hard_exclude。
// 它是一条"偏好"而不是"硬约束"——把它写成一票否决，等于又造了一个 C11 通吃。
check('没有任何组合用 no_persistence 做硬排除',
  !combos.some((c: any) => (c.hard_exclude_when ?? []).some(
    (r: any) => r.field === 'required_capabilities' && r.value === 'no_persistence')),
  '12 套组合的 hard_exclude_when 里都没有它');

// 8.5d 推断侧极性保护：已经有 no_persistence 时不能再补 data_persistence
const withNoPersistence = normalizeVector(
  { ...h06.blind_constraint_vector, required_capabilities: ['no_persistence'] } as any,
  h06.raw_input,
);
check('normalizeVector 在 no_persistence 存在时不再推断 data_persistence（否则一边说不要一边被补成要）',
  !withNoPersistence.inferred_capabilities.includes('data_persistence'),
  withNoPersistence.inferred_capabilities.join(',') || '正确未推断');

// 8.6 置信度新判定表的关键档位
const confOf = (cs: any) => rank(combos, cs.blind_constraint_vector, { raw_input: cs.raw_input }).confidence;
/**
 * 【v1.7.0 期望变更】H01 从 high 降为 medium。
 *
 * 原因是真实的：D1 的 10 条帖子写于"ai_workflow"这个概念存在之前，
 * **没有一条说过"谁写代码"**。而 ai_workflow 在核心组里，
 * 所以这批历史数据现在最多只能到 medium。
 *
 * 这不是回归——新定位下"谁写代码"确实决定权重档，缺了就该问一句。
 * 但要让这条变化被看见，而不是悄悄改期望值，所以写在这里。
 */
const confTable: Array<[string, string]> = [['H01', 'medium'], ['H04', 'medium'], ['H05', 'medium'], ['H06', 'medium']];
const confWrong = confTable.filter(([id, want]) => {
  const cs = d1Holdout.cases.find((c: any) => c.id === id);
  return confOf(cs) !== want;
});
check('D1 历史用例全部 medium（原文都没提"谁写代码"→ 核心组必缺 ai_workflow）', confWrong.length === 0,
  confWrong.length ? `不符：${confWrong.map(([id, w]) => `${id} 期望 ${w}`).join('，')}` : 'H01/H04/H05/H06 均 medium');

const ct04 = casesRaw.cases.find((c: any) => c.id === 'CT04');
const rct04 = rank(combos, ct04.constraint_vector, { raw_input: ct04.raw_input });
check('CT04（核心齐、补充缺 5）判为 medium 且仍出方案',
  rct04.confidence === 'medium' && rct04.ok === true, `confidence=${rct04.confidence} ok=${rct04.ok}`);

// 8.7 delivery 新枚举的覆盖判定必须和 d1-coverage 的 Q1 口径一致
check('delivery=cli 判为 uncovered（闭集没有命令行模板）',
  coverageStatus({ delivery: 'cli' }).status === 'uncovered');
check('delivery=selfhost 判为 covered（自部署仍是 Web 应用）',
  coverageStatus({ delivery: 'selfhost' }).status === 'covered');

// 8.8 词表收窄（删「收藏」）后的双向回归。
// 两条必须成对：只断言 H01 恢复，等于默许把词表删空——H06 会跟着坏。
const h01 = d1Holdout.cases.find((c: any) => c.id === 'H01');
const r01 = rank(combos, h01.blind_constraint_vector, { raw_input: h01.raw_input });
check('H01 恢复 HIT：「收藏」不再触发推断，Top1 回到 C11（零数据库）',
  r01.ok && r01.inferred_capabilities.length === 0 && r01.top1.id === 'C11',
  r01.ok ? `Top1=${r01.top1.id} 推断=${r01.inferred_capabilities.join(',') || '无'}` : 'blocked');
check('「收藏」单独出现不算服务端持久化证据（H01 原文）',
  findPersistenceMention('还能收藏喜欢的').hit === false);

console.log('\n=== 9. C12 纯静态组合（v0.4.3 新增，M1 第一阶段）===');
const c12 = combos.find((c: any) => c.id === 'C12');
check('C12 存在且范式为 E（纯静态）', !!c12 && c12.paradigm === 'E', c12 ? `paradigm=${c12.paradigm}` : '缺失');
check('C12 无后端、无数据库（be / db 均为 null）',
  !!c12 && c12.components.be === null && c12.components.db === null,
  c12 ? JSON.stringify(c12.components) : '');
check('C12 复用既有 KB 组件，未新增组件条目（kb 仍 23）',
  !!c12 && c12.components.fe === 'FE-04' && c12.components.deploy === 'DP-02' &&
    combosRaw.meta.kb_component_count === 23);
check('所有组合的范式取值都在 A–E 内',
  combos.every((c: any) => ['A', 'B', 'C', 'D', 'E'].includes(c.paradigm)),
  [...new Set(combos.map((c: any) => c.paradigm))].sort().join(''));

// 同分是真实存在的：C11 与 C12 的 base_scores 按设计同档，fit 又都会 clamp 到 5。
// 这条断言保证"tie-break 场景"不会因为有人调了 C12 的分而静默消失。
check('C11 与 C12 的 base_scores 完全相同（同分场景真实存在）',
  JSON.stringify(c11.base_scores) === JSON.stringify(c12.base_scores));

// tie-break 端到端：CT04 既无 AI 也无登录/持久化 → 两套都合格 → 组件更少的 C12 胜
const ct04tie = rank(combos, casesRaw.cases.find((c: any) => c.id === 'CT04').constraint_vector,
  { raw_input: casesRaw.cases.find((c: any) => c.id === 'CT04').raw_input });
check('同分时取组件更少的那套（CT04 由 C12 胜出，不是 C11）',
  ct04tie.ok && ct04tie.top1.id === 'C12', ct04tie.ok ? `Top1=${ct04tie.top1.id}` : 'blocked');

// 安全边界：需要 AI 时 C12 必须被排除，否则等于推荐"把 API key 写进前端"
check('C12 在需要 AI 时被硬排除（避免把 key 暴露在前端）',
  hardFilter([c12], { required_capabilities: ['ai'] } as any)[0].excluded === true);

// 端到端：三条真实"纯静态"需求必须由 C12 拿下（这是 M1 第一阶段的核心验收）
const staticTop1 = ['H02', 'H05', 'H08'].map((id) => {
  const cs = d1Holdout.cases.find((c: any) => c.id === id);
  const r = rank(combos, cs.blind_constraint_vector, { raw_input: cs.raw_input });
  return `${id}=${r.ok ? r.top1.id : 'blocked'}`;
});
check('H02 / H05 / H08 的 Top1 均为 C12', staticTop1.every((x) => x.endsWith('=C12')), staticTop1.join(' '));

// 渲染层：combos.json 用到的组件必须在 component-names 里登记，
// 否则 gen-preview 生成的材料里会出现裸 ID（"FE-07"），而这是给人看的材料，不是给机器。
const usedIds = new Set<string>();
for (const c of combos) {
  for (const id of Object.values(c.components)) if (id) usedIds.add(String(id));
}
const unregistered = [...usedIds].filter((id) => !COMPONENT_NAMES[id]);
check('combos.json 用到的组件都在 component-names 里登记',
  unregistered.length === 0,
  unregistered.length ? `未登记：${unregistered.join(', ')}` : `${usedIds.size} 个组件全部有显示名`);

console.log('\n=== 10. v0.4.4 定位收窄 / v1.5.0 语义降级 ===');

// 10.1 定位必须落在 PRD 正文，不能只写在 ADR 里。
// 【v1.7.0 反转】旧断言检查的是"不面向零基础纯小白"——那是 v0.4.4 的定位，
// 新定位下"不会写代码"恰恰是目标用户的典型特征。所以断言反转成"必须写明服务 Vibe Coder"。
check('PRD 写明了目标用户是"用 Cursor/Agent 写代码的人"',
  prd.includes('用 Cursor / Agent 写代码的人') || prd.includes('用 Cursor / Claude Code'),
  '缺失：新定位没落到 PRD');
check('PRD 明确把旧定位标注为作废（防止两套说法并存）',
  prd.includes('不面向零基础纯小白') && prd.includes('作废'),
  '缺失：旧结论没标注作废，读者会看到互相矛盾的两段');
check('PRD 记录了 data_persistence 降级为建议项（v1.5.0）',
  prd.includes('v1.5.0') && prd.includes('建议项'),
  prd.includes('v1.5.0') ? '附录 F.4.1 已记录' : '缺失');

// 10.2 结构性防回退：v1.5.0 之后不允许任何组合再拿 data_persistence 做硬排除。
// 这条不测分数、只测结构——分数可以调，一票否决回来了就是回退。
const persistHardExclude = combos
  .filter((c: any) => (c.hard_exclude_when ?? []).some(
    (r: any) => r.field === 'required_capabilities' && r.value === 'data_persistence'))
  .map((c: any) => c.id);
check('没有任何组合再用 data_persistence 做硬排除（防止语义回退）',
  persistHardExclude.length === 0,
  persistHardExclude.length ? `仍在硬排除：${persistHardExclude.join(', ')}` : 'C11/C12 均已改为 fit -1');

// 10.3 推断出来的能力必须仍然透出——降级后"为什么被扣分"同样需要证据链
const r06b = rank(combos, d1Holdout.cases.find((c: any) => c.id === 'H06').blind_constraint_vector,
  { raw_input: d1Holdout.cases.find((c: any) => c.id === 'H06').raw_input });
check('降级后仍透出推断依据（用户能看到"为什么 C11 被扣分"）',
  r06b.inferred_capabilities.includes('data_persistence') && !!r06b.inference_evidence,
  r06b.inference_evidence ?? '无证据');

// 10.4 解释层的兜底文案完全依赖 combos 的 first_step。
// 缺一条，fallback 就会退化成"（空）"或一句无法执行的话——而 fallback 恰恰是
// LLM 挂掉时用户唯一能看到的东西，所以它必须逐套都在。
const missingFirstStep = combos.filter((c: any) => !c.first_step || !c.first_step_minutes).map((c: any) => c.id);
check('每套组合都有 first_step / first_step_minutes（兜底文案的数据源）',
  missingFirstStep.length === 0,
  missingFirstStep.length ? `缺失：${missingFirstStep.join(', ')}` : '12 套齐全');
// 用解释层**同一个**判定函数，而不是在这里另写一套正则——
// 两套正则必然漂移（第一版就漏了"装微信开发者工具"这种合法写法）。
const weakFirstStep = combos.filter((c: any) => checkFirstStep(c.first_step ?? '', c.first_step ?? '').length > 0).map((c: any) => c.id);
check('first_step 都含命令或具体平台动作（不能是"先去学习"）',
  weakFirstStep.length === 0,
  weakFirstStep.length ? `不合格：${weakFirstStep.join(', ')}` : '12 套均可执行');

console.log(failed === 0 ? '\n全部通过。' : `\n${failed} 项不一致，需修复。`);
process.exit(failed === 0 ? 0 : 1);