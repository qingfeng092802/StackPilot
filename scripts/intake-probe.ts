/**
 * 解析层实跑探针：拿真实模型跑几条大白话，把「读到了什么 / 想编什么 / 追问什么」原样打出来。
 *
 * 和 test-intake.ts 的分工：
 *   test-intake.ts 用桩 provider，钉死代码层的拦截逻辑（可重复、不花钱）；
 *   本脚本用真模型，暴露"prompt 到底管不管得住它"（不可重复，要人看）。
 * 两者缺一不可：只有桩测试会看不见模型真的在猜什么，只有实跑会看见"这次没猜"就以为没事了。
 *
 * 用法：
 *   set -a; . ./.env.local; set +a; npx tsx scripts/intake-probe.ts
 *   set -a; . ./.env.local; set +a; npx tsx scripts/intake-probe.ts --only=3
 */

import { intake } from '../src/lib/intake/index.ts';
import { AnthropicProvider } from '../src/lib/explain/provider.ts';

const CASES: { id: string; text: string; note: string }[] = [
  {
    id: 'A',
    note: '标准示例：三个字段说清了，六个没说',
    text: '我想做个帮人记账的小程序，大概 10 个人用，我会一点 Python',
  },
  {
    id: 'B',
    note: '全是陷阱：没有语言、没有程度、没有交付形态、没有人数量级',
    text: '我会一点代码，想做个东西给同事用',
  },
  {
    id: 'C',
    note: 'H06 简化版：有否定表述（不要账号），有隐性持久化（只存浏览器里）',
    text: '想做个网页，打开就能随机听世界各地电台，收藏只存浏览器里，不要账号，也不要广告',
  },
  {
    id: 'D',
    note: '超出范围：桌面客户端。解析层必须如实读出 desktop，交给引擎去拒绝',
    text: '帮我做个桌面软件，用来管理我的照片，就我自己用',
  },
  {
    id: 'E',
    note: '内部工具 + 明确人数 + 明确预算，看它会不会自己补 skills',
    text: '想给公司内部做个查资料的网页，就我们组三个人用，不要账号，预算每月 100 块',
  },
];

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);

async function main() {
  const provider = new AnthropicProvider();
  if (!provider.available()) {
    console.error('没有凭据：先 set -a; . ./.env.local; set +a');
    process.exit(1);
  }

  for (const c of CASES) {
    if (only && c.id !== only) continue;
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`【${c.id}】${c.note}`);
    console.log(`原文：${c.text}`);

    const t0 = Date.now();
    const r = await intake({ raw_input: c.text, provider });
    const ms = Date.now() - t0;

    if (!r.ok) {
      console.log(`  ✗ 解析失败（${r.failure?.stage}）：${r.failure?.detail}  [${ms}ms]`);
      continue;
    }

    console.log(`\n  读到（${Object.keys(r.evidence).length} 项）：`);
    for (const [k, v] of Object.entries(r.evidence)) {
      const val = JSON.stringify((r.parsed as any)[k]);
      console.log(`    ${k.padEnd(22)} = ${val.padEnd(34)} ← 「${v}」`);
    }

    if (r.dropped.length) {
      console.log(`\n  丢掉（${r.dropped.length} 项）—— 模型想编什么：`);
      for (const d of r.dropped) {
        console.log(`    ${d.field.padEnd(22)} 它填了 ${d.model_value.slice(0, 40).padEnd(42)} 理由：${d.reason}`);
      }
    } else {
      console.log(`\n  丢掉（0 项）—— 这次一个都没编`);
    }

    console.log(`\n  还缺：${r.missing.join('、') || '（无）'}`);
    console.log(`  追问（${r.questions.length}）：`);
    for (const q of r.questions) console.log(`    · ${q.question}  [${q.field}/${q.type}]`);
    console.log(`  confidence=${r.confidence}  耗时 ${ms}ms`);
    for (const n of r.notes) console.log(`  · ${n}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
