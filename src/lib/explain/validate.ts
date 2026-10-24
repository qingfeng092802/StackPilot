/**
 * 校验层：LLM 输出的"兜底闸门"。
 *
 * 设计前提：**不信任 LLM 的任何自述**。它说"这条坑来自第 1 条"不算数，
 * 代码去 `allowed_pitfalls[1]` 取出原文，比对内容；对不上就 reject。
 *
 * 三类失败分开报（code 前缀）：
 *   shape.*     结构不对（缺字段、类型错）→ 通常重试一次就好
 *   fact.*      事实溯源失败（编了坑、编了换方案时机）→ 这是我们要防的那类
 *   action.*    第一步不可执行（废话、没命令、没主工具）→ 这是用户最能感知的烂
 *
 * reject 之后不走"再试三次"，直接降级到模板安全文案（fallback.ts）。
 * 理由：连续两次同样的失败，说明 prompt 对这类输入就是不适配，
 * 再试只是烧 token，而且用户等的是结果不是重试日志。
 */

import type { ExplainContext, ValidationIssue, ValidationResult } from './types.ts';

/** 命令行特征 */
const CMD_RE = /\b(npx|npm|pnpm|yarn|bun|git|pip|pipx|uv|poetry|docker|docker-compose|create-[\w-]+|@nestjs\/cli|degit|uvicorn|vite)\b/i;
/** 具体平台动作（没有命令也必须能立刻做） */
const PLATFORM_RE = /(打开|注册|登录|建一个|新建|创建一个|安装|装|下载|clone|拉到本地|导入)/;
/** 废话：没有任何动作，只有"学习/了解/想想" */
const FILLER_RE = /^(先|要|可以|应该)?\s*(去)?\s*(学习|了解|研究|看看|看下|看一下|想想|考虑|调研|搜一下|查一下)/;
/** 强动作词：出现在废话前缀之后，说明这句话还是落到了具体动作上，不算纯废话 */
const STRONG_ACTION_RE = /(跑|执行|打开|安装|下载|新建|创建|建一个|注册|登录|clone|拉到本地|导入|写|配|部署)/;

/** 从 KB 的 first_step 里抽出"主工具 token"，LLM 写的第一步必须提到其中一个 */
const TOOL_TOKENS: Array<[RegExp, string]> = [
  [/supabase/i, 'supabase'],
  [/next\.?js|create-next-app/i, 'next'],
  [/vite/i, 'vite'],
  [/nuxt/i, 'nuxt'],
  [/svelte|sv create/i, 'svelte'],
  [/fastapi|uvicorn/i, 'fastapi'],
  [/nestjs|@nestjs/i, 'nestjs'],
  [/hono/i, 'hono'],
  [/微信|小程序/i, 'weapp'],
  [/uni-?app|dcloudio/i, 'uniapp'],
  [/docker|postgres/i, 'postgres'],
];

export function toolTokensOf(text: string): string[] {
  return TOOL_TOKENS.filter(([re]) => re.test(text)).map(([, name]) => name);
}

/** 去空白与常见标点，用于"原文片段"子串比对 */
export function norm(s: string): string {
  return String(s ?? '').replace(/[\s，。、；：""''（）()【】\[\]`*_>#-]/g, '');
}

/** 中文字符 2-gram 集合，用于判断"改写"和"原文"是否同源 */
function bigrams(s: string): Set<string> {
  const t = norm(s);
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function overlapCount(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n;
}

/**
 * 覆盖率：a 的 2-gram 有多大比例能在 b 里找到。
 * 1.0 = 整句被 b 完全包含。
 */
function coverageIn(a: string, b: string): number {
  const A = bigrams(a);
  if (A.size === 0) return 0;
  const B = bigrams(b);
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / A.size;
}

/**
 * 照抄程度：双向覆盖率取最大值。
 *
 * 只算一个方向会漏：「照抄 + 加几个字」（"…退回 C01" → "…就该退回 C01 了"）时，
 * 新句子自身的 2-gram 有 4 个是原文没有的，单向覆盖率只有 87.9%，低于 90% 阈值 → 漏网。
 * 但从另一个方向看，**原文的 2-gram 100% 都被搬进来了**，这才是"照抄"的本质特征。
 *
 * 真做了逻辑翻转的句子，两个方向都只有 20% 上下（共用几个词而已）。
 */
function copyRatio(a: string, b: string): number {
  return Math.max(coverageIn(a, b), coverageIn(b, a));
}

/**
 * 量化门槛溯源：抓"源文本里没有的数字门槛"。
 *
 * 【为什么需要这条 · 2026-10-23 真实模型实测发现】
 * H10 里模型给 C02 写的 reconsider_when 是"当日活超过 1 万、或需要复杂服务端定时任务与事务时"，
 * 而 C02 的 when_to_leave 原文是"当需要独立扩缩容后端、或有超过 30 秒的长任务时，考虑 C03 或 C09"。
 * **"日活超过 1 万"在原文里根本不存在，是模型自己加的门槛。**
 * 它却通过了全部校验：source_when_to_leave 是原文逐字片段（过了 source_mismatch），
 * reconsider_when 和原文有 4 个 2-gram 重合（过了 paraphrase_drift 的阈值 3）。
 *
 * 这类幻觉比"编一条坑"更危险：坑是清单式的、用户能对照；而"日活 1 万再换方案"
 * 会被用户当成产品建议记下来，直接误导技术决策。
 *
 * 口径刻意收窄，只抓两类高置信信号：
 *   ① 数字 + 中文量级词（1万 / 3千 / 2倍）
 *   ② 四位以上的纯数字（10000 / 5000）
 * 不抓"30 秒""5 步"这类小数字——它们多半是原文自带或通用量词，误杀代价高于收益。
 */
export function inventedQuantifiers(text: string, source: string): string[] {
  const src = norm(source);
  const hits: string[] = [];
  for (const m of String(text ?? '').matchAll(/(\d+(?:\.\d+)?)\s*(万|千|百|倍)/g)) {
    if (!src.includes(norm(m[1] + m[2]))) hits.push(m[0].replace(/\s+/g, ''));
  }
  for (const m of String(text ?? '').matchAll(/\d{4,}/g)) {
    if (!src.includes(m[0])) hits.push(m[0]);
  }
  return [...new Set(hits)];
}

export function checkFirstStep(action: string, kbFirstStep: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const a = String(action ?? '').trim();
  if (a.length < 6) {
    issues.push({ code: 'action.too_short', field: 'one_pager.first_step.action', detail: `太短（${a.length} 字），看不出要做什么` });
    return issues;
  }
  // 废话判定：【踩过的坑】原来写的是 `FILLER_RE.test(a) && !CMD_RE.test(a)`，
  // 意思是"句子里只要出现命令词就不算废话"。对抗测试发现这等于给废话开后门：
  // 「先去学习一下 Docker 和 K8s 的基本概念」含 Docker → 被豁免 → 一路放行。
  // 而它恰恰是最典型的废话第一步：用户看完还是不知道该敲什么。
  // 改成看"废话前缀之后还有没有落到具体动作上"，与句子里出现哪个工具名无关。
  const fm = a.match(FILLER_RE);
  if (fm && !STRONG_ACTION_RE.test(a.slice(fm[0].length))) {
    issues.push({ code: 'action.filler', field: 'one_pager.first_step.action', detail: `是"${a.slice(0, 12)}…"这类没有动作的话` });
  }
  const hasCmd = CMD_RE.test(a);
  const hasPlatform = PLATFORM_RE.test(a);
  if (!hasCmd && !hasPlatform) {
    issues.push({ code: 'action.not_executable', field: 'one_pager.first_step.action', detail: '既没有命令，也没有具体平台动作（打开/注册/建项目）' });
  }
  const want = toolTokensOf(kbFirstStep);
  const got = toolTokensOf(a);
  if (want.length && !want.some((t) => got.includes(t))) {
    issues.push({
      code: 'action.wrong_tool',
      field: 'one_pager.first_step.action',
      detail: `没提到这套方案的主工具（应含 ${want.join('/')}），写的可能不是这套方案的第一步`,
    });
  }
  return issues;
}

function isNonEmptyStr(x: unknown, max: number): x is string {
  return typeof x === 'string' && x.trim().length > 0 && x.length <= max;
}

/**
 * 诊断用：把每条坑的 2-gram 重合度算出来（不管过不过）。
 * eval.ts 用它判断"阈值是不是太紧"——只看拦截日志，看不到"差一点就被拦"的那批。
 */
export function pitfallOverlaps(
  pf: any[],
  allowed: string[],
): Array<{ i: number; source_index: number; overlap: number; pass: boolean; text: string; source: string }> {
  if (!Array.isArray(pf)) return [];
  return pf.map((p, i) => {
    const idx = Number(p?.source_index);
    const src = Number.isInteger(idx) && idx >= 0 && idx < allowed.length ? allowed[idx] : '';
    const ov = src ? overlapCount(String(p?.text ?? ''), src) : -1;
    return { i, source_index: idx, overlap: ov, pass: ov >= 2, text: String(p?.text ?? ''), source: src };
  });
}

/**
 * 主校验。任何一条 fact.* 或 action.* 失败都判不通过。
 * 长度类问题（shape.too_long）单独标记，但不单独否决——文案略长不是安全问题。
 */
export function validate(pkg: any, ctx: ExplainContext): ValidationResult {
  const issues: ValidationIssue[] = [];
  const push = (code: string, field: string, detail: string) => issues.push({ code, field, detail });

  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return { ok: false, issues: [{ code: 'shape.root', field: '$', detail: '顶层不是对象' }] };
  }

  // ---- combo_id 必须是引擎定的那一个 ----
  if (pkg.combo_id !== ctx.combo.id) {
    push('fact.wrong_combo', 'combo_id', `输出 ${String(pkg.combo_id)}，应为 ${ctx.combo.id}（LLM 无权换方案）`);
  }

  // ---- 一页纸 ----
  const op = pkg.one_pager ?? {};
  if (!isNonEmptyStr(op.headline, 120)) push('shape.headline', 'one_pager.headline', '缺失或超过 120 字');
  if (!isNonEmptyStr(op.why, 400)) push('shape.why', 'one_pager.why', '缺失或超过 400 字');
  const fs_ = op.first_step ?? {};
  if (typeof fs_.minutes !== 'number' || !Number.isFinite(fs_.minutes) || fs_.minutes < 5 || fs_.minutes > 480) {
    push('shape.minutes', 'one_pager.first_step.minutes', '必须是 5–480 的数字');
  }
  issues.push(...checkFirstStep(fs_.action, ctx.combo.first_step));

  // ---- 下一步三步 ----
  const steps = pkg.next_three_steps;
  if (!Array.isArray(steps) || steps.length !== 3) {
    push('shape.steps', 'next_three_steps', `必须是 3 条，实际 ${Array.isArray(steps) ? steps.length : '不是数组'}`);
  } else {
    steps.forEach((s: any, i: number) => {
      if (!isNonEmptyStr(s?.action, 200)) push('shape.steps', `next_three_steps[${i}].action`, '缺失或超长');
      if (typeof s?.minutes !== 'number' || s.minutes < 5 || s.minutes > 480) push('shape.steps', `next_three_steps[${i}].minutes`, '必须是 5–480');
      if (!isNonEmptyStr(s?.blocker, 200)) push('shape.steps', `next_three_steps[${i}].blocker`, '缺失或超长');
    });
  }

  // ---- 不选清单：三段式 + 溯源 ----
  const rejectedById = new Map(ctx.rejected.map((r) => [r.id, r]));
  const nc = pkg.not_chosen;
  if (!Array.isArray(nc) || nc.length < 1 || nc.length > 3) {
    push('shape.not_chosen', 'not_chosen', `必须 1–3 条，实际 ${Array.isArray(nc) ? nc.length : '不是数组'}`);
  } else {
    nc.forEach((it: any, i: number) => {
      const f = `not_chosen[${i}]`;
      const rej = rejectedById.get(String(it?.combo_id));
      if (!rej) {
        push('fact.unknown_combo', `${f}.combo_id`, `${String(it?.combo_id)} 不在被淘汰的候选里（只能从给定候选挑）`);
        return;
      }
      if (!isNonEmptyStr(it?.what, 120)) push('shape.not_chosen', `${f}.what`, '缺失或超长');
      if (!isNonEmptyStr(it?.why, 300)) push('shape.not_chosen', `${f}.why`, '缺失或超长');
      if (!isNonEmptyStr(it?.reconsider_when, 300)) push('shape.not_chosen', `${f}.reconsider_when`, '缺失或超长');

      // 核心：reconsider_when 必须是 when_to_leave 的**逻辑翻转**，不是摘抄。
      //
      // 【这里换过一次判定方向 · 2026-10-24】
      // 旧规则是 paraphrase_drift：reconsider_when 与 when_to_leave 的 2-gram 重合 <3 就判"编造"。
      // 方向反了——when_to_leave 说"什么条件下该离开它"，reconsider_when 说"什么条件下值得重新捡起它"，
      // 两者是互补条件。真做了翻转的句子重合度天然很低，会被判错；
      // 照抄原文的句子重合度 100%，反而一路放行。
      // 实测 H06：模型第一次写对（"当你以后愿意长期维护两套服务时再回头看"）被判错，
      // 重试后照抄（"当团队只有你一个人…退回 C01"）通过——校验器把对的判错、把错的放行。
      // 现在改成：覆盖率 >90% 判"照抄"打回；防编造改由逐字溯源 + 量化门槛两条承担。
      const src = String(it?.source_when_to_leave ?? '');
      const wtl = rej.when_to_leave ?? '';
      if (wtl) {
        if (!src) {
          push('fact.no_source', `${f}.source_when_to_leave`, '没给溯源片段');
        } else if (!norm(wtl).includes(norm(src))) {
          push('fact.source_mismatch', `${f}.source_when_to_leave`, `"${src.slice(0, 20)}…" 不是 ${rej.id} 的 when_to_leave 原文片段`);
        }
        const rec = String(it?.reconsider_when ?? '');
        const cov = norm(rec) === norm(wtl) ? 1 : copyRatio(rec, wtl);
        if (cov > 0.9) {
          push('fact.reconsider_copied', `${f}.reconsider_when`,
            `和 when_to_leave 原文重合 ${(cov * 100).toFixed(0)}%（>90% 判为照抄）。这里要写"翻转后的条件"，不是摘抄｜原文：「${wtl.slice(0, 50)}」`);
        }
        // 量化门槛必须能在原文里查到（"日活超过 1 万"这类凭空造的门槛，见 inventedQuantifiers 注释）
        const q = inventedQuantifiers(rec, wtl);
        if (q.length) {
          push('fact.quantifier_invented', `${f}.reconsider_when`,
            `出现原文没有的量化门槛「${q.join('、')}」，${rej.id} 的 when_to_leave 里查不到`);
        }
      }
    });
  }

  // ---- 坑点：必须逐条溯源 ----
  const pf = pkg.pitfalls;
  if (!Array.isArray(pf) || pf.length < 2 || pf.length > 4) {
    push('shape.pitfalls', 'pitfalls', `必须 2–4 条，实际 ${Array.isArray(pf) ? pf.length : '不是数组'}`);
  } else {
    const allowed = ctx.combo.beginner_pitfalls;
    pf.forEach((p: any, i: number) => {
      const f = `pitfalls[${i}]`;
      const idx = p?.source_index;
      if (!Number.isInteger(idx) || idx < 0 || idx >= allowed.length) {
        push('fact.bad_index', `${f}.source_index`, `${String(idx)} 越界（allowed 只有 0–${allowed.length - 1} 条）`);
        return;
      }
      if (!isNonEmptyStr(p?.text, 300)) {
        push('shape.pitfalls', `${f}.text`, '缺失或超长');
        return;
      }
      // 同源检查：改写句必须和原文有 2-gram 重合，否则可能是编的坑
      const ov = overlapCount(p.text, allowed[idx]);
      if (ov < 2) {
        push('fact.pitfall_invented', `${f}.text`,
          `和第 [${idx}] 条坑 2-gram 重合 ${ov}（阈值 2），疑似编造｜模型原文：「${p.text.slice(0, 50)}」｜源文本：「${allowed[idx].slice(0, 50)}」`);
      }
    });
  }

  // ---- 降档建议 ----
  const la = pkg.lighter_alternative ?? {};
  if (typeof la.needed !== 'boolean') {
    push('shape.lighter', 'lighter_alternative.needed', '必须是布尔值');
  } else if (la.needed === true) {
    const ids = new Set(ctx.lighterCandidates.map((c) => c.id));
    if (!la.combo_id || !ids.has(String(la.combo_id))) {
      push('fact.lighter_unknown', 'lighter_alternative.combo_id',
        `${String(la.combo_id)} 不在更轻的候选里${ids.size ? `（可选：${[...ids].join(',')}）` : '（本次没有更轻的候选，needed 应为 false）'}`);
    }
    if (!isNonEmptyStr(la.why, 300)) push('shape.lighter', 'lighter_alternative.why', '给了降档就必须说明为什么');
  } else if (la.combo_id !== null && la.combo_id !== undefined) {
    push('shape.lighter', 'lighter_alternative.combo_id', 'needed=false 时 combo_id 必须是 null');
  }

  // 只有 fact.* / action.* / shape.root 是否决项；其余 shape.* 也否决（缺字段没法渲染）
  return { ok: issues.length === 0, issues };
}
