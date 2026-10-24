/**
 * LLM 解释层的类型定义。
 *
 * 【设计原则：LLM 只负责"怎么说"，不负责"选什么"】
 * 选型由 scoring.ts 的闭集打分决定，LLM 拿到的是一个已经定死的 combo_id，
 * 它没有任何权力换方案、加方案、或引入闭集之外的技术名。
 *
 * 所以这里的 schema 有一个共同特征：**每一个"事实"字段都带一个溯源指针**。
 *   - pitfalls[].source_index  → 必须指向 combo.beginner_pitfalls 的下标
 *   - not_chosen[].source_when_to_leave → 必须是该组合 when_to_leave 的原文片段
 * 校验层只做一件事：指针失效就 reject。指针有效，就不可能出现"编造的坑"。
 */

export type Confidence = 'high' | 'medium' | 'low';

/** 不选清单的一条。三段式：没选什么 → 为什么 → 何时回头看 */
export interface NotChosenItem {
  combo_id: string;
  /** 没选什么（人话，≤24 字） */
  what: string;
  /** 为什么没选（≤60 字，必须能追溯到 rejectReason 或分数差） */
  why: string;
  /**
   * 何时回头看（≤60 字）。
   *
   * 【语义：必须是 when_to_leave 的**逻辑翻转**，不是摘抄】
   * when_to_leave 说的是"什么条件下该离开这个落选方案"；
   * reconsider_when 说的是"什么条件下值得重新把它捡起来"——两者是互补条件。
   *
   * 例：C03 的 when_to_leave =「当团队只有你一个人、且不打算长期维护两套服务时，退回 C01」
   *     ✗ 照抄：「当团队只有你一个人、且不打算长期维护两套服务时，退回 C01」
   *       → 作为"什么时候回头看 C03"读是自相矛盾的：它说的是"一个人时退回 C01"，
   *         而"一个人"恰恰是不该用 C03 的场景。
   *     ✓ 翻转：「等你有了团队、并且愿意长期维护两套服务时，再回头看它」
   *
   * 校验器用 `fact.reconsider_copied` 拦照抄（2-gram 覆盖率 >90%）。
   */
  reconsider_when: string;
  /**
   * 溯源：reconsider_when 翻转所依据的原文。
   * 校验器要求它必须是 rejected[].when_to_leave 的子串（去空白后）。
   * 空字符串只允许在"该组合本来就没有 when_to_leave"时出现。
   * 这个字段只用于校验与排查，不渲染给用户。
   */
  source_when_to_leave: string;
}

export interface NextStep {
  action: string;
  minutes: number;
  blocker: string;
}

export interface Pitfall {
  text: string;
  /** 必须指向 combo.beginner_pitfalls 的下标 */
  source_index: number;
}

export interface LighterAlternative {
  /** 有没有更轻的替代（用户明确要求"太重就降档"） */
  needed: boolean;
  /** 若 needed=true，必须是 lighterCandidates 里的 id */
  combo_id: string | null;
  why: string;
}

/** LLM 必须输出的完整结构 */
export interface ExplanationPackage {
  combo_id: string;
  one_pager: {
    headline: string;
    why: string;
    first_step: { action: string; minutes: number };
  };
  not_chosen: NotChosenItem[];
  next_three_steps: NextStep[];
  pitfalls: Pitfall[];
  lighter_alternative: LighterAlternative;
}

/** 喂给 LLM 的上下文：只包含闭集里的事实，不含任何外部知识 */
export interface ExplainContext {
  combo: {
    id: string;
    name: string;
    one_liner: string;
    paradigm: string;
    components: Record<string, string | null>;
    first_step: string;
    first_step_minutes: number;
    when_to_leave: string;
    beginner_pitfalls: string[];
  };
  /** 用户约束，原样给（LLM 写"为什么"时要引用具体字段） */
  vector: Record<string, unknown>;
  confidence: Confidence;
  /** 引擎从原文推断出来的能力（如 data_persistence），LLM 不能假装没看见 */
  inferred: { capabilities: string[]; evidence?: string };
  /** 被淘汰的候选，供写不选清单 */
  rejected: Array<{
    id: string;
    name: string;
    tier: '差一点入选' | '被硬过滤';
    score: number | null;
    reason: string;
    when_to_leave: string;
  }>;
  /** 比当前方案更轻的候选（用于降档建议） */
  lighterCandidates: Array<{ id: string; name: string; one_liner: string; score: number; tradeoff: string }>;
}

/** 校验结果 */
export interface ValidationIssue {
  code: string;
  field: string;
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** 一次解释生成的结果（含降级链路） */
export interface ExplainResult {
  ok: boolean;
  /** 最终交付给用户的内容 */
  pkg: ExplanationPackage;
  /** 内容从哪来：llm = 模型写的；fallback = 模板安全文案 */
  source: 'llm' | 'fallback';
  /** 尝试了几次（1 = 一次成功；0 = 没调 LLM 直接兜底） */
  attempts: number;
  /** 失败原因（fallback 时必有） */
  failure?: { stage: 'transport' | 'parse' | 'validate'; detail: string };
  /** 每次失败的校验问题，用于调 prompt */
  issues: ValidationIssue[];
  /** token 用量，用于成本核算 */
  usage?: { input_tokens: number; output_tokens: number };
  /** 最后一次模型原始输出（调试/评测用，不交付给用户） */
  raw_text?: string;
  latency_ms: number;
}
