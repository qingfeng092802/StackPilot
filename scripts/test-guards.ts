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
/**
 * 【v1.7.0 改造】不再硬编码 C03。
 *
 * 原来这三组都写死 `combo_id: 'C03'`，理由是"C03 一定在 rejected 里"。
 * v1.7.0 调了权重与 fit 规则之后 C03 排到了 runnerUps 更后面，不再进 rejected，
 * 于是三组全线报 `fact.unknown_combo`——**测的不是校验器坏了，是测试自己烂了**。
 *
 * 候选排序本来就会随权重调整而变，测试不该依赖某个组合恰好排在哪儿。
 * 所以改成：从 ctx.rejected 里挑，并且**显式断言挑到的确实在里面**，
 * 这样将来排序再变，失败信息会直接说"这个组合不在 rejected 里"，
 * 而不是一个让人以为校验器出问题的 unknown_combo。
 */
function rejectedOf(ctx: any, prefer?: string) {
  const list: any[] = ctx.rejected ?? [];
  const it = (prefer && list.find((x) => x.id === prefer)) || list[0];
  if (!it) throw new Error('ctx.rejected 为空，无法构造 not_chosen 用例');
  return { id: it.id, name: it.name, when: String(it.when_to_leave ?? '') };
}

console.log('\n[1] 逻辑翻转的正确输出必须通过（2026-10-23 这条曾被旧规则误杀）');
{
  const ctx = ctxOf('H06');
  // 取一个"因为中文教程少而被淘汰"的候选（C05 Nuxt + Supabase）
  const r = rejectedOf(ctx, 'C05');
  const pkg = basePkg(ctx, [{
    combo_id: r.id,
    what: r.name,
    why: 'Vue 的中文教程比 React 少，找资料会多花点时间',
    reconsider_when: '当你能找到足够多的中文教程、或者不介意看英文文档时，它仍然值得选',
    source_when_to_leave: r.when,
  }]);
  const c = codes(pkg, ctx);
  ok('翻转后的 reconsider_when 通过校验', c.length === 0, c.join(','));
  ok('不再报 fact.paraphrase_drift（旧规则已删）', !c.includes('fact.paraphrase_drift'), c.join(','));
}

// ---------------------------------------------------------------- 2
console.log('\n[2] 照抄 when_to_leave 必须被拦（2026-10-23 这条曾被放行）');
{
  const ctx = ctxOf('H06');
  const r = rejectedOf(ctx, 'C05');

  // 把 when_to_leave 一字不改地塞进 reconsider_when：
  // 作为"什么时候回头看这套"读是自相矛盾的——它说的是"什么时候离开它"。
  const copied = basePkg(ctx, [{
    combo_id: r.id,
    what: r.name,
    why: 'Vue 生态的中文资料少',
    reconsider_when: r.when,
    source_when_to_leave: r.when,
  }]);
  const c1 = codes(copied, ctx);
  ok('逐字照抄被拦', c1.includes('fact.reconsider_copied'), c1.join(','));

  // 照抄 + 加几个字，本质还是照抄
  const almost = basePkg(ctx, [{
    combo_id: r.id,
    what: r.name,
    why: 'Vue 生态的中文资料少',
    reconsider_when: r.when.replace(/。?$/, '了'),
    source_when_to_leave: r.when,
  }]);
  const c2 = codes(almost, ctx);
  ok('照抄后加几个字仍被拦', c2.includes('fact.reconsider_copied'), c2.join(','));

  // 反向确认：真的翻转了就不该被这条拦
  const flipped = basePkg(ctx, [{
    combo_id: r.id,
    what: r.name,
    why: 'Vue 生态的中文资料少',
    reconsider_when: '当你能找到足够多的中文教程时，再回头看它',
    source_when_to_leave: r.when,
  }]);
  ok('真翻转不误杀', !codes(flipped, ctx).includes('fact.reconsider_copied'), codes(flipped, ctx).join(','));
}

// ---------------------------------------------------------------- 3
console.log('\n[3] 真实模型幻觉：reconsider_when 里凭空加量化门槛');
{
  // 2026-10-23 实测的真实漏网案例：模型在 reconsider_when 里塞了原文没有的数字门槛。
  // 这里仍用 H10 的上下文，但组合改成动态取——原文里没有任何"日活 1 万"的说法。
  const ctx = ctxOf('H10');
  const r = rejectedOf(ctx);
  const pkg = basePkg(ctx, [{
    combo_id: r.id,
    what: r.name,
    why: '这套对你现在来说太重了',
    reconsider_when: '当日活超过 1 万、团队扩到 3 人以上时，再考虑这套',
    source_when_to_leave: r.when,
  }]);
  const c = codes(pkg, ctx);
  ok('拦住 fact.quantifier_invented', c.includes('fact.quantifier_invented'), c.join(','));

  // 反向确认：不带量化门槛的合法翻转，不该被这条误杀
  const okPkg = basePkg(ctx, [{
    combo_id: r.id,
    what: r.name,
    why: '这套对你现在来说太重了',
    reconsider_when: '当你真的需要多人协作时，再回头看这套',
    source_when_to_leave: r.when,
  }]);
  ok('不带量化门槛的合法翻转不误杀', !codes(okPkg, ctx).includes('fact.quantifier_invented'),
    codes(okPkg, ctx).join(','));
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
