/**
 * StackPilot MCP Server（stdio 传输）
 *
 * 两个工具：
 *   recommend_stack      自然语言需求 → 选型 + 给 AI 的启动 Prompt（Markdown）
 *   get_detailed_prompt  指定技术栈 + 需求 → 只出启动 Prompt
 *
 * 【最重要的三条实现约束】
 *
 * 1. **stdout 是协议通道，任何 console.log 都会把协议弄坏。**
 *    所以全文件只用 console.error 打日志。这一条踩过一次就很难查——
 *    客户端只会说"连接失败"，不会告诉你是因为你多打了一行字。
 *
 * 2. **没 key 也要能用。**
 *    Cursor / Claude Code 的用户大多没有配 ANTHROPIC_API_KEY。
 *    所以这里分两条路：有 key 走模型解析 + 模型解释；没 key 走关键词规则 + 模板兜底。
 *    输出里会明确标出走的哪条路，不让调用方误以为是模型判断的。
 *
 * 3. **不出方案时也要返回有用的东西。**
 *    直接抛错会让 agent 只看到 "tool failed"。所以 blocked 时返回一段
 *    "还缺什么、该问用户什么"的 Markdown，让 agent 能接着对话。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import combosRaw from '../src/data/combos.json' with { type: 'json' };
import { rank } from '../src/lib/scoring.ts';
import type { Combo, ConstraintVector } from '../src/lib/scoring.ts';
import { intake } from '../src/lib/intake/index.ts';
import { AnthropicProvider } from '../src/lib/explain/provider.ts';
import { buildExplainContext, explain } from '../src/lib/explain/index.ts';
import { buildFallback } from '../src/lib/explain/fallback.ts';
import { buildAiBootstrapPrompt, buildDetailedPrompt } from '../src/lib/explain/bootstrap.ts';
import { quickParse } from './quick-parse.ts';
import { renderRecommendation, renderDetailedPrompt } from './render.ts';
import type { ParseInfo } from './render.ts';

const combos = (combosRaw as any).combos as Combo[];
const comboById = new Map(combos.map((c) => [c.id, c]));

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
const MODEL = process.env.ANTHROPIC_MODEL ?? 'deepseek-flash';

/** 日志一律走 stderr —— stdout 留给 JSON-RPC */
function log(...args: unknown[]) {
  console.error('[stackpilot]', ...args);
}

/** 把缺字段翻成"该问用户什么"。blocked 时用它组织回复。 */
function missingHint(result: any): string[] {
  const fields: string[] = result.suggested_fields ?? [];
  const Q: Record<string, string> = {
    delivery: '这个东西最终以什么形式给用户用？（网页 / 小程序 / 桌面 / 命令行）',
    ai_workflow: '你打算让 AI 写多少？全让它写，还是你也会改？',
    required_capabilities: '需要登录、支付、AI、文件上传这些能力里的哪些？',
    team_size: '几个人做？',
    goal_type: '做这个是为了内部用、对外做产品，还是放作品集？',
    timeline_weeks: '希望多久能用上？',
    budget_cny_month: '每月能接受多少服务器成本？0 也可以。',
    expected_users: '预计多少人用？',
    compliance: '涉及支付或个人隐私数据吗？',
  };
  return fields.map((f) => `- ${Q[f] ?? f}`);
}

function blockedMarkdown(result: any, rawInput: string): string {
  const reasonCn: Record<string, string> = {
    uncovered: '当前模板库还没覆盖你的场景',
    low_confidence: '信息不足以给出可靠方案',
    insufficient_candidates: '约束之间互相打架，过滤后剩不下两套可比的方案',
  };
  const out: string[] = [];
  out.push(`# 暂时给不出方案：${reasonCn[result.reason] ?? result.reason}`);
  out.push('');
  out.push(`> 这不是失败，是**主动不猜**。硬给一个方案比不给更糟。`);
  out.push('');
  if (result.reason === 'uncovered') {
    out.push('当前闭集里的 12 套组合覆盖的是 Web / 小程序 / 自部署 / API / Agent / CLI 这几类形态，');
    out.push('你这套需求不在其中。可以告诉我：换成网页版（功能会打折）能不能接受？');
  } else {
    out.push('## 需要你再确认这几件事');
    out.push('');
    const hints = missingHint(result);
    out.push(...(hints.length ? hints : ['- 再多说两句你想做的东西：给谁用、大概什么形态、要哪些功能']));
  }
  out.push('');
  out.push('---');
  out.push('');
  out.push(`原始需求：${rawInput}`);
  return out.join('\n');
}

async function recommendStack(rawInput: string): Promise<string> {
  const raw = String(rawInput ?? '').trim();
  if (raw.length < 4) {
    return '# 需求太短了\n\n再多说两句：你想做的东西给谁用、大概什么形态、要哪些功能。';
  }

  // ── 1. 解析：有 key 走模型，没 key 走规则 ──────────────────
  let vector: ConstraintVector;
  let parse: ParseInfo;

  if (HAS_KEY) {
    const r = await intake({ raw_input: raw, provider: new AnthropicProvider() });
    vector = r.parsed;
    parse = {
      mode: 'llm',
      hits: Object.entries(r.evidence).map(([field, evidence]) => ({
        field,
        value: JSON.stringify((r.parsed as any)[field] ?? ''),
        evidence: String(evidence),
      })),
      missing: r.missing,
      defaulted: [
        ...(r.parsed.ai_workflow ? [] : ['ai_workflow → assisted']),
        ...(r.parsed.goal_type ? [] : ['goal_type → internal_tool 权重档']),
      ],
      notes: r.dropped.length ? r.dropped.map((d) => `${d.field}：${d.reason}`) : [],
    };
    log(`intake(llm) ok=${r.ok} confidence=${r.confidence} dropped=${r.dropped.length}`);
    if (!r.ok) {
      // 模型没读懂：不硬编向量，直接把"没读懂"交回去
      return [
        '# 没能把你的描述转成结构',
        '',
        `> ${r.failure?.detail ?? '解析失败'}（阶段：${r.failure?.stage ?? 'unknown'}）`,
        '',
        '可以换个说法再说一遍，比如："我想做个记账的小程序，大概 10 个人用，我自己一个人做"。',
        '',
        `原始需求：${raw}`,
      ].join('\n');
    }
  } else {
    const q = quickParse(raw);
    vector = q.vector;
    parse = {
      mode: 'rule',
      hits: q.hits,
      missing: q.unknown,
      defaulted: [
        ...q.assumed,
        ...(q.vector.ai_workflow ? [] : ['ai_workflow → assisted（按"AI 写我改"的权重档算）']),
        ...(q.vector.goal_type ? [] : ['goal_type → internal_tool 权重档']),
      ],
    };
    log(`intake(rule) hits=${q.hits.length}`);
  }

  // ── 2. 选型 ──────────────────────────────────────────────
  const result = rank(combos, vector, { raw_input: raw });
  if (!result.ok) return blockedMarkdown(result, raw);

  const combo = comboById.get(result.top1.id);
  if (!combo) throw new Error(`引擎给出了不存在的组合 ${result.top1.id}`);

  // ── 3. 解释：有 key 走模型（过校验），没 key 走模板 ─────────
  const ctx = buildExplainContext(result, combos, vector);
  let pkg;
  if (HAS_KEY) {
    const res = await explain({ context: ctx, provider: new AnthropicProvider(), maxAttempts: 2 });
    pkg = res.pkg;
    log(`explain source=${res.source} attempts=${res.attempts} issues=${res.issues.length}`);
  } else {
    pkg = buildFallback(ctx);
  }

  // ── 4. 启动 Prompt（确定性生成，不交给模型）───────────────
  const bootstrap = buildAiBootstrapPrompt({
    combo,
    vector,
    rawInput: raw,
    firstStep: pkg.one_pager?.first_step,
    pitfalls: (pkg.pitfalls ?? []).map((p: any) => p.text),
  });

  return renderRecommendation({ result, combo, pkg, bootstrap, parse, rawInput: raw });
}

function detailedPrompt(comboId: string, userRequirements: string): string {
  const combo = comboById.get(String(comboId ?? '').trim().toUpperCase());
  if (!combo) {
    const ids = combos.map((c) => `${c.id} ${c.name}`).join('\n- ');
    return [
      `# 没有 ${comboId} 这套组合`,
      '',
      '当前闭集里的组合是：',
      '',
      `- ${ids}`,
      '',
      '用 `recommend_stack` 可以让它自己选一套。',
    ].join('\n');
  }
  const prompt = buildDetailedPrompt(combo, userRequirements ?? '');
  return renderDetailedPrompt({
    comboName: combo.name,
    comboId: combo.id,
    prompt,
    pitfalls: combo.beginner_pitfalls ?? [],
    firstStep: combo.first_step ?? '',
  });
}

// ────────────────────────────────────────────────────────────
// 注册工具
// ────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'stackpilot', version: '1.7.0' });

server.registerTool(
  'recommend_stack',
  {
    title: '推荐技术栈并生成 AI 启动 Prompt',
    description:
      '根据用户的自然语言需求推荐一套技术架构，并给出可以直接粘给 AI（Cursor / Claude Code）的启动 Prompt。' +
      '适合用户说"我想做个 XX，该用什么技术栈"时调用。返回 Markdown，包含 Top1 方案、为什么不选其他、以及启动指令。',
    inputSchema: {
      raw_input: z.string().describe('用户的自然语言需求，尽量保留原话'),
    },
  },
  async ({ raw_input }) => {
    const text = await recommendStack(raw_input);
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'get_detailed_prompt',
  {
    title: '取指定技术栈的启动 Prompt',
    description:
      '已经知道要用哪套技术栈时（比如 combo_id=C01），直接拿它的启动 Prompt。' +
      '不重新选型，只生成"给 AI 的指令"。',
    inputSchema: {
      combo_id: z.string().describe('组合 ID，例如 C01 / C11 / C12'),
      user_requirements: z.string().describe('用户的需求描述，会被原样写进启动 Prompt'),
    },
  },
  async ({ combo_id, user_requirements }) => {
    const text = detailedPrompt(combo_id, user_requirements);
    return { content: [{ type: 'text', text }] };
  },
);

// ────────────────────────────────────────────────────────────
// 启动
// ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready (mode=${HAS_KEY ? `llm/${MODEL}` : 'rule-based, no key'})`);
