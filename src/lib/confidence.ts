/**
 * 覆盖范围判定 + 信息充分度 + 能力推断（v0.4.3）
 * ------------------------------------------------------------------
 * 两种失败模式必须分开，不能合并成一个"可靠度"：
 *
 *   1. coverage_status —— **超出范围**。用户要的东西闭集里压根没有
 *      （桌面端 / CLI / 插件）。这时不该给方案，该说"我没这个能力"。
 *   2. confidence      —— **信息不足**。用户要的东西闭集里有，
 *      但需求描述里缺关键字段，给出来的方案是猜的。
 *
 * 为什么不能合并：一个是"库不够"，一个是"输入不够"。
 * 合并后无法定位该修模板库还是该改追问逻辑。
 *
 * 依赖方向：本文件只依赖 scoring.ts 的**类型**，不被 scoring.ts 内部逻辑调用
 * （由 rank() 在入口处调用），避免循环依赖。
 *
 * 【v0.4.3 三处结构性修正】
 *   a) 废弃 `missing_ratio > 0.4` 阈值 —— 9 个字段下等于"缺 4 个才警告"，
 *      D1 里 6/9、7/9 的帖子全部够不着，8 条里 7 条以 high 强推。
 *      改为「核心语义组 / 补充组」两段判断，见 computeConfidence。
 *   b) 新增 inferCapabilities（对外名 normalizeVector）—— 把"用户没说但语义上需要
 *      持久化"的隐性需求显性化为 data_persistence。这是 D1 暴露的 **schema 缺陷**：
 *      required_capabilities 里没有"持久化"这个槽位，于是 [] 被当成"什么都不需要"，
 *      零数据库方案（C11）在真实需求上通吃。缺陷在表达力，不在打分算法。
 *      【v1.5.0】推断结果已降级为**建议项**：只参与 fit，不再硬排除 C11/C12。
 *      见 combos.json 的 capability_note（真人访谈认为 MVP 用 LocalStorage 就够）。
 *   c) delivery 枚举补 cli / selfhost。（v1.7.0：skills 与 go/rust/java 一并移除）
 */
import type { ConstraintVector, Capability } from './scoring.ts';

// ────────────────────────────────────────────────────────────
// 一、覆盖范围
// ────────────────────────────────────────────────────────────

export type CoverageStatus = 'covered' | 'partial' | 'uncovered';

/**
 * 闭集能表达的交付形态。
 * 【v0.4.3】新增 selfhost：自部署的仍是 Web 应用，11 套组合里的 DP-03/DP-04 都支持
 * 自己部署到服务器/NAS，所以它属于"能表达"，不是"超出范围"。
 * 与 scripts/d1-coverage.ts 里 Q1 的 COVERED 集合保持一致（那里早已把 selfhost 计为覆盖）。
 */
export const COVERED_DELIVERIES = ['web', 'miniprogram', 'selfhost'] as const;

/**
 * 闭集完全没有模板的交付形态。
 * 【v0.4.3】新增 cli：闭集 11 套全是 Web/小程序组合，没有一套是命令行工具。
 */
export const UNCOVERED_DELIVERIES = ['desktop', 'api', 'agent', 'cli'] as const;

/**
 * 闭集无法表达的能力。
 *
 * 【本轮为空数组，这是任务要求的】
 * 后果：`partial` 在数学上不可达——没有"不支持的能力"，就永远判不出部分覆盖。
 * 这是已知缺陷，不是遗漏。填进去第一个能力后 partial 会自动生效，
 * 不需要改这里的判断逻辑。详见 D1 报告的遗留问题章节。
 */
export const UNSUPPORTED_CAPABILITIES: string[] = [];

/**
 * delivery 为 null 时，从原始输入里找这些词。
 * 只放任务指定的 5 个，不自行扩展同义词——扩词表是产品决策，不是实现细节。
 */
export const UNCOVERED_KEYWORDS = ['桌面', '客户端', '插件', '命令行', 'CLI'] as const;

export interface CoverageResult {
  status: CoverageStatus;
  /** 命中的证据：是哪个 delivery 值或哪个关键词导致的判定 */
  evidence: string;
}

export function coverageStatus(v: ConstraintVector, rawInput?: string): CoverageResult {
  const d = v.delivery;

  if (d && (UNCOVERED_DELIVERIES as readonly string[]).includes(d)) {
    return { status: 'uncovered', evidence: `delivery=${d}` };
  }

  if (d && (COVERED_DELIVERIES as readonly string[]).includes(d)) {
    const caps = v.required_capabilities ?? [];
    const hit = caps.filter((c) => UNSUPPORTED_CAPABILITIES.includes(c));
    if (hit.length > 0) {
      return { status: 'partial', evidence: `闭集无法表达的能力：${hit.join(', ')}` };
    }
    return { status: 'covered', evidence: `delivery=${d}` };
  }

  // delivery 为 null：靠关键词兜底
  if (rawInput) {
    const upper = rawInput.toUpperCase();
    for (const kw of UNCOVERED_KEYWORDS) {
      const hit = kw === 'CLI' ? upper.includes('CLI') : rawInput.includes(kw);
      if (hit) return { status: 'uncovered', evidence: `raw_input 命中关键词「${kw}」` };
    }
  }

  // delivery 缺失且没有关键词证据 → 先按 covered 处理。
  // 此时 confidence 一定因 core_missing 判为 medium/low，不会出现"无警告出方案"，
  // 所以这个分支的返回值不会真的被用来当作"完全覆盖"。
  return { status: 'covered', evidence: 'delivery 缺失且无关键词证据，默认按 web 处理' };
}

// ────────────────────────────────────────────────────────────
// 二、信息充分度
// ────────────────────────────────────────────────────────────

export type Confidence = 'high' | 'medium' | 'low';

/** 参与充分度计算的 9 个字段 */
export const SCORED_FIELDS = [
  'delivery',
  'team_size',
  'ai_workflow',
  'timeline_weeks',
  'budget_cny_month',
  'expected_users',
  'required_capabilities',
  'compliance',
  'goal_type',
] as const;

export type ScoredField = (typeof SCORED_FIELDS)[number];

/**
 * 核心语义组：缺了它，选型就没有主心骨。
 *
 *   delivery              —— 决定整个组合池（web / 小程序 / 桌面）
 *   ai_workflow           —— 决定权重档（full_auto / assisted / learning），v1.7.0 取代 skills
 *   required_capabilities —— 决定要不要后端、要不要 AI、要不要持久化
 *
 * 【v1.7.0】`skills` 换成 `ai_workflow`，**仍然留在核心组**。
 * 理由没变：核心组缺一项就足以让选型没有主心骨，而"谁写代码"现在是决定权重的那一项。
 * HX1（3/9 字段）的 low 判定也因此继续成立。
 */
export const CORE_FIELDS: ScoredField[] = ['delivery', 'ai_workflow', 'required_capabilities'];

/** 补充组：缺了会让结果变糙，但不会让方向跑偏 */
export const SUPPLEMENTARY_FIELDS: ScoredField[] = SCORED_FIELDS.filter(
  (f) => !CORE_FIELDS.includes(f)
);

/**
 * 补充组「近乎全空」的阈值：6 个补充字段里缺 ≥5 个（只剩 ≤1 个有值）。
 *
 * 【与规格文字的第二处偏离，见汇报「剩下的坑」第 2 条】
 * 规格写的是"补充组全空 → low"。但 HX1 的 compliance 有值（personal_data），
 * 严格"全空"不成立，按字面实现 HX1 会从 low 变成 medium。
 * 这里取"近乎全空"，语义是"补充组只剩一条信息，等于没有"。
 */
const SUPP_NEARLY_EMPTY = 5;

/**
 * 补充组「缺得够多」的阈值：缺 ≥2 个就降级为 medium。
 *
 * 【与规格文字的第三处偏离，见汇报「剩下的坑」第 3 条】
 * 规格的 medium 条件带着"核心组缺 1 个"这个前提。但 H04 / H05 / H06 的核心组
 * （delivery + ai_workflow + required_capabilities）**全部完整**，缺的是 timeline /
 * expected_users / budget——按字面规则它们仍然是 high，验收目标无法达成。
 * 所以 medium 条件放宽为"核心组缺 1 个 **或** 补充组缺 ≥2 个"。
 */
const SUPP_ENOUGH_TO_WARN = 2;

/** 追问优先级：越靠前，对 Top1 的影响越大 */
const ASK_PRIORITY: ScoredField[] = [
  'ai_workflow',
  'goal_type',
  'team_size',
  'delivery',
  'required_capabilities',
  'timeline_weeks',
  'expected_users',
  'budget_cny_month',
  'compliance',
];

export const FIELD_QUESTIONS: Record<ScoredField, string> = {
  delivery: '你要交付成什么形态？（网页 / 微信小程序 / 桌面客户端 / 命令行工具 / 浏览器插件）',
  team_size: '这个项目几个人做？只有你一个，还是有小团队？',
  ai_workflow: '这个项目你打算怎么让 AI 参与？全自动生成，还是你也会改代码？',
  timeline_weeks: '希望多久能用上？',
  budget_cny_month: '每月能接受多少服务器/服务成本？0 也可以说。',
  expected_users: '预计多少人用？',
  required_capabilities: '需要登录、支付、文件上传、AI 这些能力里的哪些？',
  compliance: '涉及支付或个人隐私数据吗？',
  goal_type: '做这个是为了内部用、对外做产品，还是放作品集？',
};

export interface ConfidenceResult {
  confidence: Confidence;
  /**
   * 9 个字段的缺失占比。
   * 【v0.4.3】已**不再参与判定**，仅作为报表指标保留——
   * 保留它是为了让 D1 报告里的历史数字还能对齐，不是因为还有用。
   */
  missing_ratio: number;
  /** 核心组缺失的字段名（空数组 = 核心信息齐全） */
  core_missing: ScoredField[];
  /** 补充组缺失的字段名 */
  supplementary_missing: ScoredField[];
  suggested_fields: ScoredField[];
}

/** 空数组算"已填写"——用户明确说了"不需要额外能力"，不是没说 */
function isMissing(v: ConstraintVector, k: ScoredField): boolean {
  const val = (v as any)[k];
  return val === null || val === undefined;
}

/**
 * 判定表（v0.4.3 重构，替代 `missing_ratio > 0.4`）：
 *
 *   核心组缺 ≥1 且 补充组缺 ≥5   → low     （核心不明 + 补充几乎全空，拦下来追问）
 *   核心组缺 ≥1 或 补充组缺 ≥2   → medium  （要么核心缺，要么补充缺得多，带警告出方案）
 *   否则                         → high
 *
 * 与旧规则的对比（同一批数据）：
 *   旧：9 字段缺 4 个才 medium → D1 的 6/9、7/9 帖子 8 条里 7 条 high 强推
 *   新：核心缺 1 个就至少 medium；补充缺 2 个就警告 → 同一批帖子只有 1 条 high
 */
export function computeConfidence(v: ConstraintVector): ConfidenceResult {
  const missing = SCORED_FIELDS.filter((k) => isMissing(v, k));
  const core_missing = CORE_FIELDS.filter((k) => isMissing(v, k));
  const supplementary_missing = SUPPLEMENTARY_FIELDS.filter((k) => isMissing(v, k));
  const missing_ratio = Math.round((missing.length / SCORED_FIELDS.length) * 1000) / 1000;

  let confidence: Confidence;
  if (core_missing.length >= 1 && supplementary_missing.length >= SUPP_NEARLY_EMPTY) {
    confidence = 'low';
  } else if (core_missing.length >= 1 || supplementary_missing.length >= SUPP_ENOUGH_TO_WARN) {
    confidence = 'medium';
  } else {
    confidence = 'high';
  }

  const suggested_fields =
    confidence === 'high'
      ? []
      : ASK_PRIORITY.filter((k) => missing.includes(k)).slice(0, 3);

  return { confidence, missing_ratio, core_missing, supplementary_missing, suggested_fields };
}

/** 把建议补的字段翻译成可以直接问用户的话 */
export function questionsFor(fields: ScoredField[]): string[] {
  return fields.map((f) => FIELD_QUESTIONS[f]);
}

/**
 * medium 时的警告文案。
 *
 * 【v0.4.3】不再报"缺了 X% 的信息"——占比已经不再是判定依据，
 * 报一个和判定无关的百分比会让人以为 40% 是阈值。改为直接说缺什么。
 */
export function confidenceWarning(r: ConfidenceResult): string {
  const parts: string[] = [];
  if (r.core_missing.length > 0) parts.push(`关键信息缺 ${r.core_missing.join('、')}`);
  if (r.supplementary_missing.length > 0) {
    parts.push(`补充信息缺 ${r.supplementary_missing.length} 项（${r.supplementary_missing.join('、')}）`);
  }
  const head = parts.join('；');

  const allMissing = [...r.core_missing, ...r.supplementary_missing];
  if (r.suggested_fields.length === 0) return head;
  // 建议补的就是全部缺失项时，别把同一串字段名说两遍
  const same =
    r.suggested_fields.length === allMissing.length &&
    r.suggested_fields.every((f) => allMissing.includes(f));
  return same ? `${head}，补上就会更准` : `${head}；优先补 ${r.suggested_fields.join('、')}`;
}

// ────────────────────────────────────────────────────────────
// 三、能力推断（把隐性持久化需求显性化）
// ────────────────────────────────────────────────────────────

/**
 * 「需要把东西留在服务端」的动词/名词。
 *
 * 【v0.4.3 收窄，用户裁决】原表是 `存/记录/保存/收藏/历史`，删掉了「收藏」。
 * 原因：H01 的原文是「还能收藏喜欢的」，但作者实际用纯静态 Next.js 实现，
 * 收藏存在前端 localStorage——「收藏」这类轻量偏好在前端就能解决，
 * 不构成"需要服务端持久化"的证据。它把 H01 从 HIT 打成了 PARTIAL_HIT。
 *
 * H06 不受影响：它的原文是「收藏只存浏览器里」，仍被「存」捕获
 * （证据串「收藏只存」），所以 C11 照样被排除，Top1 仍是带 DB 的 C01。
 *
 * 现在的四个词都是"必然要落到存储介质上"的动作，不再包含可前端的偏好类行为。
 */
export const PERSISTENCE_KEYWORDS = ['存', '记录', '保存', '历史'] as const;

/**
 * 【v1.6.0】「只存在浏览器 / 本地」的标记。
 *
 * 为什么需要单独一张表：`PERSISTENCE_KEYWORDS` 只能判断"有没有提到存"，
 * 判断不了"往哪存"。于是「收藏只存浏览器里」被「存」捕获，
 * 推断成 `data_persistence`——语义正好相反。
 * 这是极性 bug 的词表部分。
 *
 * 用法有两处，方向不同：
 *   1. intake 校验层（`intake/validate.ts`）：evidence 命中这张表时，
 *      **拒绝** `data_persistence`（模型读反了），只接受 `no_persistence`。
 *   2. normalizeVector：**不用它做推断**。原因见下面 normalizeVector 的注释——
 *      拿它做推断会把 H06 的 Top1 从 C01 改成 C12，那是另一件事，要单独裁决。
 *
 * 只收"明确说了存哪儿"的表述。不收单独的「本地」——「本地生活服务」「本地化」
 * 都会误命中，而这类误命中的代价是凭空否定一个持久化需求。
 */
export const LOCAL_ONLY_KEYWORDS = [
  '只存浏览器', '存浏览器', '存在浏览器', '浏览器里存', '存到浏览器',
  '只存本地', '存在本地', '存本地', '只存前端', '存前端',
  'localStorage', 'LocalStorage', 'localstorage',
  '不需要存', '不用存', '不需要保存', '不用保存',
  '不存服务端', '不要服务端存储', '不用数据库', '不要数据库',
  '清缓存', '换个浏览器就没了',
] as const;

/** evidence 里是否明确说了"存在浏览器/本地" */
export function isLocalOnlyEvidence(text: string): boolean {
  const s = String(text ?? '');
  return LOCAL_ONLY_KEYWORDS.some((k) => s.includes(k));
}

/**
 * 否定标记。命中即认为这次提及是**否定**（"不需要存数据"）。
 *
 * 为什么宁可误判成否定：误判成否定只是不做推断（回到 v0.4.2 的行为），
 * 误判成肯定则会凭空塞一个 data_persistence，把 C11/C12 各扣 1 分 fit——
 * 而这两套存在的意义就是承接"真的不需要存东西"的需求（H01/CT01 这类）。
 * 两害相权，宁漏不滥。
 * （v1.5.0 之前这里写的是"把 C11 硬过滤掉"，语义降级后改为扣分，结论不变：
 *  误判的代价仍然是让零 DB 方案排到后面，所以仍然宁漏不滥。）
 *
 * 取关键词前 3 个字符作为窗口。不用"别"（"分别存"会被误判成否定）。
 */
const NEGATION_CHARS = ['不', '无', '没', '免', '勿'] as const;

export interface PersistenceMention {
  hit: boolean;
  evidence: string | null;
}

/** 原文里是否存在**未被否定**的持久化表述 */
export function findPersistenceMention(rawInput: string): PersistenceMention {
  for (const kw of PERSISTENCE_KEYWORDS) {
    let from = 0;
    for (;;) {
      const i = rawInput.indexOf(kw, from);
      if (i < 0) break;
      const window = rawInput.slice(Math.max(0, i - 3), i);
      const negated = NEGATION_CHARS.some((n) => window.includes(n));
      if (!negated) return { hit: true, evidence: `原文出现「${window}${kw}」` };
      from = i + kw.length;
    }
  }
  return { hit: false, evidence: null };
}

export interface NormalizeResult {
  /** 规范化后的副本。原对象**不被修改**——标注数据要保持原样，方便回看 */
  vector: ConstraintVector;
  inferred_capabilities: Capability[];
  evidence: string | null;
}

/**
 * 规范化约束向量：把隐性需求补进 required_capabilities。
 *
 * 只做一件事：推断 data_persistence。不重写 `file` 别名——
 * `file` → file_upload/file_storage 的展开放在 scoring.ts 的 test() 里做，
 * 因为那是"比较时"的语义，不该改动标注数据本身。
 *
 * 【为什么不处理 caps 为 null 的情况】
 * null 表示"标注时没抽出来"，不是"用户说不需要"。如果这时补一个
 * data_persistence，就把"没标注"伪装成了"已标注"，会把 confidence 抬高一级。
 * 所以只在 caps 是数组（含 []）时才补。
 */
export function normalizeVector(v: ConstraintVector, rawInput?: string): NormalizeResult {
  const caps = v.required_capabilities;
  const none: NormalizeResult = { vector: v, inferred_capabilities: [], evidence: null };

  if (!rawInput) return none;
  if (!Array.isArray(caps)) return none;
  if (caps.includes('data_persistence')) return none;
  /**
   * 【v1.6.0 极性保护】已经明确说"不要服务端持久化"时，绝不能再从原文推断"要"。
   *
   * 这是 no_persistence 上线后必须补的一条：intake 把「收藏只存浏览器里」
   * 读成 no_persistence 之后，如果这里还按「存」字去推断 data_persistence，
   * 就会得到 `['no_persistence', 'data_persistence']` 这种自相矛盾的向量——
   * C11/C12 既吃 +1 又吃 -1，等于两个方向同时生效，结论全看 clamp 顺序。
   *
   * 【为什么不在这一步加"从原文推断 no_persistence"】
   * 试过，会让 H06 的 Top1 从 C01 翻成 C12。而 H06 的 ground_truth 是
   * Node + SQLite（`has_db: true`），翻过去就等于在 D1 基线上主动制造一次 MISS。
   * 更麻烦的是 H06 的 bias_note 写着「『收藏只存浏览器』是原文写的」——
   * 即**用户说的和作者实际做的不一致**。这种矛盾该由产品裁决（听用户的，还是听实际的），
   * 不该由一行正则替它决定。所以本轮只在 LLM 读过原文的 intake 路径上修正极性，
   * 正则推断路径保持原样，差异记在 docs 的遗留问题里。
   */
  if (caps.includes('no_persistence')) return none;

  const m = findPersistenceMention(rawInput);
  if (!m.hit) return none;

  return {
    vector: { ...v, required_capabilities: [...caps, 'data_persistence'] },
    inferred_capabilities: ['data_persistence'],
    evidence: m.evidence,
  };
}
