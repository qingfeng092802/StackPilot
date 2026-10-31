/**
 * deep_architecture_review 回归测试（v3.1.0）：降维法庭的管道纪律。
 *
 * 三条硬断言（对应延哥验收第 5 条）：
 *   1. 正常 JSON → 完整裁决渲染，闭集判定本地二次校验（不信模型自报）
 *   2. **模型输出乱七八糟的 JSON → 本地解析不崩**，降级渲染原始材料
 *   3. 模型超时 → 阶段降级，工具仍返回可用内容；整条链路在 race 上限内完成
 * 另：闭集外裁决必须落盘 candidates-pending（人工评审材料，不写回闭集）。
 *
 * 用法：npx tsx scripts/test-deep-review.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import combosRaw from '../src/data/combos.json' with { type: 'json' };
import { runDeepReview } from '../mcp/deep-review.ts';
import { renderDeepReview } from '../mcp/render.ts';
import type { LLMProvider } from '../src/lib/explain/provider.ts';
import type { Combo } from '../src/lib/scoring.ts';

const combos = (combosRaw as any).combos as Combo[];

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `｜${extra}` : ''}`); }
}
const group = (t: string) => console.log(`\n${t}`);

/** 脚本化 provider：按调用序返回预设文本 */
function scriptProvider(responses: string[], delayMs = 0): LLMProvider {
  let i = 0;
  return {
    name: 'script',
    available: () => true,
    unavailableReason: () => '',
    async complete() {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const text = responses[Math.min(i, responses.length - 1)];
      i++;
      return { text, usage: { input_tokens: 0, output_tokens: 0 } };
    },
  };
}

const GOOD_PERSPECTIVE = '{"verdict":"该组合在本维度成本可控，主要开销在托管层。","top_risks":["托管费用随日活增长"]}';
const GOOD_REDTEAM = '{"contradictions":["成本视角要求省钱，性能视角要求加缓存，两者冲突"],"blind_spots":["都没提数据迁移"]}';
const GOOD_VERDICT = JSON.stringify({
  headline: '建议 Next.js + Postgres 双层架构，缓存后置',
  recommended_stack: [
    { layer: '前端', choice: 'Next.js', reason: '语料厚，AI 生成成功率高' },
    { layer: '数据', choice: 'PostgreSQL', reason: '约束完整，迁移路径长' },
  ],
  red_team_warnings: ['成本与性能视角冲突，缓存决策被推迟到有真实数据后'],
  plan_b: { trigger: '日活超过万级且缓存成本失控', fallback: '换自建后端 + 独立缓存层' },
  open_questions: ['实时协作的具体延迟要求'],
  combo_id: 'C02',
});
const RAW_INPUT = '我要做一个 0 预算、带实时协作和 AI 辅助的 3D 建模软件，还要支持 10 万人同时在线';

const root = mkdtempSync(join(tmpdir(), 'sp-deep-review-test-'));
// deep-review 的 candidates 落盘路径硬编码在 src/data/candidates-pending/，
// 测试通过断言落盘文件存在来验证（不改变落盘位置——那是产品语义）
process.chdir(root);

try {
  group('一、正常 JSON：完整裁决 + 闭集本地二次校验');
  {
    const r = await runDeepReview({ raw_input: RAW_INPUT }, { provider: scriptProvider([GOOD_PERSPECTIVE, GOOD_PERSPECTIVE, GOOD_PERSPECTIVE, GOOD_REDTEAM, GOOD_VERDICT]), combos });
    ok('三视角全部完成', r.perspectives.every((p) => p.payload !== null));
    ok('红队有矛盾点', (r.redTeam?.contradictions.length ?? 0) >= 1);
    ok('Lead 裁决结构完整', Boolean(r.verdict?.headline && r.verdict.recommended_stack.length >= 2));
    ok('combo_id 本地校验（C02 在闭集）', r.in_closed_set && r.combo?.id === 'C02');
    ok('无降级', r.degraded.length === 0, JSON.stringify(r.degraded));
    // 渲染：纯函数、确定性
    const md = renderDeepReview({ rawInput: RAW_INPUT, ...r });
    const md2 = renderDeepReview({ rawInput: RAW_INPUT, ...r });
    ok('渲染含裁决标题', md.includes('# 深度架构评审'));
    ok('渲染含红队警告', md.includes('⚠️ 红队风险警告'));
    ok('闭集内指路常规工具', md.includes('recommend_stack'));
    ok('渲染两次逐字节一致', md === md2);
  }

  group('二、乱 JSON：本地解析不崩，降级渲染原始材料');
  {
    // 三视角合法（保证流程推进），红队合法，**只有 Lead 输出乱文本**——验收点就是 Lead 乱 JSON 不崩
    const r = await runDeepReview(
      { raw_input: RAW_INPUT },
      { provider: scriptProvider([GOOD_PERSPECTIVE, GOOD_PERSPECTIVE, GOOD_PERSPECTIVE, GOOD_REDTEAM, '法官喝多了，输出一堆没有大括号的散文，也不是合法 JSON']) },
    );
    ok('不抛异常且 ok（有可用视角）', r.ok);
    ok('三视角正常', r.perspectives.every((p) => p.payload !== null));
    ok('Lead 降级被记录', r.degraded.some((d) => d.includes('Lead')), JSON.stringify(r.degraded));
    ok('原始裁决文本保留', Boolean(r.rawVerdictText));
    const md = renderDeepReview({ rawInput: RAW_INPUT, ...r });
    ok('降级渲染含原文区块', md.includes('JSON 解析失败'));
    ok('三视角照常渲染', md.includes('三视角盲评'));
  }

  group('三、超时：阶段降级，链路在 race 上限内返回');
  {
    const t0 = Date.now();
    const r = await runDeepReview(
      { raw_input: RAW_INPUT },
      { provider: scriptProvider([GOOD_PERSPECTIVE, GOOD_PERSPECTIVE, GOOD_PERSPECTIVE, GOOD_REDTEAM, GOOD_VERDICT], 15_000) },
    );
    const elapsed = Date.now() - t0;
    ok('三路全超时仍返回结果', r.perspectives.every((p) => p.payload === null && p.degraded));
    ok('整体耗时 < 15s（12s 视角 race 触发，红队/Lead 因无材料快速跳过）', elapsed < 15_000, `${elapsed}ms`);
    const md = renderDeepReview({ rawInput: RAW_INPUT, ...r });
    ok('降级说明进渲染', md.includes('降级说明'));
  }

  group('四、闭集外裁决：落盘候选，不写回闭集');
  {
    const OUTSIDER = JSON.stringify({
      headline: '建议自研 WebGL 引擎 + 自建信令服务',
      recommended_stack: [{ layer: '渲染', choice: 'WebGPU 自研管线', reason: '闭集无法表达' }],
      red_team_warnings: ['工作量远超预期'],
      plan_b: { trigger: '三个月内做不完', fallback: '降级为 2D' },
      open_questions: [],
      combo_id: null,
    });
    const r = await runDeepReview(
      { raw_input: RAW_INPUT },
      { provider: scriptProvider([GOOD_PERSPECTIVE, GOOD_PERSPECTIVE, GOOD_PERSPECTIVE, GOOD_REDTEAM, OUTSIDER]), combos },
    );
    console.log(`    （dbg: verdict=${Boolean(r.verdict)} degraded=${JSON.stringify(r.degraded)} path=${r.candidatesPath}）`);
    ok('闭集外判定', !r.in_closed_set && r.combo === null);
    ok('候选文件已落盘', Boolean(r.candidatesPath) && existsSync(r.candidatesPath!));
    const saved = JSON.parse(readFileSync(r.candidatesPath!, 'utf8'));
    ok('候选含 verdict 与原话', saved.verdict.headline.includes('WebGL') && saved.raw_input === RAW_INPUT);
    const md = renderDeepReview({ rawInput: RAW_INPUT, ...r });
    ok('渲染含超出闭集提示与实测纪律', md.includes('超出了 StackPilot 当前闭集') && md.includes('node-gyp'));
    // 组合数不变：闭集不被动态修改
    ok('闭集 12 套未被修改', combos.length === 12);
  }
} finally {
  // Windows 下临时目录句柄释放有延迟，清理失败不影响测试结论
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) process.exit(1);
