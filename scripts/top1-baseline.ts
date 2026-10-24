/**
 * Top1 基线快照：把 holdout 每条用例的 Top1 + 候选前三分打出来。
 *
 * 用途：改 fit_rules / 枚举之后立刻对比，看有没有把哪条用例的结论悄悄改掉。
 * 这类改动最危险的地方就是"看起来只加了一条 +1"，实际上把某条用例的 Top1 换了。
 *
 *   npx tsx scripts/top1-baseline.ts
 *   npx tsx scripts/top1-baseline.ts --out=out/top1-before.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import combosRaw from '../src/data/combos.json' with { type: 'json' };
import { rank } from '../src/lib/scoring.ts';
import type { Combo } from '../src/lib/scoring.ts';

const combos = (combosRaw as any).combos as Combo[];
const holdout = JSON.parse(readFileSync(new URL('../tests/d1-holdout.json', import.meta.url), 'utf8'));

const args = process.argv.slice(2);
const out = args.find((a) => a.startsWith('--out='))?.slice(6);

const rows = holdout.cases.map((cs: any) => {
  const r: any = rank(combos, cs.blind_constraint_vector, { raw_input: cs.raw_input });
  if (!r.ok) return { id: cs.id, ok: false, reason: r.reason ?? r.blocked?.reason };
  return {
    id: cs.id,
    ok: true,
    top1: r.top1.id,
    top2: r.top2.id,
    confidence: r.confidence,
    coverage: r.coverage_status,
    score: `${r.top1.id}:${r.top1.score.toFixed(3)}`,
    top2_score: `${r.top2.id}:${r.top2.score.toFixed(3)}`,
    inferred: r.inferred_capabilities,
  };
});

for (const r of rows) {
  console.log(r.ok
    ? `${r.id}  ${r.top1}  ${r.confidence}  ${r.coverage}  ${r.score}  | 2nd ${r.top2_score}  | 推断 ${r.inferred.join(',') || '无'}`
    : `${r.id}  不出方案（${r.reason}）`);
}

if (out) {
  writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log(`\n已写入 ${out}`);
}
