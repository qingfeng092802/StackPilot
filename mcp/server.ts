/**
 * StackPilot MCP Server（stdio 传输）v2.0.0
 *
 * 三个工具：
 *   recommend_stack        自然语言需求（或宿主结构化约束）→ 选型 + 启动 Prompt（Markdown）
 *   get_detailed_prompt    指定技术栈 + 需求 → 只出启动 Prompt
 *   apply_stack_blueprint  把架构契约直接落盘到目标项目（.cursor/rules/stackpilot.mdc + CLAUDE.md）
 *
 * 【最重要的五条实现约束】
 *
 * 1. **stdout 是协议通道，任何 console.log 都会把协议弄坏。**
 *    全文件只用 console.error 打日志；构建时 build.mjs 还会在产物顶部注入
 *    stdout 守卫，把第三方库的 console.log/info/warn 一并重定向到 stderr。
 *    这一条踩过一次就很难查——客户端只会说"连接失败"，不会告诉你原因。
 *
 * 2. **没 key 也要能用，宿主给了结构化参数就连模型都不用。**
 *    三级解析路由：
 *      路径 A —— 宿主模型（Cursor / Claude Code 自己的大模型）调用工具时直接传
 *                extracted_constraints，本地三道闸校验后直接用，零模型成本、零等待；
 *      路径 B —— 只传了自然语言且配了 ANTHROPIC_API_KEY → 内部 LLM 解析；
 *      路径 C —— 都没有 → 关键词规则 + 中文数量映射兜底。
 *    输出里明确标出走的是哪条路。
 *
 * 3. **不出方案时也要返回有用的东西。**
 *    低置信度不硬推：返回结构化追问协议，让宿主模型先去反问用户。
 *    blocked 时返回"还缺什么、该问用户什么"的 Markdown，agent 能接着对话。
 *
 * 4. **解析与选型永远是确定性的。**
 *    选哪套、装什么、第一步做什么全部由闭集引擎算出；启动指令与架构契约
 *    是模板渲染，不交给模型。模型（宿主或内部）只提供"约束提取"与"解释文案"，
 *    且两者都要过本地校验闸门。
 *
 * 5. **工具 handler 不许把异常抛成协议错误。**
 *    全部经 safeHandler 包裹：内部出错返回 isError:true 的可读 Markdown，
 *    进程级兜底监听 uncaughtException / unhandledRejection，绝不意外退出。
 */

// ── stdout 守卫（源码直跑 / tsx 时生效；bundle 产物由 build.mjs 的 banner 更早注入）──
for (const m of ['log', 'info', 'warn', 'debug'] as const) {
  (console as any)[m] = (...args: unknown[]) => console.error('[stdout-guard]', ...args);
}
process.on('uncaughtException', (e) => {
  console.error('[stackpilot] uncaughtException（进程保持存活）:', (e as Error)?.stack ?? String(e));
});
process.on('unhandledRejection', (e) => {
  console.error('[stackpilot] unhandledRejection（进程保持存活）:', e instanceof Error ? e.stack : String(e));
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import combosRaw from '../src/data/combos.json' with { type: 'json' };
import { rank } from '../src/lib/scoring.ts';
import type { Combo, ConstraintVector } from '../src/lib/scoring.ts';
import { intake, parseIntake, stripInjections } from '../src/lib/intake/index.ts';
import { computeConfidence, coverageStatus, questionsFor, SCORED_FIELDS } from '../src/lib/confidence.ts';
import { AnthropicProvider } from '../src/lib/explain/provider.ts';
import { buildExplainContext, explain } from '../src/lib/explain/index.ts';
import { buildFallback } from '../src/lib/explain/fallback.ts';
import { buildAiBootstrapPrompt, buildDetailedPrompt } from '../src/lib/explain/bootstrap.ts';
import { quickParse } from './quick-parse.ts';
import { renderRecommendation, renderDetailedPrompt } from './render.ts';
import type { ParseInfo } from './render.ts';
import { applyBlueprint } from './blueprint.ts';
import { scaffoldBlueprint } from './scaffold.ts';
import { inspectProject } from './inspect.ts';
import { recordOutcome } from '../src/lib/telemetry.ts';
import { blockedMarkdown } from './blocked.ts';

const combos = (combosRaw as any).combos as Combo[];
const comboById = new Map(combos.map((c) => [c.id, c]));

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
const MODEL = process.env.ANTHROPIC_MODEL ?? 'deepseek-flash';
const VERSION = '2.1.0';

/** 日志一律走 stderr —— stdout 留给 JSON-RPC */
function log(...args: unknown[]) {
  console.error('[stackpilot]', ...args);
}

// ────────────────────────────────────────────────────────────
// extracted_constraints 的 Schema：与 parseIntake 的 modelJson 同构。
// 宿主传进来的每个字段都会被本地三道闸校验（逐字溯源 / 枚举+极性 / 数值换算），
// 校验不过的字段直接丢弃并留痕——所以宿主"手痒填了原文里没有的值"是安全的。
// passthrough 保留约定外的键，让 parseIntake 的字段名检查能留下 dropped 记录。
// ────────────────────────────────────────────────────────────

const evidenceDesc = '原文中逐字连续出现、且能支撑这个取值的片段。严禁改写、概括或拼接，严禁填原文里没有的内容';

const enumBox = (values: readonly [string, ...string[]], valueDesc: string) =>
  z
    .object({
      value: z.enum(values).describe(valueDesc),
      evidence: z.string().min(1).describe(evidenceDesc),
    })
    .optional();

const extractedSchema = z
  .object({
    delivery: enumBox(
      ['web', 'miniprogram', 'selfhost', 'desktop', 'api', 'agent', 'cli'] as const,
      '交付形态。原文没说就是没说，不要按常识补'
    ),
    team_size: enumBox(['1', '2-3', '5+'] as const, '开发人数档位'),
    ai_workflow: enumBox(
      ['full_auto', 'assisted', 'learning'] as const,
      '谁写代码：full_auto=人基本不写全让 AI 写；assisted=AI 写人来改；learning=自己写为主想学。只认分工表述，"技术一般"不是分工'
    ),
    goal_type: enumBox(['product', 'internal_tool', 'portfolio'] as const, '项目目的'),
    expected_users: z
      .object({ amount: z.number().positive(), evidence: z.string().min(1).describe(evidenceDesc + '（片段里必须含数字）') })
      .optional(),
    timeline: z
      .object({
        amount: z.number().positive(),
        unit: z.enum(['day', 'week', 'month']).describe('只输出原文的单位，不要换算'),
        evidence: z.string().min(1).describe(evidenceDesc + '（片段里必须含数字）'),
      })
      .optional(),
    budget: z
      .object({
        amount: z.number().nonnegative(),
        unit: z.enum(['month', 'year']).describe('只输出原文的单位，不要换算'),
        evidence: z.string().min(1).describe(evidenceDesc + '（片段里必须含数字）'),
      })
      .optional(),
    capabilities: z
      .object({
        values: z
          .array(z.enum(['auth', 'payment', 'ai', 'realtime', 'file_upload', 'file_storage', 'data_persistence', 'multi_platform', 'no_persistence'] as const))
          .max(9)
          .describe('注意：data_persistence（要存服务端）与 no_persistence（只存浏览器/本地）互斥，不能同时出现'),
        evidence: z.string().min(1).describe(evidenceDesc),
      })
      .optional(),
    compliance: z
      .object({ values: z.array(z.enum(['personal_data', 'payment'] as const)).max(2), evidence: z.string().min(1).describe(evidenceDesc) })
      .optional(),
  })
  .passthrough()
  .optional()
  .describe(
    '从 raw_input 中提取的结构化约束（可选，但强烈建议提供）。' +
      '每个字段必须附 evidence：raw_input 中逐字连续存在的片段；原文没提到的维度请整体省略，严禁脑补。' +
      '所有字段都会经过本地 evidence 溯源与极性校验，未通过的字段会被丢弃并在结果中留痕。'
  );

type ExtractedConstraints = z.infer<typeof extractedSchema>;

/** 解析结果 → 渲染用的 ParseInfo（三条路径共用） */
function toParseInfo(
  mode: ParseInfo['mode'],
  vector: ConstraintVector,
  evidence: Record<string, string>,
  dropped: Array<{ field: string; reason: string }>,
  injectionNotes: string[],
): ParseInfo {
  return {
    mode,
    hits: Object.entries(evidence).map(([field, ev]) => ({
      field,
      value: JSON.stringify((vector as any)[field] ?? ''),
      evidence: String(ev),
    })),
    missing: SCORED_FIELDS.filter((f) => !(f in evidence)),
    defaulted: [
      ...(vector.ai_workflow ? [] : ['ai_workflow → assisted（缺省权重档）']),
      ...(vector.goal_type ? [] : ['goal_type → internal_tool 权重档']),
    ],
    notes: [...injectionNotes, ...dropped.map((d) => `${d.field}：${d.reason}`)].filter(Boolean),
  };
}

async function recommendStack(rawInput: string, extracted?: ExtractedConstraints): Promise<string> {
  const raw0 = String(rawInput ?? '').trim();
  if (raw0.length < 4) {
    return '# 需求太短了\n\n再多说两句：你想做的东西给谁用、大概什么形态、要哪些功能。';
  }

  // ── 0. 注入剥离：三条路径共用同一份干净文本 ─────────────────
  const { clean, findings } = stripInjections(raw0);
  const injectionNotes = findings.map((f) => `检测到疑似注入指令（模式 ${f.pattern}）并已剥离：「${f.matched}」`);
  if (clean.length < 4) {
    return [
      '# 原始需求里没有可用的业务内容',
      '',
      ...(injectionNotes.length ? injectionNotes.map((n) => `- ${n}`) : ['- 输入过短或全部被安全过滤']),
      '',
      '请把真实的产品需求再说一遍：想做什么、给谁用、要哪些功能。',
    ].join('\n');
  }
  const raw = clean;

  // ── 1. 解析：三级路由 ─────────────────────────────────────
  let vector: ConstraintVector;
  let parse: ParseInfo;

  const hasExtracted = extracted && typeof extracted === 'object' && Object.keys(extracted).length > 0;

  if (hasExtracted) {
    // ── 路径 A：宿主结构化参数 → 本地三道闸（零模型成本）────────
    const pr = parseIntake(raw, extracted);
    const conf = computeConfidence(pr.vector);
    const cov = coverageStatus(pr.vector, raw);
    vector = pr.vector;
    parse = toParseInfo('host', pr.vector, pr.evidence, pr.dropped, [...injectionNotes, ...pr.warnings]);
    log(
      `intake(host) adopted=${Object.keys(pr.evidence).length} dropped=${pr.dropped.length} ` +
        `confidence=${conf.confidence} coverage=${cov.status} injected=${findings.length}`
    );

    // 闸门后立刻做两级拦截，不把猜的值带进选型
    if (cov.status === 'uncovered') {
      return blockedMarkdown({ reason: 'uncovered' }, raw);
    }
    if (conf.confidence === 'low') {
      return blockedMarkdown(
        { reason: 'low_confidence', suggested_fields: conf.suggested_fields, questions: questionsFor(conf.suggested_fields) },
        raw,
      );
    }
  } else if (HAS_KEY) {
    // ── 路径 B：服务端自配 key → 内部 LLM 解析 ─────────────────
    const r = await intake({ raw_input: raw, provider: new AnthropicProvider() });
    vector = r.parsed;
    parse = toParseInfo('llm', r.parsed, r.evidence, r.dropped, [
      ...injectionNotes,
      ...r.notes.filter((n) => !n.startsWith('检测到疑似注入指令')), // intake 内部已剥离过一次，别重复记
    ]);
    log(`intake(llm) ok=${r.ok} confidence=${r.confidence} dropped=${r.dropped.length}`);
    if (!r.ok) {
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
    // ── 路径 C：关键词规则 + 中文数量映射（离线兜底）────────────
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
      notes: injectionNotes,
    };
    log(`intake(rule) hits=${q.hits.length} injected=${findings.length}`);
  }

  // ── 2. 选型（确定性引擎）─────────────────────────────────
  const result = rank(combos, vector, { raw_input: raw });
  // 匿名反馈（v2.1.0）：SP_TELEMETRY=1 才开启，纯本地、无原文无路径
  recordOutcome({
    mode: parse.mode,
    ok: result.ok,
    confidence: result.ok ? result.confidence : (result as any).confidence,
    top1_id: result.ok ? result.top1.id : null,
    candidate_count: result.ok ? result.candidateCount : 0,
    blocked_reason: result.ok ? null : (result as any).reason,
    adopted_fields: Object.keys(parse.hits ?? {}).length,
    missing_fields: (parse.missing ?? []).length,
  });
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
    lastReviewed: (combo as any).last_reviewed,
  });
}

// ────────────────────────────────────────────────────────────
// 工具 handler 的统一异常兜底：内部错误 → isError:true 的可读 Markdown，
// 不把异常抛成 JSON-RPC protocol error（那在部分客户端里表现为"连接断开"）。
// ────────────────────────────────────────────────────────────

type ToolArgs = Record<string, unknown>;
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function safeHandler(
  name: string,
  fn: (args: ToolArgs) => Promise<string | ToolResult>,
): (args: ToolArgs) => Promise<ToolResult> {
  return async (args) => {
    try {
      const out = await fn(args);
      if (typeof out === 'string') return { content: [{ type: 'text', text: out }] };
      return out;
    } catch (e) {
      log(`${name} handler error:`, (e as Error)?.stack ?? String(e));
      return {
        content: [{
          type: 'text',
          text:
            `# 工具内部错误\n\n` +
            `\`${name}\` 执行时出现未预期的异常，已安全拦截：${String((e as Error)?.message ?? e).slice(0, 200)}\n\n` +
            '可以重试一次；若持续出现，请把上面的错误信息反馈给 stackpilot 维护者。',
        }],
        isError: true,
      };
    }
  };
}

// ────────────────────────────────────────────────────────────
// 注册工具
// ────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'stackpilot', version: VERSION });

server.registerTool(
  'recommend_stack',
  {
    title: '推荐技术栈并生成 AI 启动 Prompt',
    description:
      '根据用户的自然语言需求推荐一套技术架构，并给出可以直接粘给 AI（Cursor / Claude Code）的启动 Prompt。' +
      '适合用户说"我想做个 XX，该用什么技术栈"时调用。返回 Markdown，包含 Top1 方案、为什么不选其他、以及启动指令。' +
      '【调用方式】请把用户的原始原话完整填入 raw_input；同时尽可能从原话中提取结构化约束填入 extracted_constraints——' +
      '每个提取字段必须附带 raw_input 中逐字存在的 evidence 子串，原文未提及的维度请整体省略，严禁脑补。' +
      '若返回结果以「需要补充信息」开头，请先按其中的问题向用户追问，不要继续生成方案。',
    inputSchema: {
      raw_input: z
        .string()
        .describe(
          '用户的自然语言需求，完整原话，尽量保留原话（原话里的语气词也是信息）。' +
            '即使同时提供了 extracted_constraints 也必须传：evidence 校验与启动指令都以它为准'
        ),
      extracted_constraints: extractedSchema,
    },
  },
  safeHandler('recommend_stack', async (args) => {
    const extracted = (args as any).extracted_constraints as ExtractedConstraints | undefined;
    return recommendStack(String((args as any).raw_input ?? ''), extracted);
  }),
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
  safeHandler('get_detailed_prompt', async (args) =>
    detailedPrompt(String((args as any).combo_id ?? ''), String((args as any).user_requirements ?? '')),
  ),
);

server.registerTool(
  'apply_stack_blueprint',
  {
    title: '把架构规范写入项目规则文件（落盘）',
    description:
      '把选定组合的架构契约（技术栈清单、明确禁止事项、第一步动作、高频新手坑、协作方式）' +
      '写入目标项目的 .cursor/rules/stackpilot.mdc（Cursor 规则，alwaysApply）与 CLAUDE.md（Claude Code 记忆文件）。' +
      '写入后 AI 在该项目中会自动遵守这套约束。在用户确认了推荐方案、准备开始搭建项目时调用。' +
      'workspace_path 必须是已存在的项目目录的本地绝对路径。',
    inputSchema: {
      combo_id: z.string().describe('组合 ID，如 C01 / C07（通常取 recommend_stack 输出的 Top1）'),
      workspace_path: z.string().describe('目标项目的本地绝对路径（目录必须已存在）'),
      target_ide: z
        .enum(['cursor', 'claude_code', 'both'])
        .default('both')
        .describe('写入哪个 IDE 的规则文件，默认两个都写'),
    },
  },
  safeHandler('apply_stack_blueprint', async (args) => {
    const r = applyBlueprint(
      {
        combo_id: String((args as any).combo_id ?? ''),
        workspace_path: String((args as any).workspace_path ?? ''),
        target_ide: (args as any).target_ide as any,
      },
      combos,
    );
    if (!r.ok) {
      // 参数级错误按 MCP 规范标 isError，让宿主明确知道这次调用失败了
      return {
        content: [{
          type: 'text',
          text:
            `# 落盘失败\n\n${r.error}\n\n` +
            '修正参数后重试。注意 workspace_path 要指向**已存在**的项目目录。',
        }],
        isError: true,
      };
    }
    const lines: string[] = ['# 架构契约已写入项目规则文件', ''];
    for (const f of r.files) {
      lines.push(`- ${f.path}（${f.action === 'created' ? '新建' : '已幂等更新'}）`);
    }
    lines.push('');
    lines.push('## 给你的立即执行指令');
    lines.push('');
    lines.push('```text');
    lines.push(r.instruction);
    lines.push('```');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }),
);

server.registerTool(
  'scaffold_blueprint',
  {
    title: '按组合生成可运行项目骨架（落盘）',
    description:
      '把选定组合的技术栈生成为可运行的项目骨架：锁定版本的 package.json（版本按 facts 快照溯源）、' +
      '目录结构、hello-world 入口、.env.example、.gitignore，并顺带写入架构契约（.cursor/rules/stackpilot.mdc 与 CLAUDE.md）。' +
      '骨架 100% 模板确定性生成。workspace_path 必须是不存在的路径（会创建）或已存在且为空的目录——' +
      '**永不覆盖用户文件**；要往既有项目写规范请改用 apply_stack_blueprint。用户确认了选型、准备从零开建项目时调用。',
    inputSchema: {
      combo_id: z.string().describe('组合 ID，如 C01 / C07（通常取 recommend_stack 输出的 Top1）'),
      workspace_path: z.string().describe('新项目目录的本地绝对路径（必须不存在或为空目录）'),
      target_ide: z.enum(['cursor', 'claude_code', 'both']).default('both').describe('架构契约写入哪个 IDE 的规则文件'),
    },
  },
  safeHandler('scaffold_blueprint', async (args) => {
    const r = scaffoldBlueprint(
      {
        combo_id: String((args as any).combo_id ?? ''),
        workspace_path: String((args as any).workspace_path ?? ''),
        target_ide: (args as any).target_ide as any,
      },
      combos,
    );
    if (!r.ok) {
      return {
        content: [{ type: 'text', text: `# 骨架落盘失败\n\n${r.error}` }],
        isError: true,
      };
    }
    return {
      content: [{
        type: 'text',
        text: `# 骨架已生成（${r.fileCount} 个文件）\n\n- 项目根：${r.root}\n- 第一步：${r.nextStep}\n\n## 给你的立即执行指令\n\n\`\`\`text\n${r.instruction}\n\`\`\``,
      }],
    };
  }),
);

server.registerTool(
  'inspect_project',
  {
    title: '反查存量项目与蓝图的偏离（只读）',
    description:
      '读取目标项目的 package.json / 小程序配置，判定它离 12 套闭集蓝图里哪套最近、' +
      '偏离了哪几条（缺了哪些锁定依赖、多了哪些清单外依赖）。**只读工具**，读到的文件清单会回显。' +
      '用户说"看看我现在的项目该用什么/缺什么"时调用。monorepo / 无法识别的形态会明确拒绝，不硬猜。',
    inputSchema: {
      workspace_path: z.string().describe('目标项目的本地绝对路径（目录）'),
    },
  },
  safeHandler('inspect_project', async (args) => {
    const r = inspectProject({ workspace_path: String((args as any).workspace_path ?? '') }, combos);
    return { content: [{ type: 'text', text: r.markdown }], ...(r.isError ? { isError: true } : {}) };
  }),
);

// ────────────────────────────────────────────────────────────
// 启动
// ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready v${VERSION} (mode=${HAS_KEY ? `llm/${MODEL}` : 'rule-based, no key'}; host-extraction enabled)`);
