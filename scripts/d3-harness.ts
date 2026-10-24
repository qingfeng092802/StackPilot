/**
 * M0 D3 装配脚本（对应 PRD v0.4 §12 D3）
 * ------------------------------------------------------------------
 * 流水线（重要：LLM 不参与选型）：
 *   1. 读 tests/cases.json（D1 的真实需求 + D2 的人工标注约束）
 *   2. 跑 scoring.ts → top1 / top2 / runnerUps / filteredOut
 *   3. 从 facts-snapshot.json 注入真实版本号
 *   4. 输出 out/d3-input/<id>.json → 喂给《方案生成 System Prompt》
 *   5. 打印汇总指标（差异度 / 技能栈违背率 / 范式强制率）
 *
 * 运行：node --experimental-strip-types scripts/d3-harness.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { rank, comboSignature, diversity, notChosenForUI, type ConstraintVector, type Combo } from '../src/lib/scoring.ts';
import type { FactsSnapshot } from '../src/lib/facts/index.ts';

const combos: Combo[] = JSON.parse(readFileSync(new URL('../src/data/combos.json', import.meta.url), 'utf8')).combos;
const cases = JSON.parse(readFileSync(new URL('../tests/cases.json', import.meta.url), 'utf8'));
const snapshot: FactsSnapshot = JSON.parse(readFileSync(new URL('../src/data/facts-snapshot.json', import.meta.url), 'utf8'));

const OUT = new URL('../out/d3-input/', import.meta.url);
mkdirSync(OUT, { recursive: true });

/** 只取该组合用到的组件的实测事实 */
function factsFor(combo: Combo) {
  const ids = Object.values(combo.components);
  const recs = snapshot.records.filter((r) => ids.includes(r.entry_id));
  const ghs = snapshot.github;
  return {
    generated_at: snapshot.generated_at,
    stale: (Date.now() - new Date(snapshot.generated_at).getTime()) / 86400000 > 7,
    components: recs.map((r) => ({
      entry_id: r.entry_id,
      ecosystem: r.ecosystem,
      package: r.package,
      version: r.version,
      fail_reason: r.fail_reason,
    })),
    github: ghs.map((g) => ({ repo: g.repo, stars: g.stars, activity: g.activity })),
  };
}

function comboBrief(c: Combo) {
  return {
    id: c.id,
    name: c.name,
    one_liner: c.one_liner,
    paradigm: c.paradigm,
    components: c.components,
    beginner_pitfalls: c.beginner_pitfalls ?? [],
    when_to_leave: c.when_to_leave ?? '',
    evidence: c.evidence ?? { official_docs: [], pitfall_articles: [] },
  };
}

const signatures: string[] = [];
let mismatch = 0;
let enforced = 0;
let nullResults = 0;
let probes = 0;

console.log('id     Top1                              Top2                             差异 候选 违背 强制');
console.log('-'.repeat(96));

for (const c of cases.cases) {
  const v = c.constraint_vector as ConstraintVector;
  // v0.4.3：把 raw_input 传进去，供 delivery 缺失时的关键词兜底使用
  const r = rank(combos, v, { raw_input: c.raw_input });

  // *_test 是合成探针（coverage_test / confidence_test），只验证判定逻辑，不参与需求分布的统计
  const isProbe = typeof c.kind === 'string' && c.kind.endsWith('_test');
  if (isProbe) probes++;

  if (!r.ok) {
    nullResults++;
    const label =
      r.reason === 'uncovered' ? '超出模板库范围' :
      r.reason === 'low_confidence' ? `信息不足（confidence=low，缺 ${r.suggested_fields.join('/')}）` :
      '候选不足（硬过滤后 <2）';
    console.log(`${c.id.padEnd(6)} — 不出方案：${label}`);
    writeFileSync(
      new URL(`${c.id}.json`, OUT),
      JSON.stringify({
        case_id: c.id,
        kind: c.kind ?? 'requirement',
        raw_input: c.raw_input,
        constraint_vector: v,
        status: 'BLOCKED',
        reason: r.reason,
        coverage_status: r.coverage_status,
        confidence: r.confidence,
        suggestion: r.suggestion,
        collect_entry: r.collect_entry,
        questions: r.questions,
        suggested_fields: r.suggested_fields,
      }, null, 2)
    );
    continue;
  }

  const c1 = combos.find((x) => x.id === r.top1.id)!;
  const c2 = combos.find((x) => x.id === r.top2.id)!;
  const sig = comboSignature(c1);
  // 只有真实需求用例进入差异度/违背率/强制率的分母
  if (!isProbe) {
    signatures.push(sig);
    if (r.skillMismatch) mismatch++;
    if (r.diversityEnforced) enforced++;
  }

  const payload = {
    case_id: c.id,
    kind: c.kind ?? 'requirement',
    source: c.source,
    raw_input: c.raw_input,
    constraint_vector: v,
    status: 'OK',
    coverage_status: r.coverage_status,
    ...(r.coverage_warning ? { coverage_warning: r.coverage_warning } : {}),
    confidence: r.confidence,
    ...(r.confidence_warning ? { confidence_warning: r.confidence_warning } : {}),
    // v0.4.3：把"引擎自己补的能力"透出来。否则用户看到 C11 被排除，
    // 在结果里找不到任何依据，只会觉得是黑箱。
    ...(r.inferred_capabilities.length
      ? { inferred_capabilities: r.inferred_capabilities, inference_evidence: r.inference_evidence }
      : {}),
    scoring_result: {
      top1: { ...r.top1, combo_signature: sig, detail: comboBrief(c1) },
      top2: { ...r.top2, detail: comboBrief(c2) },
      // 展示层截断：2 条"差一点入选" + 3 条"被硬过滤"，总计 ≤5（v0.4.2）
      not_chosen: notChosenForUI(r).map((item) => ({
        tier: item.tier,
        ...comboBrief(combos.find((x) => x.id === item.id)!),
        score: item.score,
        why: item.reason,
      })),
      // 全量计数：必须分开报，不能合并成一个数——
      // runnerUps + filteredOut 恒等于 (候选数-2)+(10-候选数)=8，合起来是常数，没有信息量
      not_chosen_stats: {
        runner_ups_full: r.runnerUps.length,
        filtered_out_full: r.filteredOut.length,
        shown: notChosenForUI(r).length,
      },
      diversity_enforced: r.diversityEnforced,
      skill_mismatch: r.skillMismatch,
      candidate_count: r.candidateCount,
    },
    facts_snapshot: factsFor(c1),
  };

  writeFileSync(new URL(`${c.id}.json`, OUT), JSON.stringify(payload, null, 2));

  console.log(
    `${c.id.padEnd(6)} ${(r.top1.id + ' ' + r.top1.name).slice(0, 32).padEnd(33)} ${(r.top2.id + ' ' + r.top2.name).slice(0, 32).padEnd(33)} ${String(r.top1.score).padEnd(4)} ${String(r.candidateCount).padEnd(4)} ${r.skillMismatch ? '  ⚠️' : '  ·'}  ${r.diversityEnforced ? '是' : '否'}`
  );
}

const total = signatures.length;
const reqCount = cases.cases.length - probes;
console.log('\n=== 汇总指标（对应 PRD §10.2）===');
console.log(`  用例数            ${cases.cases.length}（${cases.meta.status}）`);
console.log(`  其中需求用例      ${reqCount}   合成探针 ${probes}（只验证三态判定，不进统计分母）`);
console.log(`  有效产出          ${total}`);
console.log(`  未出方案          ${nullResults}`);
console.log(`  差异度            ${diversity(signatures)}   （目标 > 0.70）`);
console.log(`  技能栈违背率      ${total ? ((mismatch / total) * 100).toFixed(0) + '%' : 'n/a'}   （目标 < 20%）`);
console.log(`  范式强制率        ${total ? ((enforced / total) * 100).toFixed(0) + '%' : 'n/a'}   （目标 < 20%）`);
console.log(`\n→ 输入文件已写入 out/d3-input/（共 ${total + nullResults} 个）`);
console.log('  下一步：把每个文件的内容贴进《M0-D3-方案生成Prompt》，产出方案并记录 token 成本。');
