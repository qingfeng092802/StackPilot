/**
 * 校验器回归测试：用**真实模型产生过的原文**当固定样本，钉死"该拦的必须拦住"。
 *
 * 为什么需要这个文件：真实模型 temperature=0.2，同一条用例跑两次输出不一样。
 * 靠"重跑 eval 看有没有被拦"来验证校验器，等于靠运气——今天没复现不代表漏洞不存在。
 * 所以这里把每一次实测发现的幻觉**抄成固定 fixture**，之后改校验逻辑跑一遍就知道有没有退化。
 *
 * 用法：npx tsx scripts/test-guards.ts
 * 退出码非 0 表示有断言失败。
 */

import { readFileSync } from 'node:fs';
import combosRaw from '../src/data/combos.json' with { type: 'json' };
import { rank } from '../src/lib/scoring.ts';
import type { Combo } from '../src/lib/scoring.ts';
import {
  buildExplainContext,
  buildFallback,
  inventedQuantifiers,
  validate,
} from '../src/lib/explain/index.ts';

const combos = (combosRaw as any).combos as Combo[];
const holdout = JSON.parse(readFileSync(new URL('../tests/d1-holdout.json', import.meta.url), 'utf8'));

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? `｜${extra}` : ''}`);
  }
}

function ctxOf(id: string) {
  const cs = holdout.cases.find((c: any) => c.id === id);
  const r: any = rank(combos, cs.blind_constraint_vector, { raw_input: cs.raw_input });
  if (!r.ok) throw new Error(`${id} 不出方案`);
  return buildExplainContext(r, combos, cs.blind_constraint_vector);
}

const codes = (pkg: any, ctx: any) => validate(pkg, ctx).issues.map((i: any) => i.code);

/** 一份其余字段都合规的 H06 底座包，各用例只替换 not_chosen */
function basePkg(ctx: any, notChosen: any[]) {
  return {
    combo_id: 'C01',
    one_pager: {
      headline: '一个人不写后端也能有数据库',
      why: '你只有一个人、JS 熟练度 0.8，这套把后端和数据库都托管掉',
      first_step: { action: '打开 supabase.com，用 GitHub 登录，新建一个 project', minutes: 10 },
    },
    not_chosen: notChosen,
    next_three_steps: [
      { action: '跑 npx create-next-app@latest 建项目', minutes: 30, blocker: 'Node 版本太低' },
      { action: '装 @supabase/supabase-js 并写 .env.local', minutes: 60, blocker: '变量名拼错' },
      { action: '建表并打开 RLS，写一条 insert', minutes: 120, blocker: 'RLS 策略写错' },
    ],
    pitfalls: [
      { text: ctx.combo.beginner_pitfalls[0], source_index: 0 },
      { text: ctx.combo.beginner_pitfalls[1], source_index: 1 },
    ],
    lighter_alternative: { needed: false, combo_id: null, why: '更轻的候选没有数据库' },
  };
}

// ---------------------------------------------------------------- 1
console.log('\n[1] 逻辑翻转的正确输出必须通过（2026-10-23 这条曾被旧规则误杀）');
{
  // 模型真实输出：「当你以后愿意长期维护两套服务、并且 Python 补上来时再回头看」
  // C03 的 when_to_leave 是「当团队只有你一个人、且不打算长期维护两套服务时，退回 C01」。
  // 旧规则 paraphrase_drift 要求两者重合 ≥3，这条**语义正确**却被判"编造"。
  const ctx = ctxOf('H06');
  const pkg = basePkg(ctx, [{
    combo_id: 'C03',
    what: 'React 前端 + FastAPI 后端两套服务',
    why: '你 Python 只有 0.1，前后端两套语言会同时卡住你',
    reconsider_when: '当你以后愿意长期维护两套服务、并且 Python 补上来时再回头看',
    source_when_to_leave: '当团队只有你一个人、且不打算长期维护两套服务时，退回 C01',
  }]);
  const c = codes(pkg, ctx);
  ok('翻转后的 reconsider_when 通过校验', c.length === 0, c.join(','));
  ok('不再报 fact.paraphrase_drift（旧规则已删）', !c.includes('fact.paraphrase_drift'), c.join(','));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] 照抄 when_to_leave 必须被拦（2026-10-23 这条曾被放行）');
{
  const ctx = ctxOf('H06');
  // 模型重试后的真实输出：把 when_to_leave 一字不改地塞进 reconsider_when。
  // 作为"什么时候回头看 C03"读是自相矛盾的：它说的是"一个人时退回 C01"。
  const copied = basePkg(ctx, [{
    combo_id: 'C03',
    what: 'React 前端 + FastAPI 后端两套服务',
    why: '你 Python 只有 0.1',
    reconsider_when: '当团队只有你一个人、且不打算长期维护两套服务时，退回 C01',
    source_when_to_leave: '当团队只有你一个人、且不打算长期维护两套服务时，退回 C01',
  }]);
  const c1 = codes(copied, ctx);
  ok('逐字照抄被拦', c1.includes('fact.reconsider_copied'), c1.join(','));

  // 照抄 + 加几个字，本质还是照抄
  const almost = basePkg(ctx, [{
    combo_id: 'C03',
    what: 'React 前端 + FastAPI 后端两套服务',
    why: '你 Python 只有 0.1',
    reconsider_when: '当团队只有你一个人、且不打算长期维护两套服务时，就该退回 C01 了',
    source_when_to_leave: '当团队只有你一个人、且不打算长期维护两套服务时，退回 C01',
  }]);
  const c2 = codes(almost, ctx);
  ok('照抄后加几个字仍被拦', c2.includes('fact.reconsider_copied'), c2.join(','));

  // 反向确认：真的翻转了就不该被这条拦
  const flipped = basePkg(ctx, [{
    combo_id: 'C03',
    what: 'React 前端 + FastAPI 后端两套服务',
    why: '你 Python 只有 0.1',
    reconsider_when: '等你有了团队、并且愿意长期维护两套服务时，再回头看它',
    source_when_to_leave: '当团队只有你一个人、且不打算长期维护两套服务时，退回 C01',
  }]);
  ok('真翻转不误杀', !codes(flipped, ctx).includes('fact.reconsider_copied'), codes(flipped, ctx).join(','));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] 真实模型幻觉：reconsider_when 里凭空加量化门槛');
{
  // 2026-10-23 实测 H10 原文。C02 的 when_to_leave 是
  // 「当需要独立扩缩容后端、或有超过 30 秒的长任务时，考虑 C03 或 C09」，
  // 原文没有任何"日活 1 万"的说法。这条当时**通过了全部校验**，是真实漏网案例。
  const ctx = ctxOf('H10');
  const pkg = {
    combo_id: 'C01',
    one_pager: {
      headline: '一个人零预算，今晚就能跑通带登录的网页',
      why: '你只有一个人、预算 0，这套不用写后端代码就有登录和数据库',
      first_step: { action: '打开 supabase.com，用 GitHub 登录，新建一个 project', minutes: 10 },
    },
    not_chosen: [{
      combo_id: 'C02',
      what: 'Next.js 加自建 Postgres',
      why: '要自己建库、写迁移、配连接串，你 SQL 只有 0.2',
      reconsider_when: '当日活超过 1 万、或需要复杂服务端定时任务与事务时',
      source_when_to_leave: '当需要独立扩缩容后端、或有超过 30 秒的长任务时，考虑 C03 或 C09',
    }],
    next_three_steps: [
      { action: '跑 npx create-next-app@latest 建项目', minutes: 30, blocker: 'Node 版本太低' },
      { action: '装 @supabase/supabase-js 并写 .env.local', minutes: 60, blocker: '变量名拼错' },
      { action: '建表并打开 RLS，写一条 insert', minutes: 120, blocker: 'RLS 策略写错' },
    ],
    pitfalls: [
      { text: ctx.combo.beginner_pitfalls[0], source_index: 0 },
      { text: ctx.combo.beginner_pitfalls[1], source_index: 1 },
    ],
    lighter_alternative: { needed: false, combo_id: null, why: '没有更轻的候选' },
  };
  const c = codes(pkg, ctx);
  ok('拦住 fact.quantifier_invented', c.includes('fact.quantifier_invented'), c.join(','));
  ok('"日活 1 万" 被识别为编造门槛',
    inventedQuantifiers(pkg.not_chosen[0].reconsider_when, '当需要独立扩缩容后端、或有超过 30 秒的长任务时，考虑 C03 或 C09').length === 1);

  // 反向：把门槛换回原文自带的 30 秒，必须放行（否则是误杀）
  const okPkg = JSON.parse(JSON.stringify(pkg));
  okPkg.not_chosen[0].reconsider_when = '等你一直不需要独立扩缩容、任务也都在 30 秒以内跑完时';
  ok('原文自带的 30 秒不误杀', !codes(okPkg, ctx).includes('fact.quantifier_invented'), codes(okPkg, ctx).join(','));
}

// ---------------------------------------------------------------- 4
console.log('\n[4] 坑点 2-gram 阈值不应误杀"正常改写"（实测最低重合 13，阈值 2）');
{
  // H06 实测原文：模型把「RLS 没开就上线，任何人都能读到别人的数据」
  // 改写成「上线前一定确认 RLS 已打开，否则任何人都能读到别人的收藏数据」，重合 13。
  const ctx = ctxOf('H06');
  const pkg = basePkg(ctx, [{
    combo_id: 'C11',
    what: '只有前端和 Edge Functions，没有数据库',
    why: '你需要把数据存下来',
    reconsider_when: '等你确认产品不需要登录、也不做多用户共享时，它才够用',
    source_when_to_leave: '当需要登录、需要多用户共享数据、或需要按用户做配额时，离开这套，改用 C01',
  }]);
  pkg.pitfalls = [
    { text: 'Supabase 国内访问不稳定，第一次连不上别急着改代码，先确认是不是网络问题。', source_index: 0 },
    { text: 'service_role key 绝对不能写进前端环境变量，写进去等于把全部数据权限公开。', source_index: 1 },
    { text: '上线前一定确认 RLS 已打开，否则任何人都能读到别人的收藏数据。', source_index: 2 },
  ];
  const c = codes(pkg, ctx);
  ok('三条改写全部放行（无误杀）', c.length === 0, c.join(','));
}

// ---------------------------------------------------------------- 5
console.log('\n[5] 兜底文案也必须满足同一份契约（翻转、不照抄、可溯源）');
{
  for (const id of ['H01', 'H04', 'H06', 'H10']) {
    const ctx = ctxOf(id);
    const fb = buildFallback(ctx);
    const c = codes(fb, ctx);
    ok(`${id} 兜底包通过校验`, c.length === 0, c.join(','));
  }
  // 兜底文案的 reconsider_when 不能和 when_to_leave 一模一样
  const ctx = ctxOf('H06');
  const fb = buildFallback(ctx);
  const same = fb.not_chosen.filter((n) => n.reconsider_when.trim() === n.source_when_to_leave.trim());
  ok('兜底文案没有逐字照抄 when_to_leave', same.length === 0, `${same.length} 条照抄`);
}

// ---------------------------------------------------------------- 6
console.log('\n[6] 该拦的仍然要拦：编造的坑 / 越界索引 / 换方案 / 废话第一步');
{
  const ctx = ctxOf('H06');
  const pkg = {
    combo_id: 'C99',
    one_pager: {
      headline: '用 Kubernetes + Istio 上微服务',
      why: '业界最流行',
      first_step: { action: '先去学习一下 Docker 和 K8s 的基本概念', minutes: 30 },
    },
    // 说明：combo_id 本身不合法时校验器只报 fact.unknown_combo 就 return（不再纠缠溯源），
    // 所以"溯源造假"要用一条**合法候选**来测。
    not_chosen: [
      {
        combo_id: 'C88',
        what: '别的方案',
        why: '不如这个好',
        reconsider_when: '永远不会',
        source_when_to_leave: '我编的一句话',
      },
      {
        combo_id: ctx.rejected[0].id,
        what: '一个真实候选',
        why: '分数不够',
        reconsider_when: '永远不会',
        source_when_to_leave: '我编的一句话',
      },
    ],
    next_three_steps: [{ action: '继续学习', minutes: 60, blocker: '概念太多' }],
    pitfalls: [
      { text: '记得配置 Prometheus 监控和 Grafana 面板', source_index: 99 },
      { text: '上线前记得做压测', source_index: 0 },
    ],
    lighter_alternative: { needed: true, combo_id: 'C77', why: '可以试试更轻的' },
  };
  const c = codes(pkg, ctx);
  for (const want of ['fact.wrong_combo', 'action.filler', 'action.wrong_tool', 'fact.unknown_combo', 'fact.source_mismatch', 'shape.steps', 'fact.bad_index', 'fact.pitfall_invented', 'fact.lighter_unknown']) {
    ok(`拦住 ${want}`, c.includes(want), c.join(','));
  }
}

// ---------------------------------------------------------------- 7
console.log('\n[7] 量化门槛检查本身不应过度敏感');
{
  ok('小数字（30 秒 / 5 步 / 2 个人）不算量化门槛', inventedQuantifiers('超过 30 秒的长任务、5 步以内、2 个人', '').length === 0);
  ok('四位数字算量化门槛', inventedQuantifiers('用户到 5000 再换', '').length === 1);
  ok('原文有的四位数字放行', inventedQuantifiers('用户到 5000 再换', '当用户到 5000 时换').length === 0);
  ok('组合 ID 里的数字不算', inventedQuantifiers('改用 C01', '').length === 0);
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
