/**
 * 一次性诊断脚本：把模型原文（含 thinking 块）原样打出来，用来定位
 * `parse.invalid_json` 的真实成因。
 *
 * 不参与任何指标计算，纯排查工具。跑完可删。
 *
 *   ANTHROPIC_BASE_URL=... ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=deepseek-flash \
 *     npx tsx scripts/diag-raw.ts --id=H06
 */

import { readFileSync } from 'node:fs';
import combosRaw from '../src/data/combos.json' with { type: 'json' };
import { rank } from '../src/lib/scoring.ts';
import type { Combo } from '../src/lib/scoring.ts';
import { buildExplainContext } from '../src/lib/explain/index.ts';
import { buildUserPrompt, SYSTEM_PROMPT } from '../src/lib/explain/prompt.ts';

const combos = (combosRaw as any).combos as Combo[];
const holdout = JSON.parse(readFileSync(new URL('../tests/d1-holdout.json', import.meta.url), 'utf8'));

const args = process.argv.slice(2);
const flag = (k: string, d = '') => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const id = flag('id', 'H06');
const cs = holdout.cases.find((c: any) => c.id === id);
if (!cs) throw new Error(`找不到用例 ${id}`);

const r: any = rank(combos, cs.blind_constraint_vector, { raw_input: cs.raw_input });
if (!r.ok) throw new Error(`${id} 不出方案`);
const ctx = buildExplainContext(r, combos, cs.blind_constraint_vector);

const base = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
const model = process.env.ANTHROPIC_MODEL ?? 'deepseek-flash';

async function main() {
  const user = buildUserPrompt(ctx);
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const raw = await res.text();
  console.log(`HTTP ${res.status}  model=${model}`);
  if (!res.ok) {
    console.log(raw.slice(0, 600));
    return;
  }
  const json = JSON.parse(raw);
  console.log(`stop_reason=${json.stop_reason}  usage=${JSON.stringify(json.usage)}`);
  console.log(`content 块类型：${(json.content ?? []).map((b: any) => b.type).join(' / ')}`);
  console.log('\n=== 各块内容 ===');
  for (const [i, b] of (json.content ?? []).entries()) {
    console.log(`\n--- 块 [${i}] type=${b.type} len=${(b.text ?? JSON.stringify(b)).length} ---`);
    console.log(String(b.text ?? JSON.stringify(b)).slice(0, 4000));
  }
}

main().catch((e) => {
  console.error('诊断脚本出错：', e);
  process.exit(1);
});
