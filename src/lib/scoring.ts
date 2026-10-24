/**
 * 打分引擎（F4）
 * ------------------------------------------------------------------
 * 这是 v0.3 缺失的"算分桥梁"：把 ConstraintVector 和 ComboTemplates
 * 连起来。全部是纯函数，不调 LLM，保证同一输入必然同一输出。
 *
 * 设计取舍（对应 PRD v0.4 §6.6）：
 * **不对散装组件打分，只对组合模板打分。**
 * 理由：组合难度 ≠ 组件难度平均。Vite（中）+ FastAPI（中）拼起来对新手
 * 是"难"——难的不是任一组件，是跨域、双部署、联调。所以分数必须
 * 挂在组合上，而不是由组件分数聚合出来。
 */

import {
  coverageStatus,
  computeConfidence,
  questionsFor,
  normalizeVector,
  confidenceWarning,
  type CoverageStatus,
  type Confidence,
} from './confidence.ts';

export type GoalType = 'portfolio' | 'product' | 'internal_tool';

/**
 * 【v0.4.3】required_capabilities 的规范取值。
 *
 * 变更点（D1 真实数据暴露的三个表达缺口，见 D1 第二阶段报告）：
 *  1. 原 `file` 一值同时表示「用户上传文件」和「服务端要存文件」两件事，语义歧义。
 *     现拆为 `file_upload` / `file_storage`。
 *  2. 新增 `data_persistence`（数据持久化）。它不是一个"用户会主动说"的能力——
 *     用户说"记一下花销""收藏起来"，不会说"我要数据库"。所以由 confidence.ts 的
 *     normalizeVector() 从原始输入里推断补上，用于阻止零数据库方案在
 *     required_capabilities=[] 时通吃。
 *     【v1.5.0 语义降级】推断出来的 data_persistence 只作为**建议项**参与 fit，
 *     不再触发任何 hard_exclude。原因见 combos.json 的 capability_note：
 *     一票否决会让用户看不到「纯静态 + 本地存」这个选项，而真人访谈反馈
 *     MVP 阶段 LocalStorage 往往就够。现在 C11/C12 被 -1 而不是被排除。
 *
 * 兼容：`file` 作为**遗留别名**继续可用。test() 里 contains/not_contains 会把
 * 'file' 同时匹配 file_upload 与 file_storage，所以 combos.json 里 3 处旧规则
 * 和 tests/cases.json 里的旧标注都不用改写。
 */
export const CAPABILITY_VALUES = [
  'auth', 'payment', 'ai', 'realtime',
  'file_upload', 'file_storage',
  'data_persistence',
  /**
   * 【v0.4.3 补登记】C08 的 fit 规则从 v1.0 起就写着 `contains multi_platform`，
   * 但这个值从未出现在枚举里 → test() 永远匹配不到 → 那条 +1 规则**从未生效**。
   * 属于静默失效（不报错、不警告），由 check-consistency 第 8.1 条抓出来。
   * 这里按规则原意补登记（一套代码多端），不改任何现有分数：
   * 目前没有任何用例或标注写这个值。
   */
  'multi_platform',
  /**
   * 【v1.6.0 新增 · 反向能力】"不要服务端持久化"。
   *
   * 为什么需要它：`data_persistence` 只能表达"要存"，表达不了"明确不要存"。
   * 用户说「收藏只存浏览器里」「存在本地就行，别搞数据库」时，
   * 旧 schema 只有两条路：填 data_persistence（语义正好相反）或者留空（丢掉了信息）。
   * 两者都会让 C11/C12 失去它们最该赢的那类需求。
   *
   * 这是一个**约束**而不是需求，放在 required_capabilities 里语义上略别扭，
   * 但换来的是一处修改就够：不用为它新开一个字段、不用改 computeConfidence 的
   * 9 字段口径、不用改所有组合的 fit_rules。
   *
   * 三条使用规则（由 check-consistency + test-intake 守住）：
   *   1. 与 `data_persistence` **互斥**，同时出现视为模型自相矛盾，两个都丢。
   *   2. 一旦存在，normalizeVector 不再从原文推断 data_persistence
   *      （否则会一边说"不要"一边被补成"要"）。
   *   3. 只给零数据库方案（C11/C12）加分，**不给带 DB 的方案减分**。
   *      理由：一个用户表述只能被计算一次。C11/C12 各 +1 已经让相对次序正确，
   *      再给 C01/C02 减 1 就等于同一条需求算了两遍，会把 C01 压得过分。
   */
  'no_persistence',
  /** @deprecated 遗留别名，等价于 file_upload + file_storage */
  'file',
] as const;

export type Capability = (typeof CAPABILITY_VALUES)[number];

/**
 * 交付形态。
 * 【v0.4.3】补 cli / selfhost——D1 里 H09（命令行 + MCP 脚本）和 H10（自部署到 NAS）
 * 两条真实需求在旧枚举里无法表达，只能记成 null 或勉强记成 web。
 * 覆盖判定见 confidence.ts 的 COVERED_DELIVERIES / UNCOVERED_DELIVERIES。
 */
export type DeliveryForm =
  | 'web'
  | 'miniprogram'
  | 'desktop'
  | 'api'
  | 'agent'
  | 'cli'
  | 'selfhost';

/**
 * 技能画像，0–1 的熟练度。
 * 【v0.4.3】补 go / rust / java：D1 的 10 条真实帖里有 4 条的作者主要用这三种语言，
 * 旧 schema 只能记 null。
 *
 * ⚠️ 已知缺口：strongestLang() 仍只看 js / python，所以 Go/Rust/Java 作者不会
 * 触发"技能栈违背率"。这是**故意留的**——扩指标口径会改变历史基线，
 * 需和 D1 的命中率一起在 v0.4.3 统一重算，不能顺手改。
 */
export interface SkillProfile {
  js?: number;
  python?: number;
  sql?: number;
  ops?: number;
  go?: number;
  rust?: number;
  java?: number;
}

export interface ConstraintVector {
  delivery?: DeliveryForm | null;
  team_size?: '1' | '2-3' | '5+' | null;
  skills?: SkillProfile | null;
  timeline_weeks?: number | null;
  budget_cny_month?: number | null;
  expected_users?: number | null;
  required_capabilities?: Capability[] | null;
  compliance?: string[] | null;
  goal_type?: GoalType | null;
}

export interface ScoreDims {
  learning: number;
  ecosystem: number;
  ops: number;
  cost: number;
  fit: number;
  portability: number;
}

export interface ComboCondition {
  field?: string;
  op?: 'eq' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'not_contains' | 'in';
  value?: any;
  /** 复合条件：全部命中才算命中 */
  all?: ComboCondition[];
}

export interface Combo {
  id: string;
  name: string;
  one_liner: string;
  /**
   * 架构形态（v0.4.3 起 5 种）。
   *   A 全栈框架自建 / B 前后端分离 / C BaaS 托管 / D 小程序多端 / E 纯静态零后端
   * 【v0.4.3】新增 E：C12 是"没有后端"这一形态，塞进 A（全栈）语义上是错的——
   * 而产品定位已经明确为"定架构形态"，形态分类必须能表达"零后端"。
   */
  paradigm: 'A' | 'B' | 'C' | 'D' | 'E';
  /** 用户实际要写后端代码的语言，仅用于计算"技能栈违背率"，不参与打分 */
  lang: 'ts' | 'py' | 'js';
  components: Record<string, string>;
  base_scores: ScoreDims;
  fit_rules?: Array<{ when: ComboCondition; delta: number }>;
  hard_exclude_when: Array<ComboCondition & { reason: string }>;
  beginner_pitfalls?: string[];
  when_to_leave?: string;
  evidence?: { official_docs: string[]; pitfall_articles: string[] };
}

/**
 * 权重表：**只含 5 个加权维度，不含 fit**，且每列和为 1。
 *
 * 【v0.4.2 修正】
 * (a) 旧版把 fit 也放进权重表（10%/20%/20%），但 scoreCombo 把它从分母剔除
 *     改用乘数——那个权重值是死代码，且与 §6.6.3 公式直接矛盾。
 *     现用类型 WeightDims = Omit<ScoreDims,'fit'> 强制，写错编译不过。
 * (b) 删掉 fit 后其余 5 项没重新归一化，列和只有 0.9 / 0.8 / 0.8。
 *     公式里虽会除 Σw 所以数值不变，但表格看起来"少了 10%"。
 *     现按原比例重新归一化到 1.00（比例几乎不变，分数差异 < 0.01）。
 */
export type WeightDims = Omit<ScoreDims, 'fit'>;

export const WEIGHTS: Record<GoalType, WeightDims> = {
  internal_tool: { learning: 0.39, ecosystem: 0.17, ops: 0.28, cost: 0.11, portability: 0.05 },
  product: { learning: 0.19, ecosystem: 0.25, ops: 0.19, cost: 0.25, portability: 0.12 },
  portfolio: { learning: 0.25, ecosystem: 0.31, ops: 0.13, cost: 0.13, portability: 0.18 },
};

function readField(v: ConstraintVector, path: string): any {
  if (path.startsWith('skills.')) {
    const k = path.slice('skills.'.length) as keyof NonNullable<ConstraintVector['skills']>;
    return v.skills ? v.skills[k] : undefined;
  }
  return (v as any)[path];
}

/**
 * 【v0.4.3】能力别名展开。
 *
 * `file` 是旧 schema 的单一取值，同时表示「用户要上传文件」和「服务端要存文件」。
 * 拆成 file_upload / file_storage 后，旧数据（combos.json 3 处、cases.json 多条）
 * 仍写着 `file`。为了不重写这些规则，contains / not_contains 在**比较时**把两侧
 * 都展开到"具体能力"这一层：
 *
 *   查询 file              → {file_upload, file_storage}
 *   数据 ['file']          → {file_upload, file_storage}
 *   数据 ['file_upload']   → {file_upload}
 *
 * 于是：
 *   · contains file        对 ['file_upload'] 仍为真（偏严，见下方兼容说明）
 *   · not_contains file    只有在两者都没有时才为真（C11 保持原语义）
 *
 * ⚠️ 兼容说明（对应汇报「剩下的坑」第 4 条）：C04 排除 `file` 的本意是
 * "边缘环境没有持久磁盘 → 不能 file_storage"。别名让它在 file_upload 时也排除，
 * 语义偏严。本轮按任务要求"不要大面积重写旧规则"，保持别名行为，
 * 精修留给 v0.4.3（把 C04 那条改成 file_storage）。
 */
const CAP_ALIAS: Record<string, readonly string[]> = {
  file: ['file_upload', 'file_storage'],
};

function capSet(values: string[]): Set<string> {
  const s = new Set<string>();
  for (const v of values) for (const e of CAP_ALIAS[v] ?? [v]) s.add(e);
  return s;
}

function querySet(q: string): Set<string> {
  return new Set(CAP_ALIAS[q] ?? [q]);
}

function test(cond: ComboCondition, v: ConstraintVector): boolean {
  if (cond.all && cond.all.length > 0) return cond.all.every((c) => test(c, v));
  const actual = readField(v, cond.field!);
  if (actual === undefined || actual === null) return false; // 缺失不算命中，避免误杀
  switch (cond.op) {
    case 'eq': return actual === cond.value;
    case 'lt': return typeof actual === 'number' && actual < cond.value;
    case 'lte': return typeof actual === 'number' && actual <= cond.value;
    case 'gt': return typeof actual === 'number' && actual > cond.value;
    case 'gte': return typeof actual === 'number' && actual >= cond.value;
    // contains / not_contains 走别名展开（见 CAP_ALIAS 注释），两侧都展开后再比
    case 'contains': {
      if (!Array.isArray(actual) || typeof cond.value !== 'string') return false;
      const a = capSet(actual);
      return [...querySet(cond.value)].some((x) => a.has(x));
    }
    /**
     * 【v0.4.3 新增算子】现有 schema 只有"包含"，表达不了"不含"。
     * C11 的加分规则是「required_capabilities 不含 file 且不含 auth → +1」，
     * 用 contains 写不出来，只能补这个算子。
     * 语义：字段必须存在且是数组，且不含 value；字段缺失时返回 false（与上面"缺失不算命中"一致）。
     */
    case 'not_contains': {
      if (!Array.isArray(actual) || typeof cond.value !== 'string') return false;
      const a = capSet(actual);
      return ![...querySet(cond.value)].some((x) => a.has(x));
    }
    case 'in': return Array.isArray(cond.value) && cond.value.includes(actual);
    default: return false;
  }
}

export interface FilterResult {
  combo: Combo;
  excluded: boolean;
  reasons: string[];
}

/** 第一段：硬约束过滤（一票否决） */
export function hardFilter(combos: Combo[], v: ConstraintVector): FilterResult[] {
  return combos.map((c) => {
    const hit = c.hard_exclude_when.filter((r) => test(r, v));
    return { combo: c, excluded: hit.length > 0, reasons: hit.map((h) => h.reason) };
  });
}

/**
 * fit 维度：**delta 累加 + clamp(1,5)**，与规则顺序无关。
 *
 * 【v1.1 修正】v1.0 用"最后命中覆盖（last-match-wins）"+"绝对值 score"，
 * 会导致先加分后被后续规则意外清零：
 *   规则1 auth → score 5；规则2 timeline<=2 → score 3
 *   用户"有登录 + 只有2周"时，5 分被 3 分覆盖，"有登录"这个强匹配白算了。
 * 而且数组顺序会改变结果，调试极其痛苦。
 *
 * 改为增量后：base + Σdelta，clamp 到 [1,5]。顺序无关，加分减分可叠加。
 */
export function resolveFit(c: Combo, v: ConstraintVector): { fit: number; matched: number; deltas: number[] } {
  const matched = (c.fit_rules ?? []).filter((r) => test(r.when, v));
  const deltas = matched.map((r) => r.delta);
  const raw = c.base_scores.fit + deltas.reduce((a, b) => a + b, 0);
  const fit = Math.min(5, Math.max(1, raw));
  return { fit, matched: matched.length, deltas };
}

export interface ScoredCombo {
  id: string;
  name: string;
  paradigm: string;
  lang: string;
  score: number;
  breakdown: ScoreDims;
  baseAvg: number;
  fitFactor: number;
  fitDeltas: number[];
  /**
   * 【v0.4.3】非空组件个数，仅用于同分时的排序（见 rank 的 tie-break）。
   * 不参与任何打分计算。
   */
  componentCount: number;
}

/**
 * 第二段：软约束加权
 *
 * 【v0.4 修正】fit 从"一个维度"改为"乘数"。
 *
 * 原因：冒烟测试发现，纯加权求和会让"各项都 4-5 分的通用方案"通吃——
 * 6 个差异很大的约束跑出来 4 个都推 C01，差异度仅 0.33。
 * 因为匹配度只占 10-20% 权重，压不住生态分。
 *
 * 修正后：total = 其余维度加权平均 × (0.55 + 0.45 × fit/5)
 * fit=5 → ×1.00，fit=1 → ×0.64。匹配度差的方案无法靠生态分翻盘。
 */
export function scoreCombo(c: Combo, v: ConstraintVector): ScoredCombo {
  const goal: GoalType = v.goal_type ?? 'internal_tool';
  const w = WEIGHTS[goal];
  const { fit, deltas } = resolveFit(c, v);

  let sum = 0;
  let wsum = 0;
  (Object.keys(w) as Array<keyof WeightDims>).forEach((k) => {
    sum += c.base_scores[k] * w[k];
    wsum += w[k];
  });
  const baseAvg = sum / wsum;
  const fitFactor = 0.55 + 0.45 * (fit / 5);
  const total = baseAvg * fitFactor;

  // 非空组件个数（db/ai 允许为 null，见 C11/C12）
  const componentCount = Object.values(c.components).filter((v) => v !== null && v !== undefined).length;

  return {
    id: c.id,
    name: c.name,
    paradigm: c.paradigm,
    lang: c.lang,
    score: Math.round(total * 100) / 100,
    breakdown: { ...c.base_scores, fit },
    baseAvg: Math.round(baseAvg * 100) / 100,
    fitFactor: Math.round(fitFactor * 100) / 100,
    fitDeltas: deltas,
    componentCount,
  };
}

/**
 * 用户最强的语言。仅当最强项 ≥ 0.5 时才算"有明确偏好"——
 * js 0.2 / python 0.3 这种属于都还不会，不该计入技能栈违背率。
 */
export function strongestLang(v: ConstraintVector): 'ts' | 'py' | null {
  const s = v.skills;
  if (!s) return null;
  const js = s.js ?? 0;
  const py = s.python ?? 0;
  const top = Math.max(js, py);
  if (top < 0.5) return null;
  return js >= py ? 'ts' : 'py';
}

export interface RankOptions {
  /** 原始需求文本。仅用于 delivery 缺失时的关键词兜底，不参与打分 */
  raw_input?: string;
}

/**
 * 正常产出方案。
 * 【v0.4.3】新增 coverage_status / confidence 两个字段。
 * 两者必须同时存在，不能合并——一个管"超出范围"，一个管"信息不足"。
 */
export interface RankResult {
  ok: true;
  coverage_status: CoverageStatus;
  /** 仅 partial 时出现 */
  coverage_warning?: string;
  confidence: Confidence;
  /** 仅 medium 时出现 */
  confidence_warning?: string;
  /**
   * 【v0.4.3】从 raw_input 里推断出来、并被补进 required_capabilities 的能力。
   * 目前只可能是 data_persistence。必须透出来，否则"为什么 C11 被扣分了"
   * 在结果里看不到证据，用户会以为引擎在乱扣分。
   * 【v1.5.0】推断结果只影响 fit（C01/C02 +1，C11/C12 扣分），不再硬排除任何组合。
   */
  inferred_capabilities: Capability[];
  /** 推断依据（原文片段），无推断时为 undefined */
  inference_evidence?: string;
  top1: ScoredCombo;
  top2: ScoredCombo;
  /** Top1 与 Top2 是否被迫换了范式（用于监控多样性是否靠强制生效） */
  diversityEnforced: boolean;
  /** 通过了硬过滤、但没进 Top2 的方案，按分数降序。用于"不选清单"里展示"差一点入选" */
  runnerUps: ScoredCombo[];
  filteredOut: Array<{ id: string; reasons: string[] }>;
  candidateCount: number;
  /** Top1 的 lang 与用户最强语言是否不一致（技能栈违背率指标） */
  skillMismatch: boolean;
}

/**
 * 不出方案，改为追问 / 告知未覆盖。
 *
 * 三种 reason 对应三种完全不同的失败：
 *   uncovered              —— 库不够（该扩模板库）
 *   low_confidence         —— 输入不够（该追问用户）
 *   insufficient_candidates —— 约束互相打架，过滤后剩不下 2 套（该放宽或提示冲突）
 */
export interface RankBlocked {
  ok: false;
  reason: 'uncovered' | 'low_confidence' | 'insufficient_candidates';
  coverage_status: CoverageStatus;
  confidence: Confidence;
  suggestion: string;
  collect_entry: boolean;
  /** 可以直接抛给用户的问题 */
  questions: string[];
  suggested_fields: string[];
}

export type RankOutcome = RankResult | RankBlocked;

/**
 * 排序 + 强制范式多样性。
 * Top1 与 Top2 必须在不同范式，否则新手会拿到两个"看起来不一样其实一样"的方案。
 *
 * 【v0.4.3 行为变更】返回类型从 `RankResult | null` 改为 `RankOutcome` 三态联合。
 * 原来的 `null`（候选不足）变成 `{ ok: false, reason: 'insufficient_candidates' }`，
 * 因为 null 无法携带"为什么没出方案"的信息，而 v0.4.3 要求区分三种失败。
 * 调用方必须改用 `if (!r.ok)` 判断，不能再写 `if (!r)`。
 */
export function rank(combos: Combo[], v: ConstraintVector, opts: RankOptions = {}): RankOutcome {
  /**
   * 【v0.4.3】入口处先规范化：把原文里"要存东西"的隐性需求补成 data_persistence。
   * 规范化只发生在本地副本上，**不回写调用方的对象**——标注数据要能原样回看。
   * 必须在硬过滤之前做：C11 的硬排除读的就是这个字段。
   */
  const norm = normalizeVector(v, opts.raw_input);
  const nv = norm.vector;

  const cov = coverageStatus(nv, opts.raw_input);
  const conf = computeConfidence(nv);

  // 先判"库不够"，再判"输入不够"。
  // 顺序有讲究：如果场景压根超出范围，追问再准也没用，不该浪费用户时间。
  if (cov.status === 'uncovered') {
    return {
      ok: false,
      reason: 'uncovered',
      coverage_status: 'uncovered',
      confidence: conf.confidence,
      suggestion: '当前模板库未覆盖你的场景',
      collect_entry: true,
      questions: [],
      suggested_fields: [],
    };
  }

  if (conf.confidence === 'low') {
    return {
      ok: false,
      reason: 'low_confidence',
      coverage_status: cov.status,
      confidence: 'low',
      suggestion: '信息不足以给出可靠方案，先补几个关键信息',
      collect_entry: true,
      questions: questionsFor(conf.suggested_fields),
      suggested_fields: conf.suggested_fields,
    };
  }

  const filtered = hardFilter(combos, nv);
  const passed = filtered.filter((f) => !f.excluded).map((f) => f.combo);
  if (passed.length < 2) {
    return {
      ok: false,
      reason: 'insufficient_candidates',
      coverage_status: cov.status,
      confidence: conf.confidence,
      suggestion: '硬过滤后候选不足 2 套，需放宽约束',
      collect_entry: true,
      questions: [],
      suggested_fields: [],
    };
  }

  /**
   * 【v0.4.3】排序：先比分数，同分比组件数（少的优先）。
   *
   * 为什么需要 tie-break：C12（纯静态）与 C11（Next.js + Edge Functions）的
   * base_scores 按设计就是同一套（两者都是"最省心"的那一档），fit 又都会 clamp 到 5，
   * 于是 total 完全相同。没有 tie-break 时，胜负由 combos.json 里的数组顺序决定——
   * 这是不可解释的隐性规则，调试时只会看到"两个方案一样分，一个莫名其妙赢了"。
   *
   * 显式规则：**同分取组件更少的**。它同时是产品原则——少一层就少一个坑，
   * 新手不该为了不需要的层付学习成本。C12 有 2 个非空组件，C11 有 4 个，
   * 所以在"真的不需要后端"的需求上 C12 胜出；一旦需求要 AI/登录，C12 会被硬排除，
   * C11 照旧胜出。
   */
  const scored = passed
    .map((c) => scoreCombo(c, nv))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.componentCount - b.componentCount));
  const top1 = scored[0];
  let top2 = scored.find((s) => s.paradigm !== top1.paradigm);
  let diversityEnforced = false;
  if (!top2) {
    top2 = scored[1];
    diversityEnforced = true; // 找不到不同范式的，只能同范式，需告警
  }

  const chosen = new Set([top1.id, top2.id]);
  const runnerUps = scored.filter((s) => !chosen.has(s.id));

  const sl = strongestLang(nv);
  // JS 与 TS 属同一家族，不构成技能栈违背（C07 的 lang 是 js，用户会 JS 就算匹配）
  const normalize = (l: string) => (l === 'js' ? 'ts' : l);
  const skillMismatch = sl !== null && normalize(sl) !== normalize(top1.lang);

  return {
    ok: true,
    coverage_status: cov.status,
    ...(cov.status === 'partial'
      ? { coverage_warning: `方案可给出，但${cov.evidence}，这部分需要你自行解决` }
      : {}),
    confidence: conf.confidence,
    ...(conf.confidence === 'medium' ? { confidence_warning: confidenceWarning(conf) } : {}),
    inferred_capabilities: norm.inferred_capabilities,
    ...(norm.evidence ? { inference_evidence: norm.evidence } : {}),
    top1,
    top2,
    diversityEnforced,
    runnerUps,
    filteredOut: filtered.filter((f) => f.excluded).map((f) => ({ id: f.combo.id, reasons: f.reasons })),
    candidateCount: passed.length,
    skillMismatch,
  };
}

/**
 * 不选清单的展示上限（v0.4.2，v0.4.4 调整）。
 *
 * 为什么要有上限：runnerUps 可能有 4–6 条，全塞进不选清单会让页面长到没人看。
 * 但**数据层不截断**——`rank()` 仍返回完整数组，指标统计要用全量；
 * 只在展示层截断，避免"为了 UI 好看把数据也砍了"。
 *
 * 【v0.4.4：runnerUps 2 → 3】第二轮访谈里两个看过 H06 的受访者都说
 * "MVP 阶段纯静态 + LocalStorage 就够"，于是把 data_persistence 从硬排除降级为扣分，
 * 目的就是让 C12 出现在用户眼前。结果 C12 以 3.70 排在第 3 名，**被这个上限截掉了**——
 * 引擎算出来了、用户看不到，等于没降级。total 同步 5 → 6。
 */
export const NOT_CHOSEN_LIMITS = { runnerUps: 3, filteredOut: 3, total: 6 } as const;

export interface NotChosenItem {
  tier: '差一点入选' | '被硬过滤';
  id: string;
  score: number | null;
  reason: string;
}

/** 展示层用的不选清单：2 条差一点 + 3 条被过滤，总计 ≤5 */
export function notChosenForUI(r: RankResult): NotChosenItem[] {
  const near: NotChosenItem[] = r.runnerUps.slice(0, NOT_CHOSEN_LIMITS.runnerUps).map((s) => ({
    tier: '差一点入选' as const,
    id: s.id,
    score: s.score,
    reason: `分数 ${s.score.toFixed(2)}，低于 Top2，但通过了全部硬过滤`,
  }));
  const filtered: NotChosenItem[] = r.filteredOut.slice(0, NOT_CHOSEN_LIMITS.filteredOut).map((f) => ({
    tier: '被硬过滤' as const,
    id: f.id,
    score: null,
    reason: f.reasons.join('；'),
  }));
  return [...near, ...filtered].slice(0, NOT_CHOSEN_LIMITS.total);
}

/**
 * 组合指纹：差异度指标的机械计算依据。
 * 格式固定为 前端|后端|数据库|AI|部署，缺失层填 NONE。
 */
export function comboSignature(c: Combo): string {
  const order = ['fe', 'be', 'db', 'ai', 'deploy'];
  return order.map((k) => c.components[k] ?? 'NONE').join('|');
}

/**
 * 差异度 = 1 - 出现次数最多的指纹占比。
 * 与 PRD §10.2 定义一致，避免 v0.3 里"8/20 = 70%"的数学矛盾。
 */
export function diversity(signatures: string[]): number {
  if (signatures.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const s of signatures) counts.set(s, (counts.get(s) ?? 0) + 1);
  const max = Math.max(...counts.values());
  return Math.round((1 - max / signatures.length) * 100) / 100;
}
