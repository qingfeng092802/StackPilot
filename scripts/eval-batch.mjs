/**
 * 批量 eval 调度（v2.3）：C01-C12 × 3 轮（含 install+build），并发 3（红线 ≤5，防 API 限流封号）。
 * 产出：out/eval/results.jsonl（追加，failure_kind 已严格分类）。
 * 用法：node scripts/eval-batch.mjs [并发数]
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const env = {};
for (const l of readFileSync(resolve(import.meta.dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].trim();
}
if (!env.ANTHROPIC_API_KEY) {
  console.error('没有 key（.env.local）');
  process.exit(1);
}

const COMBOS = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12'];
const CONCURRENCY = Math.min(5, Math.max(1, Number(process.argv[2] ?? 3)));
const queue = [...COMBOS];
const t0 = Date.now();

function runCombo(comboId) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, 'eval-scaffold.ts'), '--combo', comboId, '--rounds', '3', '--build'], {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
        ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL ?? 'https://api.deepseek.com/anthropic',
        ANTHROPIC_MODEL: env.ANTHROPIC_MODEL ?? 'deepseek-flash',
      },
    });
    let tail = '';
    child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });
    child.on('close', (code) => {
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${comboId} 完成（exit ${code}）`);
      if (code !== 0) console.log(`  ${comboId} stderr 尾部: ${tail.split('\n').at(-2) ?? ''}`);
      resolveP();
    });
  });
}

async function worker(id) {
  while (queue.length) {
    const comboId = queue.shift();
    if (!comboId) break;
    await runCombo(comboId);
  }
  console.log(`worker-${id} 收工`);
}

console.log(`批量 eval：${COMBOS.length} 套 × 3 轮（含 install+build），并发 ${CONCURRENCY}`);
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
console.log(`\n全部完成，耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟。聚合：node scripts/eval-report.ts`);
