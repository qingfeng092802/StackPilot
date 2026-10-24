/**
 * LLM 解释层自动评测（M1 第二阶段验收）。
 *
 * 三项指标（用户指定）：
 *   1. JSON 解析成功率   目标 > 95%
 *   2. "第一步"可执行率  目标 > 80%
 *   3. 降档建议比例      无阈值，看分布（用户要求"统计给出替代方案的比例"）
 *
 * 【口径纪律】
 * 指标 1、2 只在"真的调了模型"的样本上算。**兜底文案不计入分子**——
 * fallback 里的第一步是从 KB 抄的，天然可执行，混进来会让指标虚高到接近 100%，
 * 那测的就不是模型，是我们自己的模板。所以额外单列 fallback_rate。
 *
 * 用法：
 *   npx tsx scripts/eval.ts                      # 有凭据就跑真模型，没有就如实报"未测量"
 *   npx tsx scripts/eval.ts --provider=mock      # 管道自测（不是模型能力）
 *   npx tsx scripts/eval.ts --provider=broken    # 对抗测试（验证校验器会拦）
 *   npx tsx scripts/eval.ts --show=H06           # 打印某个用例的完整交付包
 */

import { readFileSync } from 'node:fs';
import combosRaw from '../src/data/combos.json' with { type: 'json' };
import { rank } from '../src/lib/scoring.ts';
import type { Combo } from '../src/lib/scoring.ts';
import {
  AnthropicProvider,
  BrokenProvider,
  MockProvider,
  buildExplainContext,
  checkFirstStep,
  explain,
  extractJson,
  pitfallOverlaps,
  renderText,
} from '../src/lib/explain/index.ts';
import type { LLMProvider } from '../src/lib/explain/provider.ts';

const combos = (combosRaw as any).combos as Combo[];
const holdout = JSON.parse(readFileSync(new URL('../tests/d1-holdout.json', import.meta.url), 'utf8'));

const args = process.argv.slice(2);
const flag = (k: string, d = '') => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const providerName = flag('provider', 'auto');
const showId = flag('show', '');

function pickProvider(): LLMProvider {
  if (providerName === 'mock') return new MockProvider();
  if (providerName === 'broken') return new BrokenProvider();
  return new AnthropicProvider();
}

const provider = pickProvider();
const isReal = provider.name === 'anthropic';

interface Row {
  id: string;
  combo: string;
  source: 'llm' | 'fallback';
  attempts: number;
  parsed: boolean | null; // null = 没拿到模型输出（未测量）
  execOk: boolean | null;
  execDetail: string;
  lighter: boolean | null;
  /** 该用例是否存在"更轻的候选"。false 时模型只能写 needed=false，不该算进降档比例分母 */
  hadLighter: boolean;
  issues: string[];
  issuesFull: Array<{ code: string; field: string; detail: string }>;
  transportDetail: string;
  rawText?: string;
  ms: number;
}

async function runOne(cs: any): Promise<Row | null> {
  const r: any = rank(combos, cs.blind_constraint_vector, { raw_input: cs.raw_input });
  if (!r.ok) return null; // 不出方案的用例不参与解释层评测
  const ctx = buildExplainContext(r, combos, cs.blind_constraint_vector);
  const res = await explain({ context: ctx, provider, maxAttempts: 2 });

  const usedLLM = res.source === 'llm';
  const execIssues = checkFirstStep(res.pkg.one_pager.first_step.action, ctx.combo.first_step);

  // 传输层失败（401/超时/网络）意味着"根本没拿到模型输出"，
  // 不能算"解析成功"，也不能算"解析失败"——只能算未测量。
  // 这里踩过一次：第一版把它算成 parsed=true，于是凭据失效时报告"JSON 解析 100%"。
  const transportFailed = res.failure?.stage === 'transport';

  return {
    id: cs.id,
    combo: res.pkg.combo_id,
    source: res.source,
    attempts: res.attempts,
    parsed: transportFailed || res.attempts === 0
      ? null
      : !res.issues.some((i) => i.code.startsWith('parse.')),
    execOk: transportFailed || res.attempts === 0 ? null : usedLLM ? execIssues.length === 0 : null,
    execDetail: usedLLM ? (execIssues[0]?.detail ?? '通过') : '兜底文案（不计入）',
    lighter: transportFailed || res.attempts === 0 ? null : usedLLM ? res.pkg.lighter_alternative.needed : null,
    hadLighter: ctx.lighterCandidates.length > 0,
    issues: [...new Set(res.issues.map((i) => i.code))],
    issuesFull: res.issues,
    transportDetail: res.failure?.detail ?? '',
    rawText: res.raw_text,
    ms: res.latency_ms,
  };
}

const rows: Row[] = [];

async function main() {
  for (const cs of holdout.cases) {
    const row = await runOne(cs);
    if (row) rows.push(row);
  }

  // ---------- 汇总 ----------
  const llmRows = rows.filter((r) => r.parsed !== null);
  const parsedOk = llmRows.filter((r) => r.parsed === true).length;
  const execRows = llmRows.filter((r) => r.execOk !== null);
  const execOk = execRows.filter((r) => r.execOk === true).length;
  const lighterRows = llmRows.filter((r) => r.lighter !== null);
  // 分母修正：没有"更轻候选"的用例，模型**只能**写 needed=false（validate 会拦别的值），
  // 把它们算进分母会让"降档建议比例"永远趋近 0，看起来像模型从不建议降档，其实是题目没给选项。
  const lighterViable = lighterRows.filter((r) => r.hadLighter);
  const fallbackRows = rows.filter((r) => r.source === 'fallback').length;

  const pct = (a: number, b: number) => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`);

  console.log(`\n=== LLM 解释层评测（provider=${provider.name}）===`);
  if (isReal) {
    console.log(
      `模型 ${process.env.ANTHROPIC_MODEL ?? '(默认)'}｜thinking=${process.env.EXPLAIN_THINKING ?? 'disabled(默认)'}｜max_tokens=${process.env.EXPLAIN_MAX_TOKENS ?? 8192}`,
    );
  }
  console.log(`参与用例 ${rows.length} 条（不出方案的用例已排除）\n`);

  console.log('用例  Top1  来源      尝试  JSON解析  第一步可执行  降档  耗时');
  for (const r of rows) {
    const src = r.source === 'llm' ? 'llm    ' : 'fallback';
    const p = r.parsed === null ? '  —  ' : r.parsed ? '  ✓  ' : '  ✗  ';
    const e = r.execOk === null ? '    —    ' : r.execOk ? '    ✓    ' : '    ✗    ';
    // 没有更轻候选时显示"无"而不是"否"——"否"会被读成模型主动拒绝降档，其实是没有可选项
    const l = r.lighter === null ? ' — ' : !r.hadLighter ? ' 无 ' : r.lighter ? ' 是 ' : ' 否 ';
    console.log(`${r.id.padEnd(5)} ${r.combo.padEnd(5)} ${src}  ${String(r.attempts).padEnd(4)} ${p}     ${e}     ${l}  ${r.ms}ms`);
    if (r.issues.length) console.log(`      过程中拦截（含首次尝试）：${r.issues.join(', ')}`);
    // 事实类/动作类拦截要看到具体是哪一句，只看错误码没法判断"该改代码还是该改 prompt"
    for (const i of r.issuesFull) {
      if (i.code.startsWith('fact.') || i.code.startsWith('action.')) {
        console.log(`      · [${i.code}] ${i.field}：${i.detail.slice(0, 150)}`);
      }
    }
    if (r.transportDetail) console.log(`      传输失败：${r.transportDetail.slice(0, 90)}`);
    if (r.execOk === false) console.log(`      第一步问题：${r.execDetail}`);
  }

  console.log('\n=== 三项指标 ===');
  if (llmRows.length === 0) {
    console.log(`  JSON 解析成功率    未测量（0 次有效模型调用）`);
    console.log(`  第一步可执行率      未测量（0 次有效模型调用）`);
    console.log(`  降档建议比例        未测量（0 次有效模型调用）`);
    console.log(`  fallback 比例      ${pct(fallbackRows, rows.length)}（${fallbackRows}/${rows.length}）`);
    console.log('\n  原因：' + (provider.available() ? '所有调用都在传输层失败' : `provider 不可用：${provider.unavailableReason()}`));
    console.log('  说明：本次没有任何模型输出进入评测，上面三项按"未测量"记，不按 0 记、也不按 100% 记。');
  } else {
    const accepted = rows.filter((r) => r.source === 'llm').length;
    const pass1 = parsedOk / llmRows.length > 0.95;
    const pass2 = execRows.length ? execOk / execRows.length > 0.8 : false;
    console.log(`  JSON 解析成功率    ${pct(parsedOk, llmRows.length)}  （${parsedOk}/${llmRows.length}，目标 >95%）${pass1 ? ' ✅' : ' ❌'}`);
    console.log(`  校验通过率          ${pct(accepted, llmRows.length)}  （${accepted}/${llmRows.length}，无阈值，看拦截原因）`);
    if (execRows.length === 0) {
      console.log(`  第一步可执行率      无样本（${llmRows.length} 次输出全部被校验拦截，没有进入交付）`);
      console.log(`  降档建议比例        无样本（同上）`);
    } else {
      console.log(`  第一步可执行率      ${pct(execOk, execRows.length)}  （${execOk}/${execRows.length}，目标 >80%）${pass2 ? ' ✅' : ' ❌'}`);
      const yesViable = lighterViable.filter((r) => r.lighter === true).length;
      console.log(
        `  降档建议比例        ${pct(yesViable, lighterViable.length)}  （${yesViable}/${lighterViable.length} 有效样本；` +
          `全部 ${lighterRows.length} 条里另有 ${lighterRows.length - lighterViable.length} 条无更轻候选，needed 只能为 false）`,
      );
    }
    console.log(`  fallback 比例      ${pct(fallbackRows, rows.length)}（${fallbackRows}/${rows.length}，越低越好）`);
    if (!isReal) {
      console.log(`\n  ⚠️ provider=${provider.name} 是管道自测/对抗测试用的假实现，上面的数字**不代表任何模型能力**。`);
    }
  }

  // ---------- 2-gram 误杀排查 ----------
  // 只在传了 --debug-overlap 时输出。目的：看清"每条坑离阈值有多远"，
  // 而不只是看"有没有被拦"——差一点被拦的那批才是阈值该调的信号。
  if (flag('debug-overlap', '') === '1') {
    console.log('\n=== 2-gram 重合度诊断（阈值 2，低于即判"编造"）===');
    for (const r of rows) {
      if (!r.rawText) continue;
      const json = extractJson(r.rawText);
      if (!json) continue;
      let pkg: any;
      try { pkg = JSON.parse(json); } catch { continue; }
      const cs = holdout.cases.find((c: any) => c.id === r.id);
      const rr: any = rank(combos, cs.blind_constraint_vector, { raw_input: cs.raw_input });
      if (!rr.ok) continue;
      const ctx = buildExplainContext(rr, combos, cs.blind_constraint_vector);
      const rowsOv = pitfallOverlaps(pkg.pitfalls ?? [], ctx.combo.beginner_pitfalls);
      console.log(`\n${r.id}（${r.source}）`);
      for (const o of rowsOv) {
        console.log(`  [${o.i}] source_index=${o.source_index} 重合=${o.overlap} ${o.pass ? '通过' : '❌ 判为编造'}`);
        console.log(`      模型：「${o.text.slice(0, 60)}」`);
        console.log(`      原文：「${o.source.slice(0, 60)}」`);
      }
    }
  }

  if (showId) {
    const cs = holdout.cases.find((c: any) => c.id === showId);
    if (cs) {
      const r: any = rank(combos, cs.blind_constraint_vector, { raw_input: cs.raw_input });
      if (r.ok) {
        const ctx = buildExplainContext(r, combos, cs.blind_constraint_vector);
        console.log(`\n=== ${showId} 上下文里的降档候选（组件数升序）===`);
        if (!ctx.lighterCandidates.length) console.log('  （无：没有组件数更少且通过硬过滤的候选，模型只能写 needed=false）');
        for (const c of ctx.lighterCandidates) {
          console.log(`  ${c.id} 组件数=${(combos.find((x) => x.id === c.id)?.components ?? {}) && Object.keys(combos.find((x) => x.id === c.id)!.components).length} 分=${c.score} 代价=${c.tradeoff.slice(0, 40)}`);
        }
        const res = await explain({ context: ctx, provider, maxAttempts: 2 });
        console.log(`\n=== ${showId} 交付包（source=${res.source}）===`);
        console.log(JSON.stringify(res.pkg, null, 2));
        console.log('\n=== 纯文本渲染 ===');
        console.log(renderText(res.pkg as any));
        if (res.issues.length) {
          console.log('\n=== 被拦下的问题 ===');
          for (const i of res.issues) console.log(`  [${i.code}] ${i.field}: ${i.detail}`);
        }
      }
    }
  }
}

main().catch((e) => {
  console.error('评测脚本自身出错：', e);
  process.exit(1);
});
