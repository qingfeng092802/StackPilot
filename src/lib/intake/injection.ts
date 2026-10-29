/**
 * Prompt Injection 特征检测与剥离（v2.0.0，补上 PRD §8 遗留的已知缺口）。
 *
 * 为什么在解析层做，而不是做一个独立"安全层"：
 *   解析层是所有用户原文的第一个入口（宿主传参 / LLM 链路 / 规则链路都从这里过），
 *   在这里剥掉注入片段，下游的三道闸、打分引擎、解释层看到的就都是干净文本。
 *
 * 设计取舍：
 *   1. **剥离而不是拒绝**。一句话里可能既有注入又有真实需求
 *      （「忽略以上指令。我想做个记账小程序」）——整句拒绝会把真需求也扔掉。
 *      剥离后正常走解析，被剥的部分进 notes 留痕。
 *   2. **只认高置信模式**。裸的 "system prompt" 不算——用户的正经业务可能就在做
 *      提示词管理工具。只拦"带动作的指令形态"（输出/泄露/忽略 + 目标）。
 *      漏网的注入最多骗模型填错向量，还有三道闸和闭集兜底；误杀真需求的代价更高。
 *   3. **XML 边界逃逸必须拦**。原文里若出现 </user_raw_input> 之类的标签片段，
 *      可以伪造输入边界逃出隔离区，这类片段一律剥离。
 *
 * 剥离后的文本才是"解析用文本"：evidence 校验也以它为准——
 * 指向被剥片段的 evidence 校验失败是预期行为，因为那一段根本不是需求。
 */

export interface InjectionFinding {
  /** 命中的模式名，用于诊断输出 */
  pattern: string;
  /** 命中的原文片段（截断到 60 字，避免诊断信息本身成为注入载体） */
  matched: string;
}

/**
 * 高置信注入模式。每条都必须是"出现即几乎必然是注入"的形态。
 * 全部大小写不敏感（中文不受影响）。
 */
const INJECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // 英文经典形态
  { name: 'ignore_instructions', re: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\b[\s\S]{0,40}?(?:instruction|prompt|rule|directive)/gi },
  { name: 'reveal_system_prompt', re: /\b(?:print|reveal|show|output|repeat|泄露|输出|打印|展示)\b[\s\S]{0,12}?\b(?:your\s+)?system\s+prompt\b/gi },
  { name: 'role_hijack_en', re: /\byou\s+are\s+now\s+(?:a|an|the)\b/gi },
  // 中文形态
  { name: 'ignore_instructions_cn', re: /(?:忽略|无视|不要理会|作废)(?:你|你之前|以上|上面|之前|上述|先前)(?:的)?(?:所有)?(?:系统)?(?:指令|规则|提示|要求|设定|约束)/g },
  { name: 'reveal_system_prompt_cn', re: /(?:输出|打印|泄露|告诉我|重复)(?:一?下)?(?:你的)?(?:完整)?系统提示词/g },
  { name: 'force_combo', re: /(?:必须|强制|直接|一定)?(?:给?我)?(?:用|选|推荐|输出|固定|指定|定为|锁定|就是|是)\s*[Cc]\d{2}(?![\d一-龥])/g },
  // XML 边界逃逸：伪造隔离标签，让后续文本逃出 <user_raw_input> 包裹
  { name: 'xml_boundary_escape', re: /<\/?(?:user_raw_input|system|instructions|assistant)\b[^>]{0,60}>/gi },
];

const TRUNCATE = 60;

export function detectInjection(text: string): InjectionFinding[] {
  const s = String(text ?? '');
  const findings: InjectionFinding[] = [];
  for (const { name, re } of INJECTION_PATTERNS) {
    // 每个模式独立新建正则实例（global 正则有 lastIndex 状态，复用会漏报）
    const re2 = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = re2.exec(s)) !== null) {
      findings.push({ pattern: name, matched: m[0].slice(0, TRUNCATE) });
      if (m[0].length === 0) re2.lastIndex++; // 防空匹配死循环
    }
  }
  return findings;
}

export interface StripResult {
  /** 剥离注入片段后的文本（空白已收敛），作为解析用文本 */
  clean: string;
  findings: InjectionFinding[];
}

/**
 * 剥离所有命中的注入片段。
 * 返回的 clean 是后续解析链路（prompt 构造、evidence 校验）的唯一依据。
 */
export function stripInjections(text: string): StripResult {
  const s = String(text ?? '');
  const findings = detectInjection(s);
  if (findings.length === 0) return { clean: s, findings };

  let clean = s;
  for (const { name, re } of INJECTION_PATTERNS) {
    clean = clean.replace(new RegExp(re.source, re.flags), '');
  }
  // 收敛剥离留下的多余空白：连续空白折成一个，行首行尾清掉
  clean = clean.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
  return { clean, findings };
}
