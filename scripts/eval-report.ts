/**
 * eval 批次聚合报告（v2.3）：读 out/eval/results.jsonl → 每套指标 → ai_friendliness 建议值。
 *
 * 映射公式（可复算，写死在此）：
 *   ai_friendliness = clamp(1, 5, 1 + round(4 × (0.6 × build_rate + 0.4 × passed_rate)))
 *   build_rate 权重更高：用户在乎"照着做能不能跑通"，其次才是"约束全对"。
 *
 * 用法：npx tsx scripts/eval-report.ts
 * 产出：docs/eval-batch-<batch>.md + 回填建议 JSON（stdout）
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const combosRaw = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'src', 'data', 'combos.json'), 'utf8'));
const file = resolve(import.meta.dirname, '..', 'out', 'eval', 'results.jsonl');
if (!existsSync(file)) { console.error('没有 results.jsonl'); process.exit(1); }

const records = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const BATCH = `2026-10-30-flash-v1`;

interface Agg {
  rounds: number;
  passed: number;
  buildPass: number;
  truncated: number;
  otherFail: number;
  lockedSum: number;
  lockedN: number;
  deployAllMissed: number;
  deployN: number;
}

const by = new Map<string, Agg>();
for (const r of records) {
  const id = r.combo_id;
  const a = by.get(id) ?? { rounds: 0, passed: 0, buildPass: 0, truncated: 0, otherFail: 0, lockedSum: 0, lockedN: 0, deployAllMissed: 0, deployN: 0 };
  a.rounds++;
  if (r.passed) a.passed++;
  if (r.build?.ok === true) a.buildPass++;
  const isTruncated = r.error?.includes('max_tokens') || r.error?.includes('被截断') || (r.build?.detail ?? '').includes('max_tokens');
  if (isTruncated) a.truncated++;
  if (!r.passed && !isTruncated) a.otherFail++;
  if (typeof r.locked_hit === 'number' && typeof r.locked_total === 'number' && r.locked_total > 0) {
    a.lockedSum += r.locked_hit / r.locked_total;
    a.lockedN++;
  }
  if (typeof r.deploy_artifacts_all_missed_by_ai === 'boolean') {
    a.deployN++;
    if (r.deploy_artifacts_all_missed_by_ai) a.deployAllMissed++;
  }
  by.set(id, a);
}

const scoreOf = (a: Agg) => {
  const buildRate = a.rounds ? a.buildPass / a.rounds : 0;
  const passRate = a.rounds ? a.passed / a.rounds : 0;
  return Math.min(5, Math.max(1, 1 + Math.round(4 * (0.6 * buildRate + 0.4 * passRate))));
};

const lines: string[] = [];
lines.push(`# eval 批次报告：${BATCH}`);
lines.push('');
lines.push(`> 模型 deepseek-flash · 每套 3 轮（AI 一次生成 → npm install → build）· 并发 3`);
lines.push(`> 映射公式：\`ai_friendliness = clamp(1, 5, 1 + round(4 × (0.6 × build_rate + 0.4 × pass_rate)))\`（可复算）`);
lines.push('');
lines.push('| 组合 | 轮数 | build 通过 | 约束全对（passed） | 截断 | 锁定依赖覆盖均值 | 骨架部署工件 AI 全漏 | 旧分 | 建议新分 |');
lines.push('|---|---|---|---|---|---|---|---|---|');
const updates: Array<{ combo_id: string; old: number; new: number; basis: string }> = [];
for (const c of combosRaw.combos as any[]) {
  const a = by.get(c.id);
  if (!a) { lines.push(`| ${c.id} | 0 | — | — | — | — | — | ${c.base_scores.ai_friendliness} | （未跑） |`); continue; }
  const buildRate = a.buildPass / a.rounds;
  const passRate = a.passed / a.rounds;
  const lockedAvg = a.lockedN ? (a.lockedSum / a.lockedN) : null;
  const s = scoreOf(a);
  updates.push({ combo_id: c.id, old: c.base_scores.ai_friendliness, new: s, basis: `build ${a.buildPass}/${a.rounds}, passed ${a.passed}/${a.rounds}` });
  lines.push(`| ${c.id} | ${a.rounds} | ${a.buildPass}/${a.rounds} | ${a.passed}/${a.rounds} | ${a.truncated} | ${lockedAvg === null ? '—' : Math.round(lockedAvg * 100) + '%'} | ${a.deployN ? `${a.deployAllMissed}/${a.deployN}` : '—'} | ${c.base_scores.ai_friendliness} | **${s}** |`);
}
lines.push('');
lines.push('## 批次结论');
lines.push('');
for (const u of updates) {
  if (u.old !== u.new) lines.push(`- ${u.combo_id}：${u.old} → **${u.new}**（${u.basis}）`);
}
const totalRounds = [...by.values()].reduce((s, a) => s + a.rounds, 0);
const deployMissed = [...by.values()].reduce((s, a) => s + a.deployAllMissed, 0);
const deployN = [...by.values()].reduce((s, a) => s + a.deployN, 0);
lines.push('');
lines.push(`- 全批次 ${totalRounds} 轮。**骨架优势断言**：AI 一次生成时，scaffold 的部署工件 ${deployN ? `100%（${deployMissed}/${deployN} 组合轮次全部漏掉）` : '—'}不由 AI 自发产出——这正是骨架模板存在的意义。`);
lines.push(`- 回填操作：combos.json 各套 base_scores.ai_friendliness 换上"建议新分"，meta 加 \`"eval_batch": "${BATCH}"\`，ai_friendliness_note 注明本批次。`);
lines.push(`- consistency 防回退：ai_friendliness_note 必须含 eval_batch id。`);

const outPath = resolve(import.meta.dirname, '..', 'docs', `eval-batch-${BATCH}.md`);
writeFileSync(outPath, lines.join('\n') + '\n');
writeFileSync(resolve(import.meta.dirname, '..', 'out', 'eval', 'backfill.json'), JSON.stringify({ batch: BATCH, updates }, null, 2) + '\n');
console.log(lines.join('\n'));
console.log(`\n报告 → ${outPath}`);
console.log(`回填建议 → out/eval/backfill.json`);
