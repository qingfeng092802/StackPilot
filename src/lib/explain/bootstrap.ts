/**
 * 生成"直接粘给 AI 的启动 Prompt"。
 *
 * 【为什么这段不交给模型写】
 * 它必须**只包含组合里真实存在的组件**。让模型自由生成，它很容易顺手写出
 * "用 Prisma 做 ORM""配一下 Redis 缓存"——而这两样可能根本不在 C11 的组件里。
 * 那正是解释层三层防幻觉要拦的东西（编造事实）。启动 Prompt 是**用户要拿去执行的**，
 * 编错的代价比解释文案更大：用户会照着它让 AI 装一堆不该装的东西。
 *
 * 所以这里用**模板填充**：组件名、槽位、约束、坑，全部来自 combos.json 与向量本身。
 * 模型仍然负责写"为什么是这套"（那部分需要语言能力），但不负责写"装什么"。
 *
 * 另一个好处是**确定性**：同样的输入永远得到同一段 Prompt，可以进测试。
 */

import type { Combo, ConstraintVector } from '../scoring.ts';
import { COMPONENT_NAMES } from '../../data/component-names.ts';

/** 槽位顺序固定，避免同一个组合两次生成出不同的顺序 */
const SLOTS: Array<[string, string]> = [
  ['fe', '前端'],
  ['be', '接口层'],
  ['db', '数据库'],
  ['ai', 'AI'],
  ['deploy', '部署'],
];

const WORKFLOW_CN: Record<string, string> = {
  full_auto: '基本不自己写，全让 AI 写',
  assisted: 'AI 写，我来改',
  learning: '我自己写为主，借这个项目学',
};

const DELIVERY_CN: Record<string, string> = {
  web: '网页', miniprogram: '微信小程序', desktop: '桌面客户端',
  api: '给别的程序调用的 API', agent: 'AI Agent / 机器人',
  cli: '命令行工具', selfhost: '自己部署到服务器 / NAS',
};

const CAP_CN: Record<string, string> = {
  auth: '登录', payment: '支付', ai: 'AI 能力', realtime: '实时同步',
  file_upload: '文件上传', file_storage: '文件存储',
  data_persistence: '数据要存服务端', no_persistence: '不要服务端存储（只存浏览器）',
  multi_platform: '一套代码多端',
};

/**
 * AI 生成纪律（v3.1.0 抽为常量）：从 36 轮真实跑批（批次 2026-10-30-flash-v1）的
 * 失败日志提炼，每一条都对应一类实测翻车。启动指令与深度评审（deep_architecture_review）
 * 共用同一份文本——两个入口给 AI 的纪律必须一字不差。
 */
export const AI_GENERATION_DISCIPLINE: string[] = [
  '**严禁引入需要 node-gyp 编译的原生依赖**（better-sqlite3、sqlite3、bcrypt 等）——用纯 JS / WASM 实现（如 `@libsql/client`）。实测中 AI 自选原生模块的项目在 Windows 上编译全部失败。',
  '**每 import 一个新包，立刻写进 package.json 的 dependencies**——实测中 AI 用了 openai 却没声明，build 直接 Module not found。',
  '**文件路径一律用正斜杠 `/`**——混合反斜杠的路径在 Windows 上会生成错误目录结构（实测踩坑）。',
  '**文件保持最小可运行**——不要内嵌大段 SVG / 图标 / 示例数据，输出超限被截断的产物等于零（实测撞满输出上限）。',
  '**部署配置不要自己发明**——部署工件（vercel.json / wrangler.toml / docker-compose 等）由骨架提供，实测 33 轮次中 AI 对它们的遗漏率是 92% 以上。',
];

export interface BootstrapInput {
  combo: Combo;
  vector: ConstraintVector;
  /** 用户原话，原样贴进 Prompt——AI 需要它来判断细节 */
  rawInput?: string;
  /** 第一步（来自解释包或 combos.json 的 first_step） */
  firstStep?: { action: string; minutes: number };
  /** 注意事项（来自解释包的 pitfalls，或 combos.json 的 beginner_pitfalls） */
  pitfalls?: string[];
}

/** 把组件槽位渲染成 "前端：Next.js —— 前端框架（含服务端渲染能力）" */
function renderStack(combo: Combo): string[] {
  const lines: string[] = [];
  for (const [slot, label] of SLOTS) {
    const id = (combo.components as Record<string, string | null>)[slot];
    if (!id) continue; // db / ai 允许为 null（C11 / C12）
    const meta = COMPONENT_NAMES[id];
    lines.push(`- **${label}**：${meta?.name ?? id}${meta?.role ? ` —— ${meta.role}` : ''}`);
  }
  return lines;
}

/** 把向量里"用户真说过的"约束翻成人话。没说的不写，避免 AI 以为那是需求 */
function renderConstraints(v: ConstraintVector): string[] {
  const out: string[] = [];
  if (v.delivery) out.push(`- 交付形态：${DELIVERY_CN[v.delivery] ?? v.delivery}`);
  if (v.ai_workflow) out.push(`- AI 参与方式：${WORKFLOW_CN[v.ai_workflow] ?? v.ai_workflow}`);
  if (v.team_size) out.push(`- 团队规模：${v.team_size === '1' ? '只有我一个人' : v.team_size + ' 人'}`);
  if (Array.isArray(v.required_capabilities) && v.required_capabilities.length) {
    out.push(`- 需要的能力：${v.required_capabilities.map((c) => CAP_CN[c] ?? c).join('、')}`);
  }
  if (v.expected_users) out.push(`- 预计用户量：${v.expected_users} 人`);
  if (v.timeline_weeks) out.push(`- 期望上线：${v.timeline_weeks} 周内`);
  if (v.budget_cny_month !== null && v.budget_cny_month !== undefined) {
    out.push(`- 每月预算：${v.budget_cny_month} 元`);
  }
  if (Array.isArray(v.compliance) && v.compliance.length) {
    out.push(`- 合规要求：${v.compliance.join('、')}`);
  }
  return out;
}

export function buildAiBootstrapPrompt(input: BootstrapInput): string {
  const { combo, vector, rawInput, firstStep, pitfalls } = input;

  const stack = renderStack(combo);
  const constraints = renderConstraints(vector);
  const step = firstStep ?? { action: combo.first_step ?? '', minutes: combo.first_step_minutes ?? 0 };
  const pits = (pitfalls && pitfalls.length ? pitfalls : combo.beginner_pitfalls ?? []).slice(0, 3);

  const parts: string[] = [];

  parts.push('你在帮我搭一个项目。技术选型已经定了，**请不要替换成别的框架**，也不要额外引入下面的清单里没有的服务。');
  parts.push('');
  parts.push(`## 技术栈（${combo.name}）`);
  parts.push(...stack);
  parts.push('');

  if (rawInput) {
    parts.push('## 我要做的东西（我的原话）');
    parts.push('> ' + rawInput.replace(/\n/g, '\n> '));
    parts.push('');
  }

  if (constraints.length) {
    parts.push('## 已知约束');
    parts.push(...constraints);
    parts.push('');
  }

  parts.push('## 第一步：只做这一件事，做完停下来告诉我');
  parts.push(step.action + (step.minutes ? `（预计 ${step.minutes} 分钟）` : ''));
  parts.push('');

  // 【硬性禁令】来自实测批次 2026-10-30-flash-v1 的两条最致命翻车：
  // 原生模块编译失败（C06 三轮 install 全挂）、依赖声明与 import 不一致（C11 build 翻车）。
  // 文本抽为 AI_GENERATION_DISCIPLINE 常量，与深度评审共用（v3.1.0）。
  parts.push('## 硬性禁令（实测踩坑，违反必翻车）');
  for (const line of AI_GENERATION_DISCIPLINE) parts.push(`- ${line}`);
  parts.push('');

  if (pits.length) {
    parts.push('## 写的时候特别注意这几个坑');
    pits.forEach((p, i) => parts.push(`${i + 1}. ${p}`));
    parts.push('');
  }

  parts.push('## 协作方式');
  parts.push('- 一次只做一步，改完告诉我改了哪些文件、为什么这么改。');
  parts.push('- 遇到需要我提供 key、账号、域名的地方，先停下来问我，不要自己编一个。');
  parts.push('- 如果上面的技术栈和我的需求明显冲突，先指出来，不要硬做。');

  return parts.join('\n');
}

/**
 * 给"某个技术栈 + 我的需求"用的精简版：`get_detailed_prompt` 那个工具的输出。
 * 和上面共用同一套模板，只是不依赖向量（用户可能只给了 combo_id）。
 */
export function buildDetailedPrompt(combo: Combo, userRequirements: string, pitfalls?: string[]): string {
  const stack = renderStack(combo);
  const pits = (pitfalls && pitfalls.length ? pitfalls : combo.beginner_pitfalls ?? []).slice(0, 3);
  const parts: string[] = [];

  parts.push(`你在帮我搭一个项目，技术栈已定：**${combo.name}**。请不要替换框架。`);
  parts.push('');
  parts.push('## 技术栈');
  parts.push(...stack);
  parts.push('');
  parts.push('## 我的需求');
  parts.push('> ' + (userRequirements || '（没写，先问我）').replace(/\n/g, '\n> '));
  parts.push('');
  parts.push('## 第一步');
  parts.push(combo.first_step ?? '先跟我确认需求细节');
  parts.push('');
  if (pits.length) {
    parts.push('## 注意');
    pits.forEach((p, i) => parts.push(`${i + 1}. ${p}`));
    parts.push('');
  }
  parts.push('## 协作方式');
  parts.push('- 一次只做一步，改完告诉我改了哪些文件、为什么。');
  parts.push('- 需要 key / 账号 / 域名时先停下来问我。');

  return parts.join('\n');
}
