/**
 * 本地匿名反馈（v2.1.0）—— 零隐私版本的使用信号收集。
 * ------------------------------------------------------------------
 * 【默认关闭】只有 SP_TELEMETRY=1 时才写文件。绝不联网、绝不采集原文与路径。
 *
 * 【写哪里】~/.stackpilot/usage.jsonl（用户主目录，跨项目汇总）。
 * 刻意不放项目 out/——那里在 .gitignore 里但属于"项目产物"，混在一起容易被误提交；
 * 用户主目录天然在仓库外，删文件即撤回全部数据。
 *
 * 【事件白名单】只有结构化枚举字段与计数，没有任何自由文本：
 *   timestamp / mode / ok / confidence / top1_id / candidate_count /
 *   blocked_reason / adopted_fields / missing_fields
 */

import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface UsageEvent {
  mode: 'host' | 'llm' | 'rule';
  ok: boolean;
  confidence: string;
  top1_id: string | null;
  candidate_count: number;
  blocked_reason: string | null;
  adopted_fields: number;
  missing_fields: number;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB 滚动上限，超过就停写（避免无限膨胀）

export function telemetryEnabled(): boolean {
  return process.env.SP_TELEMETRY === '1';
}

export function recordOutcome(e: UsageEvent): void {
  if (!telemetryEnabled()) return;
  try {
    const dir = join(homedir(), '.stackpilot');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, 'usage.jsonl');
    if (existsSync(file) && statSync(file).size > MAX_FILE_BYTES) return;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...e });
    appendFileSync(file, line + '\n', 'utf8');
  } catch {
    // 遥测是锦上添花，任何失败静默吞掉——绝不能影响工具主链路
  }
}
