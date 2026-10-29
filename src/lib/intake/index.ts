/**
 * F1 解析层入口：大白话 → ConstraintVector + 缺失字段 + 追问。
 *
 * 和解释层一样的三段式：调模型 → 解析 → 校验，但**兜底方向相反**。
 *   解释层校验不过 → 退回模板文案（内容还是完整的）；
 *   解析层校验不过 → 退回"什么都没解析出来"（宁可问用户，也不能带着猜的值往下走）。
 *
 * 因为解析层一旦带着猜的值往下走，错误会**贯穿整条链路**：
 * 猜了 ai_workflow=assisted → 引擎按"AI 写我改"的权重选型 → 解释层再把它说得头头是道。
 * 后面两道闸都拦不住，因为它们校验的是"有没有编事实"，不是"前提对不对"。
 */

import type { ConstraintVector } from '../scoring.ts';
import type { Confidence, CoverageStatus } from '../confidence.ts';
import { computeConfidence, coverageStatus } from '../confidence.ts';
import { extractJson } from '../explain/index.ts';
import type { LLMProvider } from '../explain/provider.ts';
import { buildIntakePrompt, INTAKE_SYSTEM_PROMPT } from './prompt.ts';
import { parseIntake } from './validate.ts';
import type { DroppedField } from './validate.ts';
import { stripInjections } from './injection.ts';
import type { InjectionFinding } from './injection.ts';

export * from './prompt.ts';
export { parseIntake, isQuoted, normEv } from './validate.ts';
export { stripInjections, detectInjection } from './injection.ts';
export type { DroppedField, IntakeParse } from './validate.ts';
export type { InjectionFinding } from './injection.ts';

export interface IntakeOption {
  value: string;
  label: string;
  /** 遗留字段：v1.7.0 起没有"程度→数值"的映射了，保留是为了不破坏前端旧代码 */
  score?: number;
}

export interface IntakeQuestion {
  field: string;
  question: string;
  type: 'select' | 'multi' | 'number';
  options?: IntakeOption[];
  hint?: string;
  unit?: string;
}

export interface IntakeResult {
  ok: boolean;
  parsed: ConstraintVector;
  /** 没解析出来的字段（按追问优先级排序） */
  missing: string[];
  questions: IntakeQuestion[];
  /** 每个被采纳字段的原文依据 */
  evidence: Record<string, string>;
  /** 被丢掉的字段——这是"模型想猜什么"的证据 */
  dropped: DroppedField[];
  confidence: Confidence;
  /**
   * 覆盖判定。`uncovered` 时前端应当**跳过追问**直接去拿"做不了"的说明。
   *
   * 为什么解析层要管这件事：用户说"帮我做个桌面软件"，如果还按流程问
   * "几个人做 / 多久上线 / 需要哪些能力"，问完才告诉他"桌面我做不了"，
   * 那三个问题就是纯浪费。先判覆盖，能少问三个问题。
   */
  coverage_status: CoverageStatus;
  /** 给人看的提示（例如"3 个字段找不到依据已丢弃"） */
  notes: string[];
  failure?: { stage: 'transport' | 'parse' | 'validate'; detail: string };
}

// ────────────────────────────────────────────────────────────
// 追问模板
// ────────────────────────────────────────────────────────────

/**
 * 追问优先级：越靠前对 Top1 影响越大。
 *
 * 【和 confidence.ts 的 ASK_PRIORITY 有一处刻意不同】
 * 那边是 ai_workflow → goal_type → team_size → delivery，
 * 这边把 delivery 提到了第二位。原因：那套顺序服务于"低置信度时提示补哪几项"，
 * 提示是给人看的清单；这里服务于"只能问 2–3 个问题"，
 * 而 delivery 缺失意味着**整个候选池未知**（网页 / 小程序 / 桌面是三套不同的组合），
 * 比 goal_type 更前置。且 delivery 在大白话里通常会被说出口（"做个网页"），
 * 所以它进 missing 时，往往是真的没说——那就必须问。
 */
const ASK_ORDER = [
  'ai_workflow',
  'delivery',
  'goal_type',
  'team_size',
  'required_capabilities',
  'timeline_weeks',
  'expected_users',
  'budget_cny_month',
  'compliance',
] as const;

/** 一次最多问几个。问太多会变成第二张表单，用户直接关页面 */
const MAX_QUESTIONS = 3;

const QUESTIONS: Record<string, IntakeQuestion> = {
  ai_workflow: {
    field: 'ai_workflow',
    question: '这个项目，你打算让 AI 写多少？',
    type: 'select',
    hint: '这决定了我们给你挑"AI 最容易一次写对"的方案，还是"最适合学"的方案',
    options: [
      { value: 'full_auto', label: '我基本不写代码，全让 AI 写' },
      { value: 'assisted', label: 'AI 写，我来改和调' },
      { value: 'learning', label: '我自己写为主，想借这个项目学' },
    ],
  },
  delivery: {
    field: 'delivery',
    question: '这东西最终以什么形式给用户用？',
    type: 'select',
    options: [
      { value: 'web', label: '网页（浏览器打开）' },
      { value: 'miniprogram', label: '微信小程序' },
      { value: 'selfhost', label: '自己部署到服务器 / NAS' },
      { value: 'desktop', label: '桌面客户端' },
      { value: 'api', label: '给别的程序调的 API' },
      { value: 'agent', label: 'AI Agent / 机器人' },
      { value: 'cli', label: '命令行工具' },
    ],
    // 保留 desktop / api / agent / cli 这四个选项不是摆设：
    // 它们全在 UNCOVERED_DELIVERIES 里，用户选了会被明确告知"做不了"。
    // 把它们藏起来只会让用户被迫选一个错的值，然后拿到一份基于错误前提的方案。
    hint: '桌面 / API / Agent / 命令行这几项我没有对应模板，会直接告诉你做不了',
  },
  goal_type: {
    field: 'goal_type',
    question: '做它是为了什么？',
    type: 'select',
    options: [
      { value: 'product', label: '对外做产品，会有真实用户' },
      { value: 'internal_tool', label: '内部 / 自己用，量很小' },
      { value: 'portfolio', label: '放作品集 / 练手' },
    ],
  },
  team_size: {
    field: 'team_size',
    question: '几个人做？',
    type: 'select',
    options: [
      { value: '1', label: '只有我一个' },
      { value: '2-3', label: '2–3 个人' },
      { value: '5+', label: '5 个人以上' },
    ],
  },
  required_capabilities: {
    field: 'required_capabilities',
    question: '需要下面哪些能力？（可以多选，都不需要就直接下一步）',
    type: 'multi',
    options: [
      { value: 'auth', label: '登录 / 账号' },
      { value: 'payment', label: '支付' },
      { value: 'ai', label: 'AI 生成 / 识别' },
      { value: 'realtime', label: '实时 / 聊天' },
      { value: 'file_upload', label: '文件上传' },
      { value: 'file_storage', label: '文件存储' },
      { value: 'data_persistence', label: '数据要存服务端' },
      // 反向选项。和「数据要存服务端」互斥——两条同时勾上等于没回答，
      // 校验层会把两个都丢掉，用户等于白答一次，所以界面上要做成互斥。
      { value: 'no_persistence', label: '不要服务端存储（只存浏览器）' },
    ],
    hint: '「存服务端」和「只存浏览器」只能选一个，选后者会让零数据库方案排到前面',
  },
  timeline_weeks: {
    field: 'timeline_weeks',
    question: '希望多久能用上？',
    type: 'number',
    unit: '周',
    hint: '填个大概就行，比如 4',
  },
  expected_users: {
    field: 'expected_users',
    question: '预计多少人用？',
    type: 'number',
    unit: '人',
    hint: '量级就行，比如 20',
  },
  budget_cny_month: {
    field: 'budget_cny_month',
    question: '每月能接受多少服务成本？',
    type: 'number',
    unit: '元/月',
    hint: '填 0 也完全可以，很多方案免费额度就够',
  },
  compliance: {
    field: 'compliance',
    question: '涉及这些合规要求吗？',
    type: 'multi',
    options: [
      { value: 'personal_data', label: '会存个人隐私数据（手机号 / 身份证等）' },
      { value: 'payment', label: '涉及资金结算' },
    ],
  },
};

// ────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────

export interface IntakeOptions {
  raw_input: string;
  provider: LLMProvider;
  maxAttempts?: number;
}

export async function intake({ raw_input, provider, maxAttempts = 2 }: IntakeOptions): Promise<IntakeResult> {
  const raw0 = String(raw_input ?? '').trim();
  const empty: IntakeResult = {
    ok: false,
    parsed: {},
    missing: [],
    questions: [],
    evidence: {},
    dropped: [],
    confidence: 'low',
    // 解析失败时这个值没有意义（前端只认 ok=false 去降级），给中性默认
    coverage_status: 'covered',
    notes: [],
  };

  // 注入剥离：clean 是后续解析与 evidence 校验的唯一文本基准。
  // 指向被剥片段的 evidence 会校验失败——预期行为，那段根本不是需求。
  const { clean, findings } = stripInjections(raw0);
  const raw = clean;
  const injectionNotes = findings.map(
    (f: InjectionFinding) => `检测到疑似注入指令（模式 ${f.pattern}）并已剥离：「${f.matched}」`
  );

  if (raw.length < 4) {
    // 剥完只剩注入的极端情况：不算解析失败，直接告诉调用方没有可用需求
    if (findings.length) {
      return { ...empty, notes: [...injectionNotes, '剥离注入片段后没有剩余可用需求'] };
    }
    return { ...empty, failure: { stage: 'validate', detail: '描述太短，没法解析（至少写一句话）' } };
  }

  if (!provider.available()) {
    return {
      ...empty,
      failure: { stage: 'transport', detail: `模型不可用：${provider.unavailableReason()}，请改用手动填表` },
    };
  }

  let lastErr = '';
  let modelJson: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const user =
      attempt === 1
        ? buildIntakePrompt(raw)
        : `${buildIntakePrompt(raw)}\n\n你上一次的输出有问题（${lastErr}）。请只输出一个合法的 JSON 对象，不要代码围栏、不要解释。`;

    let text: string;
    try {
      const res = await provider.complete({ system: INTAKE_SYSTEM_PROMPT, user });
      text = res.text;
      if (res.stopReason === 'max_tokens') {
        lastErr = '输出被 max_tokens 截断';
        continue;
      }
    } catch (e) {
      // 传输层错误不重试
      return { ...empty, failure: { stage: 'transport', detail: String((e as Error)?.message ?? e).slice(0, 300) } };
    }

    const json = extractJson(text);
    if (!json) { lastErr = '找不到 JSON 对象'; continue; }
    try {
      modelJson = JSON.parse(json);
      break;
    } catch (e) {
      lastErr = String((e as Error).message).slice(0, 120);
    }
  }

  if (!modelJson) {
    return { ...empty, failure: { stage: 'parse', detail: `模型输出无法解析：${lastErr}` } };
  }

  const { vector, evidence, dropped, warnings } = parseIntake(raw, modelJson);
  const conf = computeConfidence(vector);
  const cov = coverageStatus(vector, raw);
  const missing = ASK_ORDER.filter((f) => !(f in evidence));

  // 追问策略：
  //   超出能力范围 → 一个都不问（问了也用不上，直接去说"做不了"）
  //   置信度已经 high → 不问（再问就是打扰）
  //   否则按优先级最多问 3 个，且只问有模板的字段
  const questions =
    cov.status === 'uncovered' || conf.confidence === 'high'
      ? []
      : missing.filter((f) => QUESTIONS[f]).slice(0, MAX_QUESTIONS).map((f) => QUESTIONS[f]);

  const notes: string[] = [...injectionNotes, ...warnings];
  if (dropped.length) {
    notes.push(`有 ${dropped.length} 个字段模型填了但没被采纳，已丢弃：${[...new Set(dropped.map((d) => d.field))].join('、')}`);
  }
  if (cov.status === 'uncovered') {
    notes.push('你要的这种形态不在我的模板范围内，就不再追问了，直接说明为什么做不了');
  } else if (questions.length) {
    notes.push(`还有 ${missing.length} 项没说，先问 ${questions.length} 个最关键的`);
  }

  return {
    ok: true,
    parsed: vector,
    missing,
    questions,
    evidence,
    dropped,
    confidence: conf.confidence,
    coverage_status: cov.status,
    notes,
  };
}
