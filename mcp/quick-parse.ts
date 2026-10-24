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

  /**
   * 这一层**不做**的字段：timeline / budget / expected_users。
   * 它们都要从数字里读，而中文数字（"十来个""几百人"）歧义太大，
   * 猜错会直接影响成本维度。留给模型或追问。
   */
  const unknown = ['timeline_weeks', 'budget_cny_month', 'expected_users']
    .concat(vector.delivery ? [] : ['delivery'])
    .concat(vector.ai_workflow ? [] : ['ai_workflow']);

  return { vector, hits, unknown, assumed };
}
