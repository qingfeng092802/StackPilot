/**
 * apply_stack_blueprint 的核心逻辑：确定性渲染架构契约 + 安全落盘。
 *
 * 【为什么独立成文件】写入文件系统这件事必须可以被单元测试直接打
 * （临时目录里真实写入、幂等覆盖、路径校验），不该藏在 server.ts 的
 * 工具 handler 里。server.ts 只做参数收发。
 *
 * 【确定性铁律】文件内容 100% 来自 combos.json + COMPONENT_NAMES + 固定模板，
 * 没有一个字交给模型自由发挥。和 bootstrap.ts 同一条红线：
 * 让模型写"装什么"，它就会顺手写出组合里没有的 Redis。
 *
 * 【幂等策略】
 *   stackpilot.mdc   —— 工具专属文件，整体覆盖（它只可能由本工具生成）
 *   CLAUDE.md        —— 用户/其他工具可能也有内容，只替换
 *                       <!-- STACKPILOT:START --> ~ <!-- STACKPILOT:END -->
 *                       标记之间的区间；无标记则追加，文件不存在则创建。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { Combo } from '../src/lib/scoring.ts';
import { COMPONENT_NAMES } from '../src/data/component-names.ts';

export type TargetIde = 'cursor' | 'claude_code' | 'both';

export interface BlueprintInput {
  combo_id: string;
  /** 目标项目的本地绝对路径。必须已存在且是目录 */
  workspace_path: string;
  target_ide?: TargetIde;
}

export interface BlueprintFile {
  path: string;
  /** created = 新建；replaced = 幂等替换标记区间 / 覆盖工具专属文件 */
  action: 'created' | 'replaced';
}

export type BlueprintOutcome =
  | { ok: true; files: BlueprintFile[]; instruction: string }
  | { ok: false; error: string };

const START_MARK = '<!-- STACKPILOT:START -->';
const END_MARK = '<!-- STACKPILOT:END -->';

const SLOTS: Array<[string, string]> = [
  ['fe', '前端'], ['be', '接口层'], ['db', '数据库'], ['ai', 'AI'], ['deploy', '部署'],
];

/** 技术栈清单。与 bootstrap.ts 的 renderStack 同源同序（组件槽位固定，避免两次生成顺序不同） */
function stackLines(combo: Combo): string[] {
  const out: string[] = [];
  for (const [slot, label] of SLOTS) {
    const id = (combo.components as Record<string, string | null>)[slot];
    if (!id) continue;
    const meta = COMPONENT_NAMES[id];
    out.push(`- **${label}**：${meta?.name ?? id}${meta?.role ? ` —— ${meta.role}` : ''}`);
  }
  return out;
}

/**
 * 架构契约正文。.mdc 与 CLAUDE.md 共用同一份 body——
 * 两个入口看到的约束必须一字不差，否则"AI 在哪个入口里"会改变行为。
 */
export function renderBlueprintBody(combo: Combo): string {
  const pits = combo.beginner_pitfalls ?? [];
  const parts: string[] = [];

  parts.push(`# StackPilot 架构契约：${combo.name}（${combo.id}）`);
  parts.push('');
  parts.push('> 本文件由 StackPilot MCP 的 `apply_stack_blueprint` 工具从闭集数据确定性生成，');
  parts.push('> 不是模型自由发挥的产物。重新运行工具会幂等更新本区块。');
  if ((combo as any).last_reviewed) {
    parts.push(`> 组合最近复核于 ${(combo as any).last_reviewed}。`);
  }
  parts.push('');

  parts.push('## 技术栈（已定，不可替换）');
  parts.push('');
  parts.push(...stackLines(combo));
  parts.push('');

  parts.push('## 明确禁止');
  parts.push('');
  parts.push('- 不要替换上述任何框架 / 服务，不要"顺手升级"架构（如把轻量存储换成数据库）。');
  parts.push('- 不要引入技术栈清单里没有的中间件（例如 Redis、Kafka、RabbitMQ、Elasticsearch）——确有需要时先停下来问我。');
  parts.push('- 不要自行添加微服务、消息队列、独立网关这类分层，这套方案是按当前规模选的最短路径。');
  parts.push('- **严禁引入需要 node-gyp 编译的原生依赖**（better-sqlite3、sqlite3、bcrypt 等）：数据层一律用纯 JS / WASM 实现（如 `@libsql/client`）。实测 36 轮跑批中，AI 自选原生模块的项目在 Windows 上编译全部失败。');
  parts.push('');

  // 「AI 生成纪律」：从 36 轮真实跑批（批次 2026-10-30-flash-v1）的失败日志提炼，
  // 每一条都对应一类实测翻车——这是"用实测数据喂给 AI 提示词"的部分，不是通用废话。
  parts.push('## AI 生成纪律（实测 36 轮跑批提炼）');
  parts.push('');
  parts.push('1. **每 import 一个新包，立刻写进 package.json 的 dependencies**——实测中 AI 用了 `openai` 却没声明依赖，build 阶段 `Module not found` 直接翻车。');
  parts.push('2. **文件路径一律用正斜杠 `/`**——混合反斜杠的路径在 Windows 上会生成错误目录结构（实测踩坑）。');
  parts.push('3. **文件保持最小可运行**——不要内嵌大段 SVG / 图标 / 示例数据，输出超限被截断的产物等于零（实测撞满输出上限）。');
  parts.push('4. **部署配置不要自己发明**——部署工件（vercel.json / wrangler.toml / docker-compose 等）由本项目骨架提供，实测 33 轮次中 AI 对它们的遗漏率是 100%。');
  parts.push('');

  parts.push('## 第一步（从这里开始，做完停下来说明改了什么）');
  parts.push('');
  parts.push(combo.first_step || '（该组合未定义第一步，先与我确认需求细节）');
  if (combo.first_step_minutes) parts.push(`（预计 ${combo.first_step_minutes} 分钟）`);
  parts.push('');

  if (pits.length) {
    parts.push('## 高频新手坑（写代码时逐条对照）');
    parts.push('');
    pits.forEach((p, i) => parts.push(`${i + 1}. ${p}`));
    parts.push('');
  }

  parts.push('## 协作方式');
  parts.push('');
  parts.push('- 一次只做一步，改完告诉我改了哪些文件、为什么这么改。');
  parts.push('- 遇到需要我提供 key、账号、域名的地方，先停下来问我，不要自己编一个。');
  parts.push('- 如果上面的技术栈和我的需求明显冲突，先指出来，不要硬做。');
  parts.push('');

  return parts.join('\n');
}

/** Cursor .mdc 的 frontmatter（globs 数组 + alwaysApply，按 Cursor rules 规范）。scaffold 也复用 */
export function renderMdc(combo: Combo): string {
  return [
    '---',
    'description: StackPilot Architecture Blueprint',
    'globs:',
    '  - "**/*"',
    'alwaysApply: true',
    '---',
    '',
    renderBlueprintBody(combo),
  ].join('\n');
}

/** CLAUDE.md 的标记区块（幂等替换的最小单元） */
export function renderClaudeBlock(combo: Combo): string {
  return `${START_MARK}\n${renderBlueprintBody(combo)}${END_MARK}`;
}

/**
 * 校验并写出文件。所有文件系统访问集中在这一个函数里，方便测试与审计。
 *
 * 路径安全：workspace_path 必须是绝对路径、已存在、且是目录；
 * 写入目标固定为该目录下的两个文件名，不接受任何来自调用方的文件名拼接。
 */
export function applyBlueprint(input: BlueprintInput, combos: Combo[]): BlueprintOutcome {
  const comboId = String(input.combo_id ?? '').trim().toUpperCase();
  const combo = combos.find((c) => c.id === comboId);
  if (!combo) {
    const ids = combos.map((c) => c.id).join(' / ');
    return { ok: false, error: `组合 ID「${comboId || '(空)'}」不在闭集里。可选值：${ids}` };
  }

  const ide: TargetIde = input.target_ide ?? 'both';
  if (!['cursor', 'claude_code', 'both'].includes(ide)) {
    return { ok: false, error: `target_ide 只能是 cursor / claude_code / both，收到「${ide}」` };
  }

  const ws = String(input.workspace_path ?? '').trim();
  if (!ws || !isAbsolute(ws)) {
    return { ok: false, error: `workspace_path 必须是本地绝对路径，收到「${ws || '(空)'}」` };
  }
  const wsAbs = resolve(ws);
  if (!existsSync(wsAbs)) {
    return { ok: false, error: `workspace_path 不存在：${wsAbs}。请先确认目标项目目录（不要新建空目录来糊弄）` };
  }
  let wsStat: { isDirectory: () => boolean; isFile: () => boolean };
  try {
    wsStat = statSync(wsAbs);
  } catch (e) {
    return { ok: false, error: `workspace_path 无法读取（${String((e as Error)?.message ?? e).slice(0, 120)}）：${wsAbs}` };
  }
  if (!wsStat.isDirectory()) {
    return { ok: false, error: `workspace_path 不是目录：${wsAbs}` };
  }

  const files: BlueprintFile[] = [];

  if (ide === 'cursor' || ide === 'both') {
    const rulesDir = join(wsAbs, '.cursor', 'rules');
    try {
      mkdirSync(rulesDir, { recursive: true });
      const mdcPath = join(rulesDir, 'stackpilot.mdc');
      const existed = existsSync(mdcPath);
      writeFileSync(mdcPath, renderMdc(combo), 'utf8');
      files.push({ path: mdcPath, action: existed ? 'replaced' : 'created' });
    } catch (e) {
      return { ok: false, error: `写入 .cursor/rules/stackpilot.mdc 失败：${String((e as Error)?.message ?? e).slice(0, 160)}` };
    }
  }

  if (ide === 'claude_code' || ide === 'both') {
    const claudePath = join(wsAbs, 'CLAUDE.md');
    try {
      const existing = existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : null;
      const block = renderClaudeBlock(combo);
      let next: string;
      let action: BlueprintFile['action'];
      if (existing === null) {
        next = `${block}\n`;
        action = 'created';
      } else if (existing.includes(START_MARK) && existing.includes(END_MARK)) {
        // 幂等替换：标记区间整体换成新内容，区间外一字不动
        const re = new RegExp(`${START_MARK}[\\s\\S]*?${END_MARK}`);
        next = existing.replace(re, block);
        action = 'replaced';
      } else {
        // 有文件但没有标记：追加，前置空行分隔，不动既有内容
        next = `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
        action = 'replaced';
      }
      writeFileSync(claudePath, next, 'utf8');
      files.push({ path: claudePath, action });
    } catch (e) {
      return { ok: false, error: `写入 CLAUDE.md 失败：${String((e as Error)?.message ?? e).slice(0, 160)}` };
    }
  }

  return {
    ok: true,
    files,
    instruction:
      '架构规范已写入项目规则文件。现在请严格按照其中的『第一步』开始带用户实操：' +
      '一次只做一步，做完停下来说明改了哪些文件；遇到需要 key / 账号 / 域名的地方先停下来问用户。' +
      '写代码时逐条对照文件里的「高频新手坑」；技术栈与用户需求明显冲突时先指出，不要硬做。',
  };
}
