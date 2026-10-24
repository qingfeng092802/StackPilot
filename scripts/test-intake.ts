/**
 * 解析层（F1）回归测试：钉死"模型想猜的时候，代码必须把它按住"。
 *
 * 这一层的测试重点和解释层完全不同。
 * 解释层的断言是"该拦的幻觉必须拦住"——拦不住是 bug，拦多了也是 bug。
 * 解析层的断言只有一句话：**原文里没有的东西，一个都不许进向量**。
 *
 * 为什么不能靠"跑一遍真实模型看结果对不对"：
 *   temperature=0.2 下模型有时老实、有时手痒。今天它老实，明天它填个
 *   skills.js=0.6，两次都"看起来合理"，肉眼根本分不出哪个是编的。
 *   所以这里用**桩 provider** 精确复现"模型手痒的每一种姿势"，
 *   断言代码层一定把它丢掉，并且丢掉的原因能被说清楚。
 *
 * 用法：npx tsx scripts/test-intake.ts
 * 退出码非 0 表示有断言失败。
 */

import { intake, parseIntake } from '../src/lib/intake/index.ts';
import type { LLMProvider } from '../src/lib/explain/provider.ts';
import type { LLMResponse } from '../src/lib/explain/provider.ts';

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

const group = (t: string) => console.log(`\n${t}`);

/** 桩 provider：按给定脚本依次返回响应，最后一条重复使用 */
function stub(responses: (Partial<LLMResponse> | Error)[], available = true): LLMProvider {
  let i = 0;
  return {
    name: 'stub',
    available: () => available,
    unavailableReason: () => '桩：故意不可用',
    async complete() {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      if (r instanceof Error) throw r;
      return { text: '', ...r } as LLMResponse;
    },
  };
}

const droppedFields = (p: { dropped: { field: string }[] }) => p.dropped.map((d) => d.field);

// ────────────────────────────────────────────────────────────
// 一、evidence 溯源：不是原文的连续片段，一律丢
// ────────────────────────────────────────────────────────────

group('一、evidence 必须是原文的逐字连续片段');

{
  const raw = '我想做个帮人记账的小程序，大概 10 个人用，我会一点 Python';

  // 模型把 evidence 改写成概括
  const p1 = parseIntake(raw, {
    delivery: { value: 'miniprogram', evidence: '用户想做一个记账类的小程序应用' },
  });
  ok('改写过的 evidence 被丢（"记账类的小程序应用"不在原文里）',
    p1.vector.delivery === undefined && droppedFields(p1).includes('delivery'),
    JSON.stringify(p1.dropped));

  // 模型把分开的两处拼起来
  const p2 = parseIntake(raw, {
    team_size: { value: '1', evidence: '我会一点 Python' },
  });
  ok('evidence 是真片段但读不出该枚举值 → 丢',
    p2.vector.team_size === undefined, JSON.stringify(p2.dropped));

  // 正常片段
  const p3 = parseIntake(raw, {
    delivery: { value: 'miniprogram', evidence: '做个帮人记账的小程序' },
  });
  ok('真片段 + 关键词对得上 → 采纳，且 evidence 原样保留',
    p3.vector.delivery === 'miniprogram' && p3.evidence.delivery === '做个帮人记账的小程序');
}

// ────────────────────────────────────────────────────────────
// 二、枚举值必须能从 evidence 里读出来
// ────────────────────────────────────────────────────────────

group('二、枚举值必须和 evidence 里的关键词对得上');

{
  const raw = '我想做个网页，能随机听世界各地的电台，就我自己用';

  const p = parseIntake(raw, {
    delivery: { value: 'miniprogram', evidence: '我想做个网页' },
  });
  ok('说"网页"却填 miniprogram → 丢（这正是解析层最典型的幻觉）',
    p.vector.delivery === undefined && p.dropped.some((d) => d.reason.includes('miniprogram')),
    JSON.stringify(p.dropped));

  const p2 = parseIntake(raw, {
    delivery: { value: 'web', evidence: '我想做个网页' },
    team_size: { value: '1', evidence: '就我自己用' },
  });
  ok('网页 + 就我自己用 → 两项都采纳',
    p2.vector.delivery === 'web' && p2.vector.team_size === '1');

  const p3 = parseIntake('人不多，随便做做', {
    team_size: { value: '2-3', evidence: '人不多' },
  });
  ok('「人不多」不许填 team_size（"人不多"不是"2-3 人"）',
    p3.vector.team_size === undefined, JSON.stringify(p3.dropped));
}

// ────────────────────────────────────────────────────────────
// 三、空数组必须来自明确的否定表述
// ────────────────────────────────────────────────────────────

group('三、capabilities=[] 只能来自"明确说不要"，不能来自沉默');

{
  const p1 = parseIntake('想做个记账的小程序', {
    capabilities: { values: [], evidence: '想做个记账的小程序' },
  });
  ok('没有否定词的空数组 → 丢（否则模型可以用任意一句话宣布"什么都不需要"）',
    p1.vector.required_capabilities === undefined && droppedFields(p1).includes('required_capabilities'));

  const p2 = parseIntake('想做个记账的小程序，不要账号', {
    capabilities: { values: [], evidence: '不要账号' },
  });
  ok('「不要账号」→ 采纳空数组（这是信息，不是缺失）',
    Array.isArray(p2.vector.required_capabilities) && p2.vector.required_capabilities.length === 0);

  const p3 = parseIntake('要能微信登录，还要能上传文件', {
    capabilities: { values: ['auth', 'file_upload', 'payment'], evidence: '要能微信登录，还要能上传文件' },
  });
  ok('多值里只保留 evidence 读得出的（payment 被丢，auth/file_upload 留下）',
    JSON.stringify(p3.vector.required_capabilities) === JSON.stringify(['auth', 'file_upload']),
    JSON.stringify(p3.vector.required_capabilities));
}

// ────────────────────────────────────────────────────────────
// 四、skills：最容易"给个合理值"的字段
// ────────────────────────────────────────────────────────────

group('四、skills 不许猜（用户没说语言/程度就不给数值）');

{
  // 用户只说"会一点代码"，模型自作主张填了 js
  const raw = '我会一点代码';
  const p1 = parseIntake(raw, {
    skills: [{ lang: 'js', level: 'beginner', evidence: '我会一点代码' }],
  });
  ok('「会一点代码」填成 skills.js=0.3 → 丢（没说语言）',
    p1.vector.skills === undefined, JSON.stringify(p1.dropped));

  // 用户说了语言但没说程度
  const p2 = parseIntake('我会 Python', {
    skills: [{ lang: 'python', level: 'basic', evidence: '我会 Python' }],
  });
  ok('「我会 Python」填成 level=basic → 丢（没说程度，不该给 0.5）',
    p2.vector.skills === undefined, JSON.stringify(p2.dropped));

  // 都说了
  const p3 = parseIntake('我会一点 Python', {
    skills: [{ lang: 'python', level: 'beginner', evidence: '我会一点 Python' }],
  });
  ok('「会一点 Python」→ 采纳，python=0.3（数值由代码查表，不是模型给的）',
    p3.vector.skills?.python === 0.3, JSON.stringify(p3.vector.skills));

  // "*" 只在 none 时合法
  const p4 = parseIntake('我完全不会写代码', {
    skills: [{ lang: '*', level: 'none', evidence: '我完全不会写代码' }],
  });
  ok('「完全不会写代码」→ 全部语言 0 分（这是"不会"的完整编码，不是猜）',
    p4.vector.skills?.js === 0 && p4.vector.skills?.python === 0 && p4.vector.skills?.ops === 0);

  const p5 = parseIntake('我完全不会写代码', {
    skills: [{ lang: '*', level: 'beginner', evidence: '我完全不会写代码' }],
  });
  ok('"*" 配 level=beginner → 丢（自相矛盾）', p5.vector.skills === undefined);

  // evidence 提到语言但程度词对不上
  const p6 = parseIntake('我会一点 Python', {
    skills: [{ lang: 'python', level: 'expert', evidence: '我会一点 Python' }],
  });
  ok('「会一点」被填成 expert → 丢', p6.vector.skills === undefined);
}

// ────────────────────────────────────────────────────────────
// 五、数值：只接受 amount + unit，换算在代码里做
// ────────────────────────────────────────────────────────────

group('五、数值字段：evidence 里没数字就不许有数值');

{
  const p1 = parseIntake('大概十个人用', {
    expected_users: { amount: 10, evidence: '大概十个人用' },
  });
  ok('「大概十个人用」→ 10', p1.vector.expected_users === 10);

  const p2 = parseIntake('人不多', {
    expected_users: { amount: 20, evidence: '人不多' },
  });
  ok('「人不多」填成 20 → 丢（evidence 里没有数字）',
    p2.vector.expected_users === undefined, JSON.stringify(p2.dropped));

  const p3 = parseIntake('希望两周内能用', {
    timeline: { amount: 2, unit: 'week', evidence: '希望两周内能用' },
  });
  ok('「两周」→ timeline_weeks=2', p3.vector.timeline_weeks === 2);

  const p4 = parseIntake('一个月内搞定', {
    timeline: { amount: 1, unit: 'month', evidence: '一个月内搞定' },
  });
  ok('「一个月」→ 4 周（换算是代码做的，模型只说 amount+unit）', p4.vector.timeline_weeks === 4);

  const p5 = parseIntake('半年内', {
    timeline: { amount: 6, unit: 'month', evidence: '半年内' },
  });
  ok('「半年」→ 26 周', p5.vector.timeline_weeks === 26);

  const p6 = parseIntake('预算每月一百块', {
    budget: { amount: 1200, unit: 'year', evidence: '预算每月一百块' },
  });
  ok('年付 1200 → 每月 100', p6.vector.budget_cny_month === 100);

  const p7 = parseIntake('预算随便', {
    budget: { amount: 100, unit: 'month', evidence: '预算随便' },
  });
  ok('「预算随便」填成 100 → 丢', p7.vector.budget_cny_month === undefined);
}

// ────────────────────────────────────────────────────────────
// 六、intake() 全流程
// ────────────────────────────────────────────────────────────

group('六、intake() 全流程：缺失字段 → 追问');

const GOOD_JSON = JSON.stringify({
  delivery: { value: 'miniprogram', evidence: '做个帮人记账的小程序' },
  team_size: null,
  skills: [{ lang: 'python', level: 'beginner', evidence: '我会一点 Python' }],
  timeline: null,
  budget: null,
  expected_users: { amount: 10, evidence: '大概 10 个人用' },
  capabilities: null,
  compliance: null,
  goal_type: null,
});

// 项目没有 package.json（零依赖，全靠 npx tsx），tsx 按 CJS 转译，
// 顶层 await 会直接报 "Top-level await is currently not supported"。
// 所以异步断言全部收进 main()，同步断言留在外面。
async function main() {
  const r = await intake({
    raw_input: '我想做个帮人记账的小程序，大概 10 个人用，我会一点 Python',
    provider: stub([{ text: GOOD_JSON }]),
  });
  ok('ok=true', r.ok === true);
  ok('采纳 delivery / skills / expected_users',
    r.parsed.delivery === 'miniprogram' && r.parsed.skills?.python === 0.3 && r.parsed.expected_users === 10);
  ok('没说的字段全进 missing（timeline/budget/team_size 等）',
    ['team_size', 'timeline_weeks', 'budget_cny_month', 'required_capabilities', 'compliance', 'goal_type']
      .every((f) => r.missing.includes(f)), JSON.stringify(r.missing));
  ok('追问不超过 3 个', r.questions.length <= 3, `${r.questions.length}`);
  ok('追问按优先级：skills 已有值，所以第一个问的是 delivery 或 goal_type',
    r.questions[0].field === 'delivery' || r.questions[0].field === 'goal_type',
    r.questions.map((q) => q.field).join(','));
  ok('每个追问都带可渲染的控件定义', r.questions.every((q) => q.type && q.question));
  ok('置信度是 low（核心组缺 required_capabilities，补充组缺 4 项）',
    r.confidence === 'low', r.confidence);

  // 9 个字段全有值 → high → 不该再问
  const FULL = JSON.stringify({
    delivery: { value: 'web', evidence: '做个网页' },
    team_size: { value: '1', evidence: '就我自己' },
    skills: [{ lang: 'js', level: 'proficient', evidence: '我 JS 比较熟' }],
    timeline: { amount: 2, unit: 'month', evidence: '两个月内上线' },
    budget: { amount: 0, unit: 'month', evidence: '预算 0' },
    expected_users: { amount: 50, evidence: '50 个人用' },
    capabilities: { values: [], evidence: '不要账号' },
    compliance: { values: [], evidence: '不涉及隐私' },
    goal_type: { value: 'product', evidence: '对外做产品' },
  });
  const r2 = await intake({
    raw_input: '做个网页，就我自己，我 JS 比较熟，两个月内上线，预算 0，50 个人用，不要账号，不涉及隐私，对外做产品',
    provider: stub([{ text: FULL }]),
  });
  ok('信息齐全 → high 且一个问题都不问（再问就是打扰）',
    r2.confidence === 'high' && r2.questions.length === 0,
    `${r2.confidence} / ${r2.questions.length} / missing=${r2.missing.join(',')}`);

  group('七、失败路径：解析不出来要能说清是哪一段坏的');

  const f1 = await intake({ raw_input: '我想做个网页', provider: stub([{ text: '抱歉，我无法完成。' }]) });
  ok('输出里没有 JSON → ok=false, stage=parse', f1.ok === false && f1.failure?.stage === 'parse');
  ok('失败时 parsed 是空对象，不会带半份向量往下走', Object.keys(f1.parsed).length === 0);

  const f2 = await intake({ raw_input: '我想做个网页', provider: stub([{ text: '{}', stopReason: 'max_tokens' }]) });
  ok('被 max_tokens 截断 → 报 parse 且详情写"截断"，不能报成"模型不会写 JSON"',
    f2.ok === false && f2.failure?.stage === 'parse' && f2.failure.detail.includes('截断'),
    JSON.stringify(f2.failure));

  const f3 = await intake({ raw_input: '我想做个网页', provider: stub([{ text: GOOD_JSON }], false) });
  ok('provider 不可用 → stage=transport，且提示改用手动填表',
    f3.failure?.stage === 'transport' && f3.failure.detail.includes('手动填表'), JSON.stringify(f3.failure));

  const f4 = await intake({ raw_input: '网页', provider: stub([{ text: GOOD_JSON }]) });
  ok('输入太短 → stage=validate', f4.failure?.stage === 'validate', JSON.stringify(f4.failure));

  group('八、重试：第一次不合法，第二次合法 → 只重试一次就成功');

  const rt = await intake({
    raw_input: '我想做个帮人记账的小程序，大概 10 个人用，我会一点 Python',
    provider: stub([{ text: '这是你要的：{坏了' }, { text: GOOD_JSON }]),
  });
  ok('第一次坏 JSON、第二次好 JSON → ok=true', rt.ok === true);

  group('九、notes：让"模型想猜什么"可见');

  const n = await intake({
    raw_input: '我会一点代码，想做个工具',
    provider: stub([{
      text: JSON.stringify({
        delivery: { value: 'web', evidence: '想做个工具' },
        skills: [{ lang: 'js', level: 'beginner', evidence: '我会一点代码' }],
      }),
    }]),
  });
  ok('被丢弃的字段写进 notes（这是"模型想猜什么"的证据）',
    n.notes.some((x) => x.includes('没被采纳')), JSON.stringify(n.notes));
  ok('delivery 也丢了（"工具"读不出 web）', n.parsed.delivery === undefined);

  group('十、超出范围就别追问（问完再说"做不了"最招人烦）');

  const desk = await intake({
    raw_input: '帮我做个桌面软件，用来管理我的照片，就我自己用',
    provider: stub([{
      text: JSON.stringify({
        delivery: { value: 'desktop', evidence: '做个桌面软件' },
        team_size: { value: '1', evidence: '就我自己用' },
      }),
    }]),
  });
  ok('delivery=desktop → coverage_status=uncovered',
    desk.coverage_status === 'uncovered', desk.coverage_status);
  ok('uncovered 时一个问题都不问（问了也用不上）',
    desk.questions.length === 0, `${desk.questions.length}`);
  ok('uncovered 时 notes 说明为什么不问了',
    desk.notes.some((x) => x.includes('不再追问')), JSON.stringify(desk.notes));

  // ────────────────────────────────────────────────────────
  // v1.6.0 极性修复：data_persistence 读反
  // ────────────────────────────────────────────────────────
  // 原文用 H06 的真实原句「收藏只存浏览器里」（用户口述里写成了 H01，但 H01 的原文
  // 只有「还能收藏喜欢的」，没有"只存浏览器"这层意思，用它测不到极性）。
  group('十二、data_persistence 极性：说了"只存浏览器"就不许读成"要存服务端"');

  const LOCAL_RAW = '想做个网页，打开就能随机听世界各地电台，收藏只存浏览器里，不要账号，也不要广告';

  // 模型读对：给 no_persistence
  const right = await intake({
    raw_input: LOCAL_RAW,
    provider: stub([{
      text: JSON.stringify({
        delivery: { value: 'web', evidence: '想做个网页' },
        capabilities: { values: ['no_persistence'], evidence: '收藏只存浏览器里' },
      }),
    }]),
  });
  ok('「收藏只存浏览器里」→ 采纳 no_persistence',
    JSON.stringify(right.parsed.required_capabilities) === JSON.stringify(['no_persistence']),
    JSON.stringify(right.parsed.required_capabilities));
  ok('采纳后 required_capabilities 不再进 missing（用户不会被多问一次）',
    !right.missing.includes('required_capabilities'), JSON.stringify(right.missing));

  // 模型读反：给 data_persistence
  const wrong = await intake({
    raw_input: LOCAL_RAW,
    provider: stub([{
      text: JSON.stringify({
        delivery: { value: 'web', evidence: '想做个网页' },
        capabilities: { values: ['data_persistence'], evidence: '收藏只存浏览器里' },
      }),
    }]),
  });
  ok('读反成 data_persistence → 丢弃，不进向量',
    !(wrong.parsed.required_capabilities ?? []).includes('data_persistence'),
    JSON.stringify(wrong.parsed.required_capabilities));
  ok('丢弃理由点明"极性反了"，而不是含糊的"读不出"',
    wrong.dropped.some((d) => d.reason.includes('极性反了')), JSON.stringify(wrong.dropped));

  // 关键词表拦不住的写法：evidence 同时含「存」和「localStorage」
  const tricky = parseIntake('数据存到 localStorage 就行，不用后端', {
    capabilities: { values: ['data_persistence'], evidence: '存到 localStorage 就行' },
  });
  ok('「存到 localStorage 就行」不能算 data_persistence（含"存"字，关键词表会放行，靠极性检查拦）',
    tricky.vector.required_capabilities === undefined, JSON.stringify(tricky.dropped));

  // 真·服务端持久化仍然要认
  const server = parseIntake('要能记录历史，换台电脑也能看到我的收藏', {
    capabilities: { values: ['data_persistence'], evidence: '要能记录历史' },
  });
  ok('「要能记录历史」→ data_persistence 照常采纳（别修过头）',
    JSON.stringify(server.vector.required_capabilities) === JSON.stringify(['data_persistence']),
    JSON.stringify(server.vector.required_capabilities));

  // 两个都填：分两种情况，结论不同
  //   (a) evidence 本身能定性（"只存浏览器里"）→ 先按极性把错的那个丢掉，
  //       剩下的 no_persistence 是**正确**答案，不该连带丢掉
  //   (b) evidence 不能定性（"要存数据"）→ 无法判断，两个都丢，交给追问
  const bothLocal = parseIntake(LOCAL_RAW, {
    capabilities: { values: ['data_persistence', 'no_persistence'], evidence: '收藏只存浏览器里' },
  });
  ok('(a) evidence 说了"只存浏览器" → 丢掉错的 data_persistence，留下对的 no_persistence',
    JSON.stringify(bothLocal.vector.required_capabilities) === JSON.stringify(['no_persistence']),
    JSON.stringify(bothLocal.vector.required_capabilities));

  const bothVague = parseIntake('数据要存起来', {
    capabilities: { values: ['data_persistence', 'no_persistence'], evidence: '数据要存起来' },
  });
  ok('(b) evidence 不能定性 → 两个都不采纳（不替用户做决定）',
    bothVague.vector.required_capabilities === undefined && bothVague.dropped.some((d) => d.reason.includes('自相矛盾')),
    JSON.stringify(bothVague.dropped));

  // 反向能力也要能配别的能力一起用
  const mixed = parseIntake('做个网页，要能 AI 生成名字，收藏只存浏览器里', {
    capabilities: { values: ['ai', 'no_persistence'], evidence: '要能 AI 生成名字' },
  });
  ok('no_persistence 和别的能力可以共存（"收藏只存浏览器里"不是这段 evidence，会被关键词检查拦）',
    JSON.stringify(mixed.vector.required_capabilities) === JSON.stringify(['ai']),
    JSON.stringify(mixed.vector.required_capabilities));

  // H01 的原文没有极性信息，两个都不该出现
  const h01 = await intake({
    raw_input: '我想给她做个网站，输入英文名能生成几个候选中文名，每个都带拼音、字义解释和文化背景，能按性别和风格筛，还能收藏喜欢的。就她和她同事用，量很小。',
    provider: stub([{
      text: JSON.stringify({
        delivery: { value: 'web', evidence: '我想给她做个网站' },
        capabilities: { values: ['ai'], evidence: '输入英文名能生成几个候选中文名' },
      }),
    }]),
  });
  ok('H01 原文（「还能收藏喜欢的」）不产生 no_persistence——"收藏"本身不是极性证据',
    !(h01.parsed.required_capabilities ?? []).includes('no_persistence'),
    JSON.stringify(h01.parsed.required_capabilities));

  group('十三、字段名对不上要能自己暴露（曾经静默漏读一整个字段）');

  const wrongKey = await intake({
    raw_input: '做个网页，不要账号',
    provider: stub([{
      // 模型把向量字段名当成了输出字段名
      text: JSON.stringify({ delivery: { value: 'web', evidence: '做个网页' }, required_capabilities: { values: [], evidence: '不要账号' } }),
    }]),
  });
  ok('模型写成 required_capabilities → 记进 dropped，而不是静默当成"没填"',
    wrongKey.dropped.some((d) => d.field === 'required_capabilities' && d.reason.includes('不是约定的字段名')),
    JSON.stringify(wrongKey.dropped));
  ok('此时 required_capabilities 确实进 missing（用户会被问一次，不会带着错值往下走）',
    wrongKey.missing.includes('required_capabilities'));

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试脚本自身异常：', e);
  process.exit(1);
});

