/**
 * 把选型结果渲染成 Markdown —— 这是**大模型真正读到的东西**。
 *
 * 三个设计约束，都是"给 agent 读"这个场景特有的：
 *   1. **不写客套话**。agent 不需要"希望对你有帮助"，它会把这些字也算进上下文。
 *   2. **表格优先于散文**。模型从表格里取字段比从长句里取更稳。
 *   3. **启动 Prompt 用代码块包住**。这样调用方可以直接原样转发给下游模型，
 *      不会被自己的 markdown 渲染器吃掉缩进。
 *
 * 另外每一份输出都带一段「输入解读」：把规则层读到什么、哪些用了默认值写清楚。
 * 这不是给用户看的装饰——agent 需要它来判断"要不要再追问一句"。
 */

import type { RankResult, ConstraintVector, Combo } from '../src/lib/scoring.ts';
import type { ExplanationPackage } from '../src/lib/explain/types.ts';
import { COMPONENT_NAMES } from '../src/data/component-names.ts';

const SLOTS: Array<[string, string]> = [
  ['fe', '前端'], ['be', '接口层'], ['db', '数据库'], ['ai', 'AI'], ['deploy', '部署'],
];

const WORKFLOW_CN: Record<string, string> = {
  full_auto: '全让 AI 写', assisted: 'AI 写我来改', learning: '自己写为主',
};
const DELIVERY_CN: Record<string, string> = {
  web: '网页', miniprogram: '微信小程序', desktop: '桌面客户端',
  api: 'API', agent: 'Agent', cli: '命令行', selfhost: '自部署',
};

export interface ParseInfo {
  /**
   * host = 宿主模型调用工具时直接传入了结构化约束（本地三道闸校验）；
   * llm  = 服务端自配 key 走模型抽取；rule = 无 key 时的关键词规则
   */
  mode: 'host' | 'llm' | 'rule';
  /** 读到的东西（字段 → 值 ← 原文依据） */
  hits: Array<{ field: string; value: string; evidence: string }>;
  /** 缺失的字段 */
  missing: string[];
  /** 用了默认值的字段 */
  defaulted: string[];
  /** 解析层的告警（例如证据不足被丢弃的字段） */
  notes?: string[];
}

function stackLines(components: Record<string, string | null>): string[] {
  const out: string[] = [];
  for (const [slot, label] of SLOTS) {
    const id = components[slot];
    if (!id) continue;
    const meta = COMPONENT_NAMES[id];
    out.push(`- **${label}**：${meta?.name ?? id}${meta?.role ? ` —— ${meta.role}` : ''}`);
  }
  return out;
}

function vectorLine(v: ConstraintVector): string {
  const bits: string[] = [];
  if (v.delivery) bits.push(DELIVERY_CN[v.delivery] ?? v.delivery);
  if (v.ai_workflow) bits.push(WORKFLOW_CN[v.ai_workflow] ?? v.ai_workflow);
  if (v.team_size) bits.push(`${v.team_size} 人`);
  if (v.expected_users) bits.push(`${v.expected_users} 用户`);
  if (v.timeline_weeks) bits.push(`${v.timeline_weeks} 周`);
  if (v.budget_cny_month !== null && v.budget_cny_month !== undefined) bits.push(`¥${v.budget_cny_month}/月`);
  if (Array.isArray(v.required_capabilities) && v.required_capabilities.length) {
    bits.push(v.required_capabilities.join(' / '));
  }
  return bits.length ? bits.join(' · ') : '（没读到明确约束）';
}

/** 「输入解读」区块：agent 靠它决定要不要再问一句 */
function parseSection(info: ParseInfo): string[] {
  const out: string[] = [];
  out.push('## 输入解读');
  out.push('');
  if (info.mode === 'host') {
    out.push('> 解析方式：**宿主模型结构化传入**（你调用工具时直接给了 `extracted_constraints`），');
    out.push('> 本地已逐字段做过 evidence 逐字溯源与极性校验，未通过的字段已丢弃。零模型成本。');
    out.push('');
  } else if (info.mode === 'rule') {
    out.push('> ⚠️ 当前没有配置 `ANTHROPIC_API_KEY`，用的是**关键词规则**解析：');
    out.push('> 只认明确说出口的词，读不出的字段会留空并按默认值处理。配置 key 后可用模型解析，准确率更高。');
    out.push('');
  }
  if (info.hits.length) {
    out.push('| 字段 | 读到的值 | 原文依据 |');
    out.push('|---|---|---|');
    for (const h of info.hits) out.push(`| ${h.field} | ${h.value} | ${h.evidence} |`);
  } else {
    out.push('（一个字段都没读到，全部按默认值处理）');
  }
  out.push('');
  if (info.defaulted.length) {
    out.push(`**用了默认值**：${info.defaulted.join('、')}`);
    out.push('');
  }
  if (info.missing.length) {
    // 措辞要准：ai_workflow 缺了会改变权重档，进而改变排序——不能说"不影响结论方向"。
    const affectsRanking = info.missing.some((f) => f === 'ai_workflow' || f === 'delivery');
    out.push(
      `**没读到、也没追问**：${info.missing.join('、')}。` +
        (affectsRanking
          ? '其中交付形态 / AI 参与方式**会改变排序**，已按默认值处理——如果结论看着不对，先说清这两项。'
          : '这些不影响能否给出方案，但会降低置信度。'),
    );
    out.push('');
  }
  if (info.notes && info.notes.length) {
    out.push('**解析层备注**：');
    for (const n of info.notes) out.push(`- ${n}`);
    out.push('');
  }
  return out;
}

/**
 * 「⚠️ 避坑预警与平替方案」区块（v2.2.0，v2.3 文案改为人话）。
 *
 * 数据来自 combos.json 的 debate 字段——全部由**离线**生成或架构师人工撰写，
 * 运行时只做模板渲染，一个字不由模型现场发挥。
 * 这是对抗「顺从性偏见」的产品出口：用户拿到的是"这套方案哪里会翻车、翻车了去哪"。
 *
 * 无 debate 字段的旧数据整块跳过（向后兼容），绝不渲染空区块。
 */
export function renderDebateSection(combo: Combo, combos: Combo[]): string[] {
  const d = (combo as any).debate;
  if (!d) return [];
  const out: string[] = [];
  out.push('⚠️ 避坑预警与平替方案');
  out.push('');
  if (Array.isArray(d.red_team_warnings) && d.red_team_warnings.length) {
    out.push('**这套方案可能翻车的地方：**');
    out.push('');
    for (const w of d.red_team_warnings) out.push(`- ${w}`);
    out.push('');
  }
  if (d.plan_b?.alternative_combo) {
    const alt = combos.find((c) => c.id === d.plan_b.alternative_combo);
    if (alt) {
      out.push('**真不行了怎么办（Plan B）：**');
      out.push('');
      out.push(`- **什么时候该换**：${d.plan_b.trigger ?? '（未定义）'}`);
      out.push(`- **换哪套**：左转 ${alt.id}（${alt.name}）`);
      out.push('');
    }
  }
  // 没有任何可渲染内容就不输出标题，避免出现空区块
  return out.length > 2 ? out : [];
}

export interface RenderInput {
  result: RankResult;
  /** Top1 对应的组合原始定义（渲染技术栈要用 components） */
  combo: Combo;
  pkg: ExplanationPackage;
  bootstrap: string;
  parse: ParseInfo;
  rawInput: string;
  /** 闭集全量（渲染 Plan B 的组合名用，v2.2.0） */
  combos: Combo[];
}

export function renderRecommendation(input: RenderInput): string {
  const { result, combo, pkg, bootstrap, parse, rawInput, combos } = input;
  const top1 = result.top1;
  const out: string[] = [];

  out.push(`# 推荐：${top1.name}`);
  out.push('');
  out.push(`> ${pkg.one_pager?.headline ?? top1.name}`);
  out.push('>');
  out.push(`> 置信度 **${result.confidence}**　·　分数 ${top1.score.toFixed(2)}　·　候选 ${result.candidateCount} 套`);
  if ((combo as any).last_reviewed) {
    out.push(`> 最近复核于 ${(combo as any).last_reviewed}（技术栈时效性由人工审核维护）`);
  }
  if (result.confidence !== 'high' && result.confidence_warning) {
    out.push(`>`);
    out.push(`> ⚠️ ${result.confidence_warning}`);
  }
  out.push('');

  out.push('## 为什么是这套');
  out.push('');
  out.push(pkg.one_pager?.why ?? '（解释层没有给出理由）');
  out.push('');

  out.push('## 技术栈');
  out.push('');
  out.push(...stackLines(combo.components));
  out.push('');

  // 不选清单：散文来自解释包（已过校验），分数表来自引擎（可核对）
  out.push('## 为什么不选其他');
  out.push('');
  if (pkg.not_chosen?.length) {
    out.push('| 方案 | 为什么没选 | 什么时候值得回头看 |');
    out.push('|---|---|---|');
    for (const n of pkg.not_chosen) {
      out.push(`| ${n.what} | ${n.why} | ${n.reconsider_when} |`);
    }
  } else {
    out.push('（没有需要说明的落选方案）');
  }
  out.push('');
  const near = result.runnerUps.slice(0, 3);
  if (near.length) {
    const all = [result.top1, result.top2, ...near].sort((a, b) => b.score - a.score);
    out.push(`引擎侧的分数（可核对）：${all.map((s) => `${s.id} ${s.score.toFixed(2)}`).join('　>　')}`);
    if (result.filteredOut.length) {
      out.push('');
      out.push(`被硬性条件排除：${result.filteredOut.map((f) => `${f.id}（${f.reasons[0] ?? ''}）`).join('；')}`);
    }
    out.push('');
  }

  // ⚖️ 红队质疑与辩护（v2.2.0）：离线辩论的确定性渲染，挂在"为什么不选其他"之后
  out.push(...renderDebateSection(combo, combos));

  out.push('## 给 AI 的启动指令');
  out.push('');
  out.push('直接复制下面这段，粘到 Cursor / Claude Code 里；或者让 AI 调用 `apply_stack_blueprint` 工具一键落盘（见下方提示）：');
  out.push('');
  out.push('```text');
  out.push(bootstrap);
  out.push('```');
  out.push('');
  out.push(`> 💡 **提示**：你可以直接让 AI 调用 \`apply_stack_blueprint\` 工具（传入组合 ID \`${top1.id}\`），`);
  out.push('> 把上述架构规范与防坑指南一键写入当前项目的 `.cursor/rules/stackpilot.mdc` 和 `CLAUDE.md`，');
  out.push('> 之后 AI 在这个项目里会自动遵守这套约束，无需再手动粘贴。');
  out.push('');

  if (pkg.next_three_steps?.length) {
    out.push('## 接下来三步');
    out.push('');
    for (const s of pkg.next_three_steps) {
      out.push(`- **${s.action}**（约 ${s.minutes} 分钟）—— 容易卡在：${s.blocker}`);
    }
    out.push('');
  }

  out.push(...parseSection(parse));

  out.push('---');
  out.push('');
  out.push(`原始需求：${rawInput}`);
  if (result.inferred_capabilities.length) {
    out.push(`引擎额外推断：${result.inferred_capabilities.join('、')}（依据：${result.inference_evidence ?? '原文表述'}）`);
  }

  return out.join('\n');
}

/**
 * deep_architecture_review 的确定性渲染（v3.1.0）。
 * 输入是 runDeepReview 的结构化结果——本函数纯排版，不调模型、不产新事实。
 * 降级路径（某阶段超时/解析失败）在对应区块显示占位说明，绝不渲染空区块。
 */
export function renderDeepReview(r: {
  rawInput: string;
  perspectives: Array<{ angle: string; payload: { verdict: string; top_risks: string[] } | null; degraded?: string }>;
  redTeam: { contradictions: string[]; blind_spots: string[] } | null;
  verdict: {
    headline: string;
    recommended_stack: Array<{ layer: string; choice: string; reason: string }>;
    red_team_warnings: string[];
    plan_b: { trigger: string; fallback: string };
    open_questions: string[];
    combo_id: string | null;
  } | null;
  rawVerdictText: string | null;
  degraded: string[];
  elapsed_ms: number;
  in_closed_set: boolean;
  combo: Combo | null;
  candidatesPath: string | null;
  discipline: string[];
}): string {
  const out: string[] = [];
  out.push(`# 深度架构评审：${r.verdict?.headline ?? '（裁决未完成，以下为各视角原始材料）'}`);
  out.push('');
  out.push(`> 模式：\`deep_architecture_review\`　·　耗时 ${(r.elapsed_ms / 1000).toFixed(1)}s　·　多路模型调用，产生额外费用`);
  out.push('> 常规选型请用 `recommend_stack`（秒级、零成本、闭集兜底）。');
  if (r.degraded.length) {
    out.push(`> 降级说明：${r.degraded.join('；')}`);
  }
  out.push('');

  if (r.verdict) {
    out.push('## 推荐方案（Lead 裁决）');
    out.push('');
    for (const s of r.verdict.recommended_stack) {
      out.push(`- **${s.layer}**：${s.choice}${s.reason ? ` —— ${s.reason}` : ''}`);
    }
    out.push('');
    if (r.verdict.red_team_warnings.length) {
      out.push('## ⚠️ 红队风险警告');
      out.push('');
      for (const w of r.verdict.red_team_warnings) out.push(`- ${w}`);
      out.push('');
    }
    if (r.verdict.plan_b.trigger || r.verdict.plan_b.fallback) {
      out.push('## Plan B');
      out.push('');
      out.push(`- **什么时候推翻**：${r.verdict.plan_b.trigger || '（未给出）'}`);
      out.push(`- **换什么**：${r.verdict.plan_b.fallback || '（未给出）'}`);
      out.push('');
    }
    if (r.verdict.open_questions.length) {
      out.push('## 还需要确认');
      out.push('');
      for (const q of r.verdict.open_questions) out.push(`- ${q}`);
      out.push('');
    }
  } else if (r.rawVerdictText) {
    out.push('## Lead 裁决原文（JSON 解析失败，原样保留供人工判读）');
    out.push('');
    out.push('```text');
    out.push(r.rawVerdictText.slice(0, 2000));
    out.push('```');
    out.push('');
  }

  out.push('## 三视角盲评（独立评估，互不知情）');
  out.push('');
  for (const p of r.perspectives) {
    if (p.payload) {
      out.push(`### ${p.angle}`);
      out.push('');
      out.push(p.payload.verdict);
      if (p.payload.top_risks.length) {
        out.push('');
        for (const risk of p.payload.top_risks) out.push(`- 风险：${risk}`);
      }
      out.push('');
    } else {
      out.push(`### ${p.angle}`);
      out.push('');
      out.push(`（${p.degraded ?? '未完成'}——本视角缺位，结论已按可用材料降级）`);
      out.push('');
    }
  }

  if (r.redTeam) {
    out.push('## 红队挑刺（矛盾点与盲区）');
    out.push('');
    for (const c of r.redTeam.contradictions ?? []) out.push(`- 矛盾：${c}`);
    for (const b of r.redTeam.blind_spots ?? []) out.push(`- 盲区：${b}`);
    out.push('');
  }

  // 闭集交互兜底：在闭集 → 指路常规工具；不在 → 候选已记录 + 手动搭建建议
  if (r.in_closed_set && r.combo) {
    out.push('## 与闭集的关系');
    out.push('');
    out.push(`- 裁决落在闭集内（${r.combo.id} ${r.combo.name}）。**建议改用 \`recommend_stack\` 常规选型**拿到可核对的分数与落选清单，再用 \`scaffold_blueprint\`（combo_id=${r.combo.id}）直接生成可运行骨架——比手工搭建快得多。`);
    out.push('');
  } else if (r.verdict) {
    out.push('## 与闭集的关系');
    out.push('');
    out.push('- **此方案超出了 StackPilot 当前闭集覆盖范围**，评审结果已作为候选记录写入本地（`src/data/candidates-pending/`），作为未来扩集的评审材料。');
    out.push('- 建议把下面的启动指令直接粘给 AI 手动搭建。**注意：本方案没有骨架兜底**，以下纪律是实测踩坑换来的，逐条遵守：');
    out.push('');
    for (const d of r.discipline) out.push(`- ${d}`);
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(`原始需求：${r.rawInput}`);
  return out.join('\n');
}

export function renderDetailedPrompt(opts: {
  comboName: string;
  comboId: string;
  prompt: string;
  pitfalls: string[];
  firstStep: string;
}): string {
  const out: string[] = [];
  out.push(`# ${opts.comboName}（${opts.comboId}）`);
  if ((opts as any).lastReviewed) out.push(`\n> 最近复核于 ${(opts as any).lastReviewed}`);
  out.push('');
  out.push('## 给 AI 的启动指令');
  out.push('');
  out.push('```text');
  out.push(opts.prompt);
  out.push('```');
  out.push('');
  if (opts.pitfalls.length) {
    out.push('## 这套技术栈常见的坑');
    out.push('');
    opts.pitfalls.forEach((p, i) => out.push(`${i + 1}. ${p}`));
    out.push('');
  }
  return out.join('\n');
}
