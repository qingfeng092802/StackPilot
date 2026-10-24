/**
 * 冒烟测试：证明"算分桥梁"真的能跑，且差异度可机械计算。
 * 运行：node --experimental-strip-types scripts/smoke-test.ts
 */
import { readFileSync } from 'node:fs';
import { rank, comboSignature, diversity, scoreCombo, WEIGHTS } from '../src/lib/scoring.ts';
import { compareSemver, compareMaven, isPrerelease } from '../src/lib/facts/index.ts';

const combos = JSON.parse(
  readFileSync(new URL('../src/data/combos.json', import.meta.url), 'utf8')
).combos;

console.log('=== 1. 版本比较（修 v0.3 的字符串 min bug）===');
const cases: Array<[string, string, string]> = [
  ['10.0.0', '2.0.0', '数值比较'],
  ['1.0.0-rc.1', '1.0.0', '预发布低于正式版'],
  ['1.2.16', '1.5.2', 'LangGraph PyPI vs npm'],
];
for (const [a, b] of cases) {
  const r = compareSemver(a, b);
  console.log(`  compareSemver("${a}","${b}") = ${r > 0 ? '>' : r < 0 ? '<' : '='}   (${cases.find(c=>c[0]===a&&c[1]===b)?.[2]})`);
}
console.log(`  String 陷阱：min(["10.0.0","2.0.0"]) 会得到 "10.0.0"，正确应为 "2.0.0"`);
console.log(`  compareMaven("4.2.0-RC1","4.1.2") = ${compareMaven('4.2.0-RC1', '4.1.2') > 0 ? '>' : '<'}`);
console.log(`  isPrerelease("8.0.0-rc.27") = ${isPrerelease('8.0.0-rc.27')}`);
console.log(`  isPrerelease("4.2.0-RC1") = ${isPrerelease('4.2.0-RC1')}`);
console.log(`  isPrerelease("2.0.2-5020620260917001") = ${isPrerelease('2.0.02-5020620260917001'.replace('02','0'))}  ← uni-app 会被误判，故用 dateBuild adapter`);

console.log('\n=== 2. 同一需求 + 不同约束 → 是否真的不同 ===');
const scenarios = [
  {
    label: '新手 / 1人 / 1月 / 0预算 / 要登录',
    v: { delivery: 'web', team_size: '1', skills: { js: 0.2, python: 0.2, sql: 0.1 }, timeline_weeks: 4, budget_cny_month: 0, expected_users: 100, required_capabilities: ['auth'], goal_type: 'internal_tool' },
  },
  {
    label: '会 Python / 1人 / 2月 / 要 AI',
    v: { delivery: 'web', team_size: '1', skills: { js: 0.2, python: 0.8, sql: 0.3 }, timeline_weeks: 8, budget_cny_month: 50, expected_users: 500, required_capabilities: ['ai', 'file'], goal_type: 'product' },
  },
  {
    label: '5人团队 / 长期产品 / 要支付',
    v: { delivery: 'web', team_size: '5+', skills: { js: 0.8, python: 0.6, sql: 0.7 }, timeline_weeks: 12, budget_cny_month: 500, expected_users: 20000, required_capabilities: ['auth', 'payment'], compliance: ['payment'], goal_type: 'product' },
  },
  {
    label: '小程序 / 个人主体 / 零预算',
    v: { delivery: 'miniprogram', team_size: '1', skills: { js: 0.3, python: 0.1, sql: 0.1 }, timeline_weeks: 6, budget_cny_month: 0, expected_users: 200, required_capabilities: [], goal_type: 'internal_tool' },
  },
  {
    label: '作品集 / 要 AI / 会 JS',
    v: { delivery: 'web', team_size: '1', skills: { js: 0.7, python: 0.3, sql: 0.3 }, timeline_weeks: 8, budget_cny_month: 100, expected_users: 100, required_capabilities: ['ai', 'auth'], goal_type: 'portfolio' },
  },
  {
    label: '内部工具 / 2周 / 极简',
    v: { delivery: 'web', team_size: '1', skills: { js: 0.4, python: 0.2, sql: 0.1 }, timeline_weeks: 2, budget_cny_month: 0, expected_users: 10, required_capabilities: [], goal_type: 'internal_tool' },
  },
];

const signatures: string[] = [];
for (const s of scenarios) {
  const r = rank(combos, s.v as any);
  if (!r.ok) {
    // v0.4.3：rank 返回三态联合，不再是 null
    console.log(`\n  [${s.label}] → 不出方案（reason=${r.reason}）：${r.suggestion}`);
    continue;
  }
  const c1 = combos.find((c: any) => c.id === r.top1.id);
  const sig = comboSignature(c1);
  signatures.push(sig);
  console.log(`\n  [${s.label}]`);
  console.log(`    Top1: ${r.top1.id} ${r.top1.name}  ${r.top1.score}分  范式${r.top1.paradigm}  lang=${r.top1.lang}`);
  console.log(`    指纹: ${sig}`);
  console.log(`    打分: baseAvg=${r.top1.baseAvg} × fitFactor=${r.top1.fitFactor} (fit=${r.top1.breakdown.fit}, deltas=[${r.top1.fitDeltas}])`);
  console.log(`    状态: coverage=${r.coverage_status}  confidence=${r.confidence}`);
  console.log(`    Top2: ${r.top2.id} ${r.top2.name}  ${r.top2.score}分  范式${r.top2.paradigm}`);
  if (r.runnerUps.length) {
    console.log(`    差一点入选: ${r.runnerUps.map((x) => `${x.id}(${x.score})`).join(' ')}`);
  }
  if (r.skillMismatch) console.log(`    ⚠️ 技能栈违背：用户最强语言与 Top1 不一致`);
  console.log(`    过滤掉 ${r.filteredOut.length} 套，剩 ${r.candidateCount} 套候选`);
  if (r.filteredOut.length) console.log(`    例: ${r.filteredOut[0].id} — ${r.filteredOut[0].reasons[0]}`);
}

console.log(`\n=== 3. 差异度（1 - max_share）===`);
console.log(`  ${scenarios.length} 条需求的 Top1 指纹：`);
signatures.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));
console.log(`\n  差异度 = ${diversity(signatures)}   （PRD 目标 > 0.70，M0 需 20 条需求实测）`);

console.log('\n=== 4. 权重随 goal_type 变化 ===');
console.log(`  权重维度（不含 fit）：${Object.keys(WEIGHTS.internal_tool).join(', ')}`);
const c01x = combos.find((c: any) => c.id === 'C01');
const c03x = combos.find((c: any) => c.id === 'C03');
console.log('  注：C01 各项 4/5/5/4/4 几乎一样平，换权重 baseAvg 也不变——这是数学结果，不是 bug。');
console.log('      看 C03（2/4/2/3/5，起伏大）才能看出权重真的在起作用。\n');
for (const g of Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>) {
  const a = scoreCombo(c01x, { goal_type: g } as any);
  const b = scoreCombo(c03x, { goal_type: g } as any);
  console.log(
    `  ${g.padEnd(14)}  C01 baseAvg=${a.baseAvg.toFixed(2)}  |  C03 baseAvg=${b.baseAvg.toFixed(2)}`
  );
}
