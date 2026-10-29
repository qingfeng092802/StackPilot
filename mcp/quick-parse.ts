/**
 * 无 API key 时的**规则解析**（MCP 的降级路径）。
 *
 * 为什么需要它：MCP Server 要被 Cursor / Claude Code 直接调用，而调用者往往
 * **没有配置模型 key**。如果没 key 就整个不可用，这个工具的实际采用率会是零。
 *
 * 所以分两条路：
 *   有 key  → 走 intake()，由模型抽取，evidence 逐字校验（准确，但要花钱、要等）
 *   没 key  → 走这里，纯关键词规则（免费、即时、可解释，但只认明确说出口的词）
 *
 * 这一层**故意保守**：只认那些"写出来就一定是这个意思"的词，
 * 认不出的一律留空交给默认值，并在输出里标出来。
 * 宁可少读，也不要猜——猜出来的字段会一路影响到选型和解释。
 *
 * ⚠️ 它和 src/lib/intake/validate.ts 的关键词表有重叠，但**不共用**：
 * 那边是"校验模型输出"用的，要求 evidence 逐字对得上；
 * 这边是"自己从原文里找"，没有模型输出可校验。混用会让两边都变脆。
 */

import type { ConstraintVector, DeliveryForm, AiWorkflow, Capability } from '../src/lib/scoring.ts';

export interface QuickParseHit {
  field: string;
  value: string;
  evidence: string;
}

export interface QuickParseResult {
  vector: ConstraintVector;
  hits: QuickParseHit[];
  /** 这一层没能力判断的字段，交给调用方决定要不要追问 */
  unknown: string[];
  /**
   * 用默认值兜住的字段。**必须原样透出到输出里**——
   * 用户/agent 看到"假定是网页"才知道结论是建立在什么前提上的。
   * 偷偷补默认值比直接拒绝更糟：拒绝是明确的，偷偷补是让人以为读懂了。
   */
  assumed: string[];
}

const DELIVERY: Array<[DeliveryForm, string[]]> = [
  ['miniprogram', ['小程序', '微信小程序']],
  ['web', ['网页', '网站', 'web', 'Web', 'H5', '浏览器']],
  ['desktop', ['桌面', '客户端', 'exe', '安装包']],
  ['cli', ['命令行', 'CLI', '终端工具']],
  ['selfhost', ['自建', '自己部署', 'NAS', '私有化部署']],
  ['api', ['API', '接口服务']],
  ['agent', ['Agent', '智能体', '机器人']],
];

/** 强信号：本身就是"AI 在写代码"的名字，单独出现即可 */
const AI_STRONG = ['vibe coding', 'vibecoding', 'cursor', 'copilot', 'windsurf', 'claude code'];
/** 弱信号：可能指产品功能或用户画像，必须搭配"写代码"的动作词 */
const AI_WEAK = ['ai', 'agent', 'claude', 'gpt', 'chatgpt', 'deepseek', '大模型', '智能体'];
const AI_ACTS = ['帮我写', '替我写', '帮我生成', '替我生成', '写代码', '生成代码', '写程序', '生成程序', '敲代码', '自然语言让', '写出来'];

const LEARNING_KW = ['想学', '借这个学', '借这个项目学', '边做边学', '学习', '练手', '自己写为主', '主要自己写', '自己动手', '想练'];
const ASSISTED_KW = ['我来改', '我会改', '自己改', '自己调', '我会看', '看得懂', '能看懂', '改一改'];

const CAPS: Array<[Capability, string[]]> = [
  ['auth', ['登录', '账号', '注册', 'sign in', '用户体系']],
  ['payment', ['支付', '付款', '收费', '订阅费']],
  /**
   * ⚠️ 这里**不能**只匹配 "AI" 三个字。
   * "让 AI 帮我写" 说的是**谁写代码**，不是"产品要 AI 功能"。
   * 早先版本用 /AI\s/ 匹配，于是 Vibe Coding 那句被读成"需要 AI 能力"，
   * C12 因此被硬排除——结论碰巧是对的（推 C01），但理由是错的，
   * 换一句不带 AI 的话就会翻车。所以只认明确指向**产品功能**的词。
   */
  ['ai', ['AI 功能', 'AI 能力', '智能问答', 'AI 生成内容', '接入 AI', '调用大模型', '大模型接口', 'GPT 接口']],
  ['realtime', ['实时', '多人同时', '同步协作']],
  ['file_upload', ['上传文件', '上传图片', '上传发票', '传照片']],
  ['file_storage', ['存文件', '文件存储', '存图片']],
];

const NO_PERSIST_KW = ['只存浏览器', '存浏览器', '存在本地', '不需要存', '不用存', '不要数据库', 'localStorage', '清缓存'];
const PERSIST_KW = ['记录历史', '存服务端', '换设备也能看到', '多设备同步', '保存到数据库'];

const GOAL: Array<[string, string[]]> = [
  ['internal_tool', ['内部', '给同事', '自己用', '团队用', '公司内部']],
  ['portfolio', ['作品集', '练手项目', '放简历']],
  ['product', ['对外', '做产品', '上线给用户', '商业化']],
];

const TEAM: Array<[string, string[]]> = [
  ['1', ['只有我', '就我', '一个人', '我自己']],
  ['2-3', ['两个人', '三个人', '几个人', '我们组', '小团队']],
  ['5+', ['五个人', '团队十几', '十几个人', '一个团队']],
];

function firstHit(text: string, kws: string[]): string | null {
  for (const k of kws) if (text.includes(k)) return k;
  return null;
}

// ────────────────────────────────────────────────────────────
// 中文数量解析（v2.0.0）
//
// 为什么敢在这层做数字了（注释里原来写着"不做"）：此前不做是因为没有
// 确定性的换算规则。现在的实现把每一步换算都写成代码里的固定映射，
// 与 intake/validate.ts 对数值字段的要求同构：可复算、可审计。
//
// 两条铁律：
//   1. 只认"写出来就是数量"的形态（数字 + 单位 / 固定约数词），认不出就留空
//   2. 约数词（十来个 / 几十 / 百八十）一律取**保守下界**并写进 assumed——
//      低估用户量的代价（成本维度偏松）远小于高估（可能误触发万级硬排除）
// ────────────────────────────────────────────────────────────

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * 中文数字 → 数值。支持标准读法到万级（十五万、一百二十、两千）。
 * 口语省略读法（"两千五"=2500）不支持——解析成 2005 是错值，宁可留空。
 * 不合法返回 null（调用方当没读到）。
 */
export function cnToInt(s: string): number | null {
  const t = String(s ?? '').trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (!t || !/^[零〇一二两三四五六七八九十百千万]+$/.test(t)) return null;
  // 口语省略读法（"两千五"=2500、"百八十"≈80~120）不是标准读法，
  // 标准算法会算出错值（2005 / 180），宁可拒绝留空。
  if (/[千百][一二两三四五六七八九]$/.test(t)) return null;
  if (/^百[一二两三四五六七八九十]{1,2}$/.test(t)) return null;

  // 分段算法：unit（十百千）把 digit 乘上去累积进 section；万 结算一个段
  let total = 0;
  let section = 0;
  let digit = -1; // -1 = 当前没有待挂到单位上的数字
  for (const ch of t) {
    if (CN_DIGIT[ch] !== undefined) {
      digit = CN_DIGIT[ch];
      continue;
    }
    if (ch === '十') { section += (digit < 0 ? 1 : digit) * 10; digit = -1; continue; }
    if (ch === '百') { section += (digit < 0 ? 1 : digit) * 100; digit = -1; continue; }
    if (ch === '千') { section += (digit < 0 ? 1 : digit) * 1000; digit = -1; continue; }
    if (ch === '万') {
      total = (total + section + Math.max(0, digit)) * 10000;
      section = 0;
      digit = -1;
      continue;
    }
  }
  const r = total + section + Math.max(0, digit);
  return r > 0 ? r : null;
}

const CN_NUM = '[0-9]+|[零〇一二两三四五六七八九十百千]{1,8}';
const num = (m: RegExpMatchArray) => cnToInt(m[1]);

/** 明确的"数字 + 人用/用户"形态 → expected_users（这是读出来的，进 hits） */
const USERS_RES: Array<{ re: RegExp; label: string }> = [
  { re: new RegExp(`(?:大概|大约|预计|差不多|约)?\\s*(${CN_NUM})\\s*(?:个|位)?\\s*(?:人|用户|使用者)\\s*(?:来)?\\s*(?:用|使用|访问|注册|在线)`), label: '数字+人用' },
  { re: new RegExp(`(?:用户|日活|月活|注册用户|使用者)(?:量|数)?\\s*(?:大约|大概|约|在)?\\s*(${CN_NUM})(?:\\s*(?:个|人|位))?`), label: '用户量+数字' },
];

/** 约数词 → 保守下界。命中进 assumed，不进 hits */
const FUZZY_USERS: Array<[RegExp, number, string]> = [
  [/十来个?(?:人|用户)?/, 10, '十来个 → 按下界 10 计'],
  [/十几个人?/, 11, '十几个 → 按下界 11 计'],
  [/几十个?(?:人|用户)?/, 20, '几十 → 按下界 20 计'],
  [/百八十(?:个|人)?/, 80, '百八十 → 按下界 80 计'],
  [/上百(?:个|人)?/, 100, '上百 → 按下界 100 计'],
  [/上千(?:个|人)?/, 1000, '上千 → 按下界 1000 计'],
  [/上万(?:个|人)?/, 10000, '上万 → 按下界 10000 计'],
];

/** 数字 + 时间单位 → timeline_weeks（换算写死在这里，可复算） */
const TIMELINE_RE = new RegExp(`(${CN_NUM}|半)\\s*个?\\s*(天|日|周|星期|礼拜|月|年)`);

/** 预算：只认"月/年"周期明确的形态。例外：金额为 0 无需周期（"预算 0"语义完整） */
const BUDGET_RES: Array<{ re: RegExp; unit: 'month' | 'year'; label: string }> = [
  { re: new RegExp(`每?个?月\\s*(?:的)?\\s*(?:预算|成本|服务|花销|花)?\\s*(?:不超过|最多|至多|以内)?\\s*(${CN_NUM})\\s*(?:块|元)?`), unit: 'month', label: '每月+数字' },
  { re: /预算\s*0(?!\d)/, unit: 'month', label: '预算 0' },
  { re: new RegExp(`(?:预算|成本)\\s*(${CN_NUM})\\s*(?:块|元)?\\s*(?:每个?月|一月|\\/月|每月)`), unit: 'month', label: '预算+数字/月' },
  { re: new RegExp(`(${CN_NUM})\\s*(?:块|元)\\s*(?:每?个?月|一月|\\/月|每月)`), unit: 'month', label: '数字+元/月' },
  { re: new RegExp(`(${CN_NUM})\\s*(?:块|元)\\s*(?:一?年)`), unit: 'year', label: '数字+元/年' },
];

interface NumParse {
  value: number;
  evidence: string;
}

function parseExpectedUsers(raw: string): { hit: NumParse | null; fuzzy: string | null } {
  // 约数表必须**先于**明确数字查：否则「几十个人用」会被明确数字正则从中间
  // 抽出「十个人用」读成 10，「百八十人」会被读成 180——都是错值。
  // 约数模式（十来/十几/几十/百八十/上百…）和明确数字不重叠，先行不会误伤。
  for (const [re, lower, note] of FUZZY_USERS) {
    const m = raw.match(re);
    if (m) return { hit: null, fuzzy: `${m[0]}：${note}` };
  }
  for (const { re, label } of USERS_RES) {
    const m = raw.match(re);
    if (m) {
      const v = num(m as RegExpMatchArray);
      if (v !== null && v > 0 && v <= 1e9) {
        return { hit: { value: v, evidence: `${m[0]}（${label}）` }, fuzzy: null };
      }
    }
  }
  return { hit: null, fuzzy: null };
}

function parseTimelineWeeks(raw: string): NumParse | null {
  const m = raw.match(TIMELINE_RE);
  if (!m) return null;
  const amount = m[1] === '半' ? 0.5 : cnToInt(m[1]);
  if (amount === null || amount <= 0) return null;
  const unit = m[2];
  const weeks =
    unit === '天' || unit === '日' ? Math.max(1, Math.round(amount / 7))
    : unit === '周' || unit === '星期' || unit === '礼拜' ? Math.round(amount)
    : unit === '月' ? Math.max(1, Math.round(amount * 4.345))
    : Math.max(1, Math.round(amount * 52));
  return { value: weeks, evidence: `${m[0]}（换算 ${weeks} 周）` };
}

function parseBudget(raw: string): NumParse | null {
  for (const { re, unit, label } of BUDGET_RES) {
    const m = raw.match(re);
    if (m) {
      const v = cnToInt(m[1]);
      if (v !== null && v >= 0) {
        const month = unit === 'month' ? v : Math.round(v / 12);
        return { value: month, evidence: `${m[0]}（${label}，折合 ${month} 元/月）` };
      }
    }
  }
  return null;
}

export function quickParse(rawInput: string): QuickParseResult {
  const raw = String(rawInput ?? '');
  const lower = raw.toLowerCase();
  const vector: ConstraintVector = {
    delivery: null, team_size: null, ai_workflow: null,
    timeline_weeks: null, budget_cny_month: null, expected_users: null,
    required_capabilities: [], compliance: [], goal_type: null,
  };
  const hits: QuickParseHit[] = [];

  const assumed: string[] = [];

  // delivery
  for (const [val, kws] of DELIVERY) {
    const k = firstHit(raw, kws);
    if (k) { vector.delivery = val; hits.push({ field: 'delivery', value: val, evidence: k }); break; }
  }
  /**
   * 原文没说形态时**假定为网页**。
   *
   * 为什么敢假定：delivery 在核心组里，缺了就会把结论压成"信息不足"，
   * 而 MCP 这个入口的契约是"给一套方案"，不是"反问一轮"（反问在 Cursor 里
   * 会打断调用方的节奏）。12 套组合里 9 套都是 Web 形态，假定成 Web 的
   * 错误代价最小，且**明确写在输出的"用了默认值"里**。
   * 如果调用方知道不是网页，直接在 raw_input 里说"小程序/桌面"就会被读到。
   */
  if (!vector.delivery) {
    vector.delivery = 'web';
    assumed.push('delivery → web（原文没说交付形态，按最常见的网页假定）');
  }

  // ai_workflow：强信号单独生效，弱信号必须配动作词
  const strong = AI_STRONG.find((k) => lower.includes(k));
  const weak = AI_WEAK.find((k) => lower.includes(k));
  const act = AI_ACTS.find((k) => raw.includes(k));
  const learn = firstHit(raw, LEARNING_KW);
  const assist = firstHit(raw, ASSISTED_KW);

  let wf: AiWorkflow | null = null;
  let wfEv = '';
  if (learn) { wf = 'learning'; wfEv = learn; }
  else if (assist) { wf = 'assisted'; wfEv = assist; }
  else if (strong) { wf = 'full_auto'; wfEv = strong; }
  else if (weak && act) { wf = 'full_auto'; wfEv = act; }
  if (wf) {
    vector.ai_workflow = wf;
    hits.push({ field: 'ai_workflow', value: wf, evidence: wfEv });
  }

  // capabilities（no_persistence 与 data_persistence 互斥，优先取否定）
  const caps: Capability[] = [];
  const noP = firstHit(raw, NO_PERSIST_KW);
  if (noP) { caps.push('no_persistence'); hits.push({ field: 'required_capabilities', value: 'no_persistence', evidence: noP }); }
  for (const [cap, kws] of CAPS) {
    const k = firstHit(raw, kws);
    if (k) { caps.push(cap); hits.push({ field: 'required_capabilities', value: cap, evidence: k }); }
  }
  if (!noP) {
    const p = firstHit(raw, PERSIST_KW);
    if (p) { caps.push('data_persistence'); hits.push({ field: 'required_capabilities', value: 'data_persistence', evidence: p }); }
  }
  vector.required_capabilities = caps;

  // goal_type / team_size
  for (const [val, kws] of GOAL) {
    const k = firstHit(raw, kws);
    if (k) { vector.goal_type = val as any; hits.push({ field: 'goal_type', value: val, evidence: k }); break; }
  }
  for (const [val, kws] of TEAM) {
    const k = firstHit(raw, kws);
    if (k) { vector.team_size = val as any; hits.push({ field: 'team_size', value: val, evidence: k }); break; }
  }

  // 数值字段（v2.0.0 起）：数字 + 单位的明确形态直接读；约数词取保守下界并进 assumed。
  // 换算全部写死在代码里（周 = 1、月 = 4.345、年 = 52），与 intake/validate.ts 同一套口径。
  const users = parseExpectedUsers(raw);
  if (users.hit) {
    vector.expected_users = users.hit.value;
    hits.push({ field: 'expected_users', value: String(users.hit.value), evidence: users.hit.evidence });
  } else if (users.fuzzy) {
    vector.expected_users = (FUZZY_USERS.find(([re]) => re.test(raw))?.[1]) ?? null;
    if (vector.expected_users !== null) {
      assumed.push(`expected_users：${users.fuzzy}（约数按保守下界计）`);
    }
  }

  const tl = parseTimelineWeeks(raw);
  if (tl) {
    vector.timeline_weeks = tl.value;
    hits.push({ field: 'timeline_weeks', value: String(tl.value), evidence: tl.evidence });
  }

  const bg = parseBudget(raw);
  if (bg) {
    vector.budget_cny_month = bg.value;
    hits.push({ field: 'budget_cny_month', value: String(bg.value), evidence: bg.evidence });
  }

  // 这一层仍不碰的字段：没有。delivery / ai_workflow 缺失时会在下面补默认值并进 assumed。
  const unknown = ['timeline_weeks', 'budget_cny_month', 'expected_users']
    .filter((f) => {
      if (f === 'timeline_weeks') return vector.timeline_weeks === null || vector.timeline_weeks === undefined;
      if (f === 'budget_cny_month') return vector.budget_cny_month === null || vector.budget_cny_month === undefined;
      return vector.expected_users === null || vector.expected_users === undefined;
    })
    .concat(vector.delivery ? [] : ['delivery'])
    .concat(vector.ai_workflow ? [] : ['ai_workflow']);

  return { vector, hits, unknown, assumed };
}
