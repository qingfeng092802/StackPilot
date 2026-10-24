/**
 * 输出侧验证材料生成器（M1 第一阶段）
 * ------------------------------------------------------------------
 * 用途：从 D1 的盲标样本里挑 3 条，生成"给真人看的一页纸方案"。
 *
 * 为什么要脚本生成而不是手写：
 *   手写会和引擎实际输出漂移。这份材料的全部意义是"用户看到的 = 引擎产出的"，
 *   一旦手抄，验证的就不是产品，是我的文笔。改引擎后重跑本脚本即可。
 *
 * 运行：node --experimental-strip-types scripts/gen-preview.ts
 * 产出：docs/output-validation-preview.md
 *
 * ⚠️ 本脚本不回答"用户会不会照着开始"——那是接下来要拿给真人问的。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { rank, notChosenForUI, type Combo, type ConstraintVector } from '../src/lib/scoring.ts';
import { COMPONENT_NAMES, SLOT_LABELS, componentLabel } from '../src/data/component-names.ts';

const combos: Combo[] = JSON.parse(
  readFileSync(new URL('../src/data/combos.json', import.meta.url), 'utf8')
).combos;
const holdout = JSON.parse(readFileSync(new URL('../tests/d1-holdout.json', import.meta.url), 'utf8'));

const DELIVERY_CN: Record<string, string> = {
  web: '网页', miniprogram: '微信小程序', desktop: '桌面客户端', api: '纯 API 服务',
  agent: 'Agent', cli: '命令行工具', selfhost: '自部署（服务器 / NAS）',
};
const GOAL_CN: Record<string, string> = {
  internal_tool: '内部工具 —— 最快跑通、最低运维',
  product: '对外产品 —— 能维护、能扩容、能招人',
  portfolio: '作品集 —— 看起来专业，但必须能跑通',
};
const CAP_CN: Record<string, string> = {
  auth: '登录', payment: '支付', ai: 'AI 能力', realtime: '实时同步',
  file_upload: '用户在前端选 / 传文件', file_storage: '服务端要存文件',
  data_persistence: '数据要留存（换设备还在）',
  file: '文件（旧标注：上传 + 存储）', multi_platform: '一套代码多端',
};
const COMPLIANCE_CN: Record<string, string> = {
  personal_data: '涉及个人隐私数据', payment: '涉及支付合规',
};

function fieldRows(v: ConstraintVector): string {
  const rows: string[] = [];
  const put = (label: string, val: string) => rows.push(`| ${label} | ${val} |`);

  put('交付形态', v.delivery ? DELIVERY_CN[v.delivery] ?? v.delivery : '（没提到）');
  put('几个人做', v.team_size ?? '（没提到）');
  if (v.ai_workflow) {
    const CN: Record<string, string> = { full_auto: '全让 AI 写', assisted: 'AI 写我来改', learning: '自己写为主' };
    put('AI 参与方式', CN[v.ai_workflow] ?? v.ai_workflow);
  } else {
    put('AI 参与方式', '（没提到）');
  }
  put('多久要能用', v.timeline_weeks ? `${v.timeline_weeks} 周` : '（没提到）');
  put('每月预算', v.budget_cny_month === null || v.budget_cny_month === undefined ? '（没提到）' : `¥${v.budget_cny_month}`);
  put('预计用户量', v.expected_users === null || v.expected_users === undefined ? '（没提到）' : `${v.expected_users} 人`);
  put('需要哪些能力',
    v.required_capabilities && v.required_capabilities.length
      ? v.required_capabilities.map((c) => CAP_CN[c] ?? c).join('、')
      : '（标注为 []：原文既没说需要什么，也没说不需要）');
  put('合规要求',
    v.compliance && v.compliance.length
      ? v.compliance.map((c) => COMPLIANCE_CN[c] ?? c).join('、')
      : '（没提到）');
  put('做来干什么', v.goal_type ? GOAL_CN[v.goal_type] ?? v.goal_type : '（没提到）');
  return ['| 字段 | 引擎读出的值 |', '|---|---|', ...rows].join('\n');
}

function comboBlock(c: Combo, score: number, tag: string): string {
  const rows = Object.entries(c.components)
    .map(([slot, id]) => `| ${SLOT_LABELS[slot] ?? slot} | ${componentLabel(id as string | null)} |`)
    .join('\n');
  const parts: string[] = [];
  parts.push(`**${tag}：${c.id} ${c.name}** —— ${score} 分`, '');
  parts.push(`> ${c.one_liner}`, '');
  parts.push('| 层 | 组件 |', '|---|---|', rows, '');
  if (c.beginner_pitfalls && c.beginner_pitfalls.length) {
    parts.push('**新手最容易踩的坑**', '');
    for (const p of c.beginner_pitfalls) parts.push(`- ${p}`);
    parts.push('');
  }
  if (c.when_to_leave) parts.push(`**什么时候该离开这套**：${c.when_to_leave}`, '');
  return parts.join('\n');
}

/** 每条样本要问的 3 个问题：分别对应一个待验证假设 */
const QUESTIONS: Record<string, [string, string, string]> = {
  H05: [
    '这份方案说"你不需要后端，纯静态就够了"——这和你原本想的一样吗？如果不一样，你更信谁，为什么？',
    '今晚你会照着它开始吗？如果会，第一步你会打开什么、敲什么；如果不会，是哪一句话让你停下来了？',
    '如果它推荐的前端是 React，而你其实想用 Vue，你会觉得这份方案没用了，还是仍然有用（只是换掉前端）？',
  ],
  H06: [
    '我们在原文里读到"同一个浏览器下次打开能接着上次听"，于是判断"数据要留存、需要数据库"。这个判断对吗？',
    '方案给你的是 Next.js + Supabase（带数据库）。你会照着开始吗？如果不会，是"要学的东西太多"还是"你不认同这个架构"？',
    '如果换成"纯静态 + 浏览器本地存"，你能接受吗？不能的话，缺的是什么功能？',
  ],
  H03: [
    '你的需求是桌面客户端，我们直接说了"当前覆盖不了、给不出方案"。你觉得这是在帮你，还是在敷衍你？',
    '如果只能给你一个网页版方案（功能会打折），你会考虑改形态吗？还是宁可自己做桌面端？',
    '你愿意留个联系方式，等我们支持桌面端时通知你吗？（这是在测"需求收集"这个动作有没有人响应）',
  ],
};

function renderCase(id: string): string {
  const cs = holdout.cases.find((c: any) => c.id === id);
  const v = cs.blind_constraint_vector as ConstraintVector;
  const r = rank(combos, v, { raw_input: cs.raw_input });
  const out: string[] = [];

  out.push(`## 案例：${id}`, '');
  out.push(`### 1. 用户原始输入（原文，未改写）`, '');
  out.push(`> ${cs.raw_input.replace(/\n/g, '\n> ')}`, '');
  out.push(`### 2. 引擎读出的约束`, '');
  out.push(fieldRows(v), '');

  if (r.ok && r.inferred_capabilities.length) {
    out.push(
      `> **引擎自己补了一条**：\`${r.inferred_capabilities.join('、')}\`` +
        `（依据：${r.inference_evidence ?? '原文'}）。` +
        `这一条用户没直说，是推断出来的——请重点问用户认不认。`,
      ''
    );
  }
  if (!r.ok) {
    const REASON_CN: Record<string, string> = {
      uncovered: '超出模板库覆盖范围',
      low_confidence: '信息不足，需要先追问',
      insufficient_candidates: '约束互相打架，过滤后剩不下 2 套',
    };
    out.push(`### 3. 引擎的输出：**不出方案**`, '');
    out.push(`| 项 | 内容 |`, `|---|---|`);
    out.push(`| 判定 | ${REASON_CN[r.reason] ?? r.reason}（\`coverage_status = ${r.coverage_status}\` ｜ \`confidence = ${r.confidence}\`） |`);
    out.push(`| 给用户的话 | ${r.suggestion} |`);
    out.push(`| 是否收集需求 | ${r.collect_entry ? '是（记进"待支持形态"清单）' : '否'} |`);
    out.push('');
    out.push(`**为什么不给方案**：${cs.ground_truth.fe_detail}`);
    out.push('');
    out.push(`> 这不是"算不出来"，是"闭集里确实没有这类模板"。硬凑一个网页方案给桌面端需求，`);
    out.push(`> 比直接说"没有"更伤信任。`);
    out.push('');
  } else {
    out.push(`### 3. 引擎的输出：一套主推 + 一套备选`, '');
    out.push(`状态：\`coverage_status = ${r.coverage_status}\` ｜ \`confidence = ${r.confidence}\``);
    if (r.confidence_warning) out.push(`\n> ⚠️ ${r.confidence_warning}`);
    out.push('');
    const t1 = combos.find((c) => c.id === r.top1.id)!;
    const t2 = combos.find((c) => c.id === r.top2.id)!;
    out.push(comboBlock(t1, r.top1.score, '主推'), '');
    out.push('---', '');
    out.push(comboBlock(t2, r.top2.score, '备选（换了架构形态）'), '');
    out.push('### 4. 不选清单（"为什么不选那个"）', '');
    const nc = notChosenForUI(r);
    if (!nc.length) {
      out.push('（本次没有可展示的落选项）');
    } else {
      out.push('| 层级 | 方案 | 分数 | 理由 |', '|---|---|---|---|');
      for (const it of nc) out.push(`| ${it.tier} | ${it.id} | ${it.score != null ? it.score.toFixed(2) : '—'} | ${it.reason} |`);
    }
    out.push('');
  }

  const q = QUESTIONS[id];
  out.push(`### ${r.ok ? '5' : '4'}. 要问用户的 3 个问题`, '');
  q.forEach((x, i) => out.push(`${i + 1}. ${x}`));
  out.push('');
  out.push('---', '');
  return out.join('\n');
}

function renderHX1(): string {
  const cs = holdout.supplementary.find((c: any) => c.id === 'HX1');
  const r = rank(combos, cs.blind_constraint_vector, { raw_input: cs.raw_input });
  const out: string[] = [];
  out.push('## 附：信息不足时长什么样（HX1，3/9 字段）', '');
  out.push('> 这一条不进主材料，但如果访谈时用户问"我什么都没想清楚，你能给吗"，用这个回答。', '');
  out.push(`**原始输入**：${cs.raw_input}`, '');
  out.push(`**引擎行为**：不出方案（\`reason = ${!r.ok ? r.reason : 'ok'}\`，\`confidence = ${r.confidence}\`）`, '');
  if (!r.ok && r.questions.length) {
    out.push('**它会反过来问用户**：', '');
    for (const q of r.questions) out.push(`- ${q}`);
  }
  out.push('');
  out.push('---', '');
  return out.join('\n');
}

// ────────────────────────────────────────────────────────────
const CASES = ['H05', 'H06', 'H03'];

const head = `# 输出侧验证材料（M1 第一阶段）

> **这份文件不是产品文档，是访谈材料。** 里面的方案全部由 \`scripts/gen-preview.ts\`
> 从引擎真实输出生成，没有任何人工润色。引擎改了，重跑脚本即可。
>
> 生成时间：2026-10-23 ｜ 样本来源：D1 盲标（V2EX /go/create 真实产品帖）

## 一、这份材料要验证什么

产品假设是「**用户需要技术栈选型，并且愿意照着给出的方案开始**」。
D1 只证明了前半句（需求存在），后半句一条证据都没有。这三个案例分别压一个假设：

| 案例 | 场景类型 | 压的假设 |
|---|---|---|
| H05 | 纯静态、零后端（新加的 C12 覆盖） | **架构判断被接受**：用户认不认"你不需要后端" |
| H06 | 带数据库、真实取舍复杂 | **愿意照着开始**：认不认架构 + 会不会真动手 |
| H03 | 桌面端，闭集覆盖不了 | **拒绝的方式被接受**：说"没有"比硬凑更可信吗 |

每个案例的 3 个问题，第 1 题压"认知是否对齐"，第 2 题压"行动意愿"，第 3 题压"边界是否可接受"。

## 二、访谈纪律（重要）

1. **不要解释我们的实现**。不要提"打分引擎""闭集""fit 乘数"。用户看到的就是一份方案。
2. **先让用户自己读完整份，再开口**。中途打断会把你的措辞混进他的理解。
3. **记录原话，不要记录你的总结**。"他说还行"没有信息量，"他说'Supabase 我听都没听过'"才有。
4. **不要引导**。问"你会照着开始吗"，不要问"你是不是觉得这个方案挺清楚的"。
5. **不要替用户回答第 2 题**。哪怕你觉得他肯定不会做，也要等他自己说。

---

`;

const tail = `## 三、访谈后要填的表（每条一份）

| 项 | 记录 |
|---|---|
| 用户背景（会不会写代码 / 做过什么） | |
| 第 1 题：架构判断认同吗（原话） | |
| 第 2 题：会不会照着开始（原话） | |
| 第 3 题：框架不同会不会否定整份方案（原话） | |
| 卡住他的第一句话 / 第一个词 | |
| 我自己观察到但没问出来的 | |

**汇总判据**（与 ADR-001 §9 一致）：3–5 人里 **≥2 人**说"会照着开始"，且能说出具体第一步，
才算输出侧成立。一个都没有 → 转 No-Go 或 pivot 成"选型对比表"。
`;

const body = CASES.map(renderCase).join('\n') + '\n' + renderHX1() + '\n';
const md = head + body + tail;

const OUT = new URL('../docs/output-validation-preview.md', import.meta.url);
writeFileSync(OUT, md);

console.log('已生成 docs/output-validation-preview.md');
console.log(`  案例 ${CASES.length} 个：${CASES.join(', ')}（+ 附录 HX1）`);
console.log(`  字符数 ${md.length}`);
for (const id of CASES) {
  const cs = holdout.cases.find((c: any) => c.id === id);
  const r = rank(combos, cs.blind_constraint_vector, { raw_input: cs.raw_input });
  console.log(`  ${id}: ${r.ok ? `Top1=${r.top1.id}（${r.top1.score} 分，confidence=${r.confidence}）` : `不出方案（${r.reason}）`}`);
}
