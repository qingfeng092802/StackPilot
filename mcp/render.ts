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
  /** llm = 模型抽取；rule = 无 key 时的关键词规则 */
  mode: 'llm' | 'rule';
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
  if (info.mode === 'rule') {
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
    out.push(`**没读到、也没追问**：${info.missing.join('、')}。这些不影响结论方向，但会影响置信度。`);
    out.push('');
  }
  if (info.notes && info.notes.length) {
    out.push('**解析层备注**：');
    for (const n of info.notes) out.push(`- ${n}`);
    out.push('');
  }
  return out;
}

export interface RenderInput {
  result: RankResult;
  /** Top1 对应的组合原始定义（渲染技术栈要用 components） */
  combo: Combo;
  pkg: ExplanationPackage;
  bootstrap: string;
  parse: ParseInfo;
  rawInput: string;
}

export function renderRecommendation(input: RenderInput): string {
  const { result, combo, pkg, bootstrap, parse, rawInput } = input;
  const top1 = result.top1;
  const out: string[] = [];

  out.push(`# 推荐：${top1.name}`);
  out.push('');
  out.push(`> ${pkg.one_pager?.headline ?? top1.name}`);
  out.push('>');
  out.push(`> 置信度 **${result.confidence}**　·　分数 ${top1.score.toFixed(2)}　·　候选 ${result.candidateCount} 套`);
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

  out.push('## 给 AI 的启动指令');
  out.push('');
  out.push('直接复制下面这段，粘到 Cursor / Claude Code 里：');
  out.push('');
  out.push('```text');
  out.push(bootstrap);
  out.push('```');
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

export function renderDetailedPrompt(opts: {
  comboName: string;
  comboId: string;
  prompt: string;
  pitfalls: string[];
  firstStep: string;
}): string {
  const out: string[] = [];
  out.push(`# ${opts.comboName}（${opts.comboId}）`);
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
