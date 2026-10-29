/**
 * scaffold_blueprint 的核心逻辑（v2.1.0）：把骨架落盘为可运行项目 + 写入架构契约。
 * ------------------------------------------------------------------
 * 【安全红线】workspace_path 必须是**不存在的路径**（创建）或**已存在且为空的目录**。
 * 任何非空目录一律拒绝——脚手架永远不覆盖用户文件。这是与 apply_stack_blueprint
 * （幂等更新既有项目）互补的写入策略：前者从零创建，后者只动标记区间。
 *
 * 落盘内容 = 拼装器文件树 + 架构契约（.cursor/rules/stackpilot.mdc + CLAUDE.md）。
 * 一个动作完成"从零到 AI 可接手"：AI 打开项目就看到技术栈、禁止事项、第一步、坑点。
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { Combo } from '../src/lib/scoring.ts';
import { buildScaffoldPlan } from '../src/lib/scaffold.ts';
import { renderClaudeBlock, renderMdc } from './blueprint.ts';

export interface ScaffoldInput {
  combo_id: string;
  workspace_path: string;
  target_ide?: 'cursor' | 'claude_code' | 'both';
}

export type ScaffoldOutcome =
  | { ok: true; root: string; fileCount: number; nextStep: string; instruction: string }
  | { ok: false; error: string };

function hasMeaningfulFiles(dir: string): boolean {
  return readdirSync(dir).length > 0;
}

export function scaffoldBlueprint(input: ScaffoldInput, combos: Combo[]): ScaffoldOutcome {
  const comboId = String(input.combo_id ?? '').trim().toUpperCase();
  const combo = combos.find((c) => c.id === comboId);
  if (!combo) {
    return { ok: false, error: `组合 ID「${comboId || '(空)'}」不在闭集里。可选值：${combos.map((c) => c.id).join(' / ')}` };
  }
  const ide = input.target_ide ?? 'both';
  if (!['cursor', 'claude_code', 'both'].includes(ide)) {
    return { ok: false, error: `target_ide 只能是 cursor / claude_code / both，收到「${String(ide)}」` };
  }

  const ws = String(input.workspace_path ?? '').trim();
  if (!ws || !isAbsolute(ws)) {
    return { ok: false, error: `workspace_path 必须是本地绝对路径，收到「${ws || '(空)'}」` };
  }
  const root = resolve(ws);
  if (existsSync(root)) {
    let st: { isDirectory: () => boolean };
    try {
      st = statSync(root);
    } catch (e) {
      return { ok: false, error: `workspace_path 无法读取：${String((e as Error)?.message ?? e).slice(0, 120)}` };
    }
    if (!st.isDirectory()) return { ok: false, error: `workspace_path 已存在且不是目录：${root}` };
    if (hasMeaningfulFiles(root)) {
      return {
        ok: false,
        error:
          `目录非空，拒绝写入（脚手架永不覆盖用户文件）：${root}\n` +
          '要往已有项目里写架构规范，请改用 apply_stack_blueprint（幂等更新规则文件，不碰其他文件）。',
      };
    }
  } else {
    try {
      mkdirSync(root, { recursive: true });
    } catch (e) {
      return { ok: false, error: `无法创建目录：${String((e as Error)?.message ?? e).slice(0, 120)}` };
    }
  }

  // ── 落盘骨架 ──
  let plan;
  try {
    plan = buildScaffoldPlan(combo);
  } catch (e) {
    return { ok: false, error: `拼装失败：${String((e as Error)?.message ?? e)}` };
  }
  try {
    for (const f of plan.files) {
      const target = join(root, f.path);
      mkdirSync(target.slice(0, target.lastIndexOf('/')) || root, { recursive: true });
      writeFileSync(target, f.content, 'utf8');
    }
  } catch (e) {
    return { ok: false, error: `写骨架文件失败：${String((e as Error)?.message ?? e).slice(0, 160)}` };
  }

  // ── 落盘架构契约（与 apply_stack_blueprint 同一份渲染，AI 打开项目即见约束）──
  try {
    if (ide === 'cursor' || ide === 'both') {
      const rulesDir = join(root, '.cursor', 'rules');
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(join(rulesDir, 'stackpilot.mdc'), renderMdc(combo), 'utf8');
    }
    if (ide === 'claude_code' || ide === 'both') {
      writeFileSync(join(root, 'CLAUDE.md'), renderClaudeBlock(combo) + '\n', 'utf8');
    }
  } catch (e) {
    return { ok: false, error: `写架构契约失败：${String((e as Error)?.message ?? e).slice(0, 160)}` };
  }

  const hasPy = plan.files.some((f) => f.path.endsWith('requirements.txt'));
  const nextStep =
    combo.first_step ??
    (hasPy ? '在 server/ 里 `pip install -r requirements.txt` 后 `uvicorn main:app --reload`' : '安装依赖并启动开发服务');
  const installHint = hasPy
    ? 'Python 侧：`cd server && python -m venv .venv && pip install -r requirements.txt`'
    : '`npm install` 安装依赖（版本已按 facts 快照锁定）';

  return {
    ok: true,
    root,
    fileCount: plan.files.length + (ide !== 'claude_code' ? 1 : 0) + (ide !== 'cursor' ? 1 : 0),
    nextStep,
    instruction:
      `骨架已写入 ${root}（${plan.files.length} 个文件，版本按 facts 快照锁定）。\n` +
      `先执行 ${installHint}，然后严格按『第一步』带用户实操：${nextStep}。\n` +
      '架构契约已写入项目规则文件，AI 在该项目中会自动遵守技术栈与禁止事项；写代码时逐条对照「高频新手坑」。',
  };
}
