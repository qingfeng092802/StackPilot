/**
 * F1 解析层的**事实闸**：模型抽出来的每一个字段，都必须能指回原文里的一句话。
 *
 * 这一层和解释层的校验思路相反：
 *   解释层是"你说的话必须有出处"（坑来自 allowed_pitfalls）；
 *   解析层是"你填的值必须有出处"（字段来自 raw_input 的某个片段）。
 *
 * 三道检查，任何一道不过就把字段**丢掉**（而不是修正）：
 *   ① evidence 必须是原文的逐字连续片段
 *   ② 枚举值必须和 evidence 里的关键词对得上（说"网页"不能填 miniprogram）
 *   ③ 数值字段只接受 amount + unit，换算由这里做（可复算、可审计）
 *
 * 为什么是"丢掉"而不是"改成默认值"：默认值就是猜。
 * 丢掉之后字段变 null，进入 missing 列表，由 UI 去问用户——这才是正确的降级方向。
 */

import type { ConstraintVector } from '../scoring.ts';
import { isLocalOnlyEvidence, LOCAL_ONLY_KEYWORDS } from '../confidence.ts';
import {
  CAPABILITY_VALUES,
  COMPLIANCE_VALUES,
  DELIVERY_VALUES,
  AI_WORKFLOW_VALUES,
  GOAL_VALUES,
  TEAM_SIZE_VALUES,
} from './prompt.ts';

/** 去掉空白与常见标点，只留汉字、字母、数字，用于"逐字片段"比对 */
const STRIP = /[\s，。、；：""''「」『』（）()【】\[\]{}`*_>#!！？?~～·…—\-–]/g;
export const normEv = (s: unknown) => String(s ?? '').replace(STRIP, '');

export function isQuoted(evidence: unknown, raw: string): boolean {
  const e = normEv(evidence);
  if (e.length < 2) return false;
  return normEv(raw).includes(e);
}

// ────────────────────────────────────────────────────────────
// 关键词表：枚举值必须能从 evidence 里读出来
// ────────────────────────────────────────────────────────────

const DELIVERY_KW: Record<string, string[]> = {
  web: ['网页', '网站', 'web', 'Web', 'WEB', '浏览器', 'H5', 'h5', '网页版'],
  miniprogram: ['小程序', '微信', '公众号'],
  desktop: ['桌面', '客户端', 'exe', '安装包', 'Windows'],
  api: ['接口', 'API', 'api', '后端服务', '服务端'],
  agent: ['agent', 'Agent', '智能体', '机器人', 'bot'],
  cli: ['命令行', 'CLI', 'cli', '终端'],
  selfhost: ['自建', '自己部署', '部署到自己的', 'NAS', 'nas', '自己服务器', '私有化'],
};

const TEAM_KW: Record<string, string[]> = {
  '1': ['一个人', '只有我', '我自己', '就我', '单干', '独立做', '独自', '一个人做'],
  '2-3': ['两个人', '三个人', '两三个人', '2-3', '2~3', '三人', '俩人', '几个人', '小团队', '我们组'],
  '5+': ['五个人', '5 人', '5人', '十个人', '十几个人', '团队', '十几人', '多人协作', '一个团队'],
};

const GOAL_KW: Record<string, string[]> = {
  product: ['产品', '上线', '对外', '用户', '商业化', '收费', '卖', '发布'],
  internal_tool: ['内部', '自己用', '同事用', '团队用', '公司', '组里', '工作用'],
  portfolio: ['作品集', '简历', '面试', '练手', '学习', 'demo', 'Demo'],
};

const CAP_KW: Record<string, string[]> = {
  auth: ['登录', '账号', '注册', '微信登录', '身份'],
  payment: ['支付', '付款', '付费', '收费', '下单', '买'],
  ai: ['AI', 'ai', '智能', '大模型', '生成', '识别', 'GPT', 'LLM', '模型'],
  realtime: ['实时', '即时', '聊天', '推送', '同步'],
  file_upload: ['上传', '传文件', '传图', '传图片', '传照片'],
  file_storage: ['存文件', '文件存储', '保存文件', '存储文件'],
  data_persistence: ['存起来', '保存', '记录', '历史', '持久化', '存下来', '存在服务端'],
  multi_platform: ['多端', '多平台', '一套代码多端'],
  /**
   * 【v1.6.0】反向能力的关键词。
   * 故意只收"明确说了存哪儿/不要存"的表述，不收单独一个「存」字——
   * 那个字正是极性 bug 的源头。
   */
  no_persistence: [...LOCAL_ONLY_KEYWORDS],
};

const COMPLIANCE_KW: Record<string, string[]> = {
  personal_data: ['隐私', '个人信息', '手机号', '身份证', '实名', '敏感数据'],
  payment: ['支付合规', '支付牌照', '资金', '结算'],
};

/**
 * 【v1.7.0】取代 SKILL_LANG_KW / LEVEL_KW / LEVEL_SCORE。
 *
 * 判定的是**分工**（谁写代码），不是**水平**（会不会写）。
 * 所以关键词全是"谁做什么"的表述，而不是"熟练/精通"这类程度词。
 * 特别注意：'不会写代码' 归到 full_auto —— 在新定位下它回答的正是"谁来写"这个问题，
 * 不再是"技能分多低"。（旧口径里它是 skills 全 0，会误伤纯静态需求。）
 */
const AI_WORKFLOW_KW: Record<string, string[]> = {
  full_auto: [
    '让 AI 帮我写', '让AI帮我写', 'AI 帮我写', 'AI帮我写', '让 AI 写', '让AI写',
    '全让 AI', '全让AI', 'AI 生成', 'AI生成', '全自动',
    '我不写代码', '我不会写代码', '不会写代码', '不写代码', '不想自己写',
    'Cursor', 'cursor', 'Copilot', 'copilot', 'vibe coding', 'vibecoding',
  ],
  assisted: [
    '我来改', '我会改', '自己改', '自己调', '我会看', '看得懂', '能看懂',
    'AI 写我改', 'AI写我改', '改一改', '会检查',
  ],
  learning: [
    '想学', '借这个学', '借这个项目学', '边做边学', '学习', '练手',
    '自己写为主', '主要自己写', '自己动手', '想练',
  ],
};

const NEGATION_RE = /不|没|无|免|别|勿/;
const NUMERAL_RE = /[0-9零〇一二两三四五六七八九十百千万亿半]/;

// ────────────────────────────────────────────────────────────
// 结果类型
// ────────────────────────────────────────────────────────────

export interface DroppedField {
  field: string;
  /** 模型原本填了什么（便于排查"它到底想编什么"） */
  model_value: string;
  reason: string;
}

export interface IntakeParse {
  vector: ConstraintVector;
  /** 被采纳字段的原文依据，用于 UI 展示"我从你的话里读到了什么" */
  evidence: Record<string, string>;
  /** 被丢掉的字段及原因。dropped 越多，说明模型越想猜 */
  dropped: DroppedField[];
}

const has = (text: string, kws: string[]) => kws.some((k) => text.includes(k));

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ────────────────────────────────────────────────────────────
// 主校验
// ────────────────────────────────────────────────────────────

export function parseIntake(raw: string, model: any): IntakeParse {
  const vector: ConstraintVector = {};
  const evidence: Record<string, string> = {};
  const dropped: DroppedField[] = [];
  const drop = (field: string, model_value: unknown, reason: string) =>
    dropped.push({ field, model_value: str(model_value), reason });

  const m = model && typeof model === 'object' ? model : {};

  /**
   * 模型用了约定之外字段名 → 记一条 dropped。
   *
   * 这条检查是为了让上面那个坑（capabilities vs required_capabilities）
   * **下次能自己暴露出来**，而不是静默变成"模型没填"。
   * 不认识的键不影响结果，但必须在 dropped / notes 里留痕。
   */
  const KNOWN_MODEL_KEYS = new Set([
    'delivery', 'team_size', 'goal_type', 'ai_workflow',
    'timeline', 'budget', 'expected_users',
    'capabilities', 'compliance',
  ]);
  for (const k of Object.keys(m)) {
    if (!KNOWN_MODEL_KEYS.has(k) && m[k] !== null && m[k] !== undefined) {
      drop(k, m[k], '不是约定的字段名（可能把向量字段名 required_capabilities / timeline_weeks 当成了模型字段名）');
    }
  }

  /** 枚举字段的通用处理：evidence 溯源 + 值域 + 关键词三连 */
  function enumField(
    field: 'delivery' | 'team_size' | 'goal_type' | 'ai_workflow',
    allowed: readonly string[],
    kw: Record<string, string[]>,
  ) {
    const box = m[field];
    if (!box || typeof box !== 'object') return;
    const value = String(box.value ?? '');
    if (!allowed.includes(value)) return drop(field, box, `取值 ${value || '(空)'} 不在允许的枚举里`);
    if (!isQuoted(box.evidence, raw)) return drop(field, box, 'evidence 不是原文的连续片段');
    const ev = String(box.evidence);
    if (!has(ev, kw[value] ?? [])) return drop(field, box, `evidence 里读不出「${value}」（说"网页"不能填 miniprogram）`);
    (vector as any)[field] = value;
    evidence[field] = ev;
  }

  enumField('delivery', DELIVERY_VALUES, DELIVERY_KW);
  enumField('team_size', TEAM_SIZE_VALUES, TEAM_KW);
  enumField('goal_type', GOAL_VALUES, GOAL_KW);
  // 【v1.7.0】取代原来的 skills 数组校验（语言 × 熟练度）。
  // 走的是同一个 enumField：evidence 必须逐字、值必须在枚举里、关键词必须对得上。
  enumField('ai_workflow', AI_WORKFLOW_VALUES, AI_WORKFLOW_KW);

  // ---- 多值字段（capabilities / compliance）----
  /**
   * 【踩过的坑】第一版这里只传了向量字段名，于是去读 `m.required_capabilities`——
   * 而 prompt 让模型输出的是 `capabilities`。名字对不上，读到的永远是 undefined，
   * 函数直接 return，**一个字都没校验就静默跳过**，看起来像"模型没填"。
   * 更阴的是它不报错：required_capabilities 只是进了 missing，
   * 于是追问里多出一个"需要哪些能力"，用户答完就好了——谁也不会发现解析器漏读。
   * 所以这里把「模型字段名」和「向量字段名」拆成两个参数，写死在调用处。
   */
  function multiField(
    modelKey: string,
    field: 'required_capabilities' | 'compliance',
    allowed: readonly string[],
    kw: Record<string, string[]>,
  ) {
    const box = m[modelKey];
    if (!box || typeof box !== 'object') return;
    if (!isQuoted(box.evidence, raw)) return drop(field, box, 'evidence 不是原文的连续片段');
    const ev = String(box.evidence);
    let rawValues = Array.isArray(box.values) ? box.values.map(String) : [];
    const hadValues = rawValues.length > 0;

    // ── 极性检查（v1.6.0）──────────────────────────────────
    // 为什么必须在关键词检查之前做：关键词表只能判断"提到了存"，
    // 判断不了"往哪存"。evidence「存到 localStorage 就行」同时含「存」和「localStorage」，
    // 会以 data_persistence 的身份顺利通过关键词检查——然后给 C11/C12 各扣 1 分，
    // 把用户最想要的那套方案压下去。
    const localOnly = isLocalOnlyEvidence(ev);

    if (rawValues.includes('data_persistence') && localOnly) {
      drop(`${field}.data_persistence`, box,
        'evidence 说的是"只存浏览器/本地"，把它读成 data_persistence 是极性反了。应该说 no_persistence');
      rawValues = rawValues.filter((v) => v !== 'data_persistence');
    }

    if (rawValues.includes('data_persistence') && rawValues.includes('no_persistence')) {
      // 一句话里同时说"要存"和"不要存"，无法判断用户到底要哪个 → 两个都丢，交给追问。
      // 保留任何一个都是替用户做决定，而这一轮的原则恰恰是不替用户做决定。
      drop(field, box, '同时给了 data_persistence 和 no_persistence，自相矛盾，两个都不采纳');
      rawValues = rawValues.filter((v) => v !== 'data_persistence' && v !== 'no_persistence');
    }

    // 空数组 = 用户明确说"不需要"。这是信息，不是缺失。
    // 但必须有否定词兜着，否则模型可以用任意一句话宣布"什么都不需要"。
    if (rawValues.length === 0) {
      // 原来是空的才算"用户说不需要"；被上面两道极性检查清空的，已经记过 drop 了，
      // 再走这条路等于把"模型读反了"伪装成"用户明确说不要"——两种完全不同的结论。
      if (hadValues) return;
      if (!NEGATION_RE.test(ev)) return drop(field, box, '空数组必须来自明确的否定表述（不/没/无需）');
      (vector as any)[field] = [];
      evidence[field] = ev;
      return;
    }

    const kept: string[] = [];
    for (const v of rawValues) {
      if (!allowed.includes(v)) { drop(`${field}.${v}`, box, `取值 ${v} 不在允许的枚举里`); continue; }
      if (!has(ev, kw[v] ?? [])) { drop(`${field}.${v}`, box, `evidence 里读不出「${v}」`); continue; }
      kept.push(v);
    }
    // 逐项都记过了就不再补一条整字段的——notes 里出现
    // 「required_capabilities.data_persistence、required_capabilities」两个名字，
    // 会让人以为是两个不同的字段出了问题。
    if (kept.length === 0) return;
    (vector as any)[field] = kept;
    evidence[field] = ev;
  }

  multiField('capabilities', 'required_capabilities', CAPABILITY_VALUES, CAP_KW);
  multiField('compliance', 'compliance', COMPLIANCE_VALUES, COMPLIANCE_KW);

  // ---- 数值字段 ----
  const users = m.expected_users;
  if (users && typeof users === 'object') {
    const amount = Number(users.amount);
    if (!isQuoted(users.evidence, raw)) drop('expected_users', users, 'evidence 不是原文的连续片段');
    else if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) drop('expected_users', users, `数量 ${amount} 不合理`);
    else if (!NUMERAL_RE.test(String(users.evidence))) drop('expected_users', users, 'evidence 里没有数字');
    else { vector.expected_users = Math.round(amount); evidence.expected_users = String(users.evidence); }
  }

  const tl = m.timeline;
  if (tl && typeof tl === 'object') {
    const amount = Number(tl.amount);
    const unit = String(tl.unit ?? '');
    if (!isQuoted(tl.evidence, raw)) drop('timeline_weeks', tl, 'evidence 不是原文的连续片段');
    else if (!['day', 'week', 'month'].includes(unit)) drop('timeline_weeks', tl, `单位 ${unit} 不合法`);
    else if (!Number.isFinite(amount) || amount <= 0) drop('timeline_weeks', tl, `数量 ${amount} 不合理`);
    else if (!NUMERAL_RE.test(String(tl.evidence))) drop('timeline_weeks', tl, 'evidence 里没有数字');
    else {
      // 换算放在代码里：模型只负责"两周"，不负责"2 周 = 2"
      const factor = unit === 'day' ? 1 / 7 : unit === 'week' ? 1 : 4.345;
      const weeks = Math.max(1, Math.round(amount * factor));
      vector.timeline_weeks = weeks;
      evidence.timeline_weeks = String(tl.evidence);
    }
  }

  const bg = m.budget;
  if (bg && typeof bg === 'object') {
    const amount = Number(bg.amount);
    const unit = String(bg.unit ?? '');
    if (!isQuoted(bg.evidence, raw)) drop('budget_cny_month', bg, 'evidence 不是原文的连续片段');
    else if (!['month', 'year'].includes(unit)) drop('budget_cny_month', bg, `单位 ${unit} 不合法`);
    else if (!Number.isFinite(amount) || amount < 0) drop('budget_cny_month', bg, `金额 ${amount} 不合理`);
    else if (!NUMERAL_RE.test(String(bg.evidence))) drop('budget_cny_month', bg, 'evidence 里没有数字');
    else {
      vector.budget_cny_month = unit === 'month' ? Math.round(amount) : Math.round(amount / 12);
      evidence.budget_cny_month = String(bg.evidence);
    }
  }

  return { vector, evidence, dropped };
}
