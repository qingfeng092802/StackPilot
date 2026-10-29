/**
 * 离线参数化生成器（v2.1.0，ROADMAP 第三节·资产 B）
 * ------------------------------------------------------------------
 * 用"有限组件枚举 + 排除规则"生成**候选**组合清单，供人工评审入库。
 *
 * 【刻意不做的事】
 *   - 运行时动态生成组合：会破坏"同一输入同一输出"与 D1 基线可比性；
 *   - 自动入库：候选必须过人工评审 + 补 evidence + 盲标扩展才进 combos.json；
 *   - 无上限枚举：候选池上限 20（含现有 12），超过即停——组合太多会稀释
 *     "12 套闭集"的选型价值（对用户来说池子越大越难选）。
 *
 * 排除规则来自已有的语义（combos.json 的 hard_exclude_when 与 confidence.ts 的
 * COVERED/UNCOVERED_DELIVERIES），不发明新规则。
 *
 * 用法：npx tsx scripts/gen-candidates.ts
 * 产物：out/candidates-for-review.json（人工评审材料，不是数据）
 */

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMPONENT_NAMES } from '../src/data/component-names.ts';

const FE = ['FE-01', 'FE-02', 'FE-03', 'FE-04', 'FE-05', 'FE-06'];
const BE = [null, 'BE-01', 'BE-02', 'BE-03', 'BE-04', 'BE-06'];
const DB = [null, 'DB-01', 'DB-02'];
const AI = [null, 'AI-01', 'AI-02', 'AI-03', 'AI-04'];
const DP = ['DP-01', 'DP-02', 'DP-03'];

const combosRaw = JSON.parse((await import('node:fs')).readFileSync(new URL('../src/data/combos.json', import.meta.url), 'utf8'));
const existing = new Set(combosRaw.combos.map((c: any) => [c.components.fe, c.components.be, c.components.db, c.components.ai, c.components.deploy].join('|')));
const MAX_TOTAL = 20;

/** 排除规则：与现有组合的 hard_exclude 语义一致（小程序系无法跨端、同进程约束） */
function viable(fe: string, be: string | null, db: string | null, ai: string | null, dp: string): string | null {
  // 小程序系前端只配托管后端（原生容器里没有自建服务进程）
  if ((fe === 'FE-05' || fe === 'FE-06') && be && be !== 'BE-06') return '小程序系前端只能配 BE-06 托管后端';
  // Route Handlers 与 FE-01/FE-03 同进程（Next/SvelteKit），配其他 FE 无意义
  if (be === 'BE-01' && fe !== 'FE-01' && fe !== 'FE-03') return 'BE-01 只能与 FE-01/FE-03 同进程';
  // 小程序不接独立后端
  if ((fe === 'FE-05' || fe === 'FE-06') && be && ['BE-02', 'BE-03', 'BE-04'].includes(be)) return '小程序容器内没有自建服务进程';
  // 重编排（LangGraph）配纯静态/小程序没有服务端落点
  if (ai === 'AI-02' && (fe === 'FE-05' || fe === 'FE-06')) return 'Agent 重编排需要服务端运行时';
  if (ai === 'AI-02' && be === null) return 'AI-02 需要后端承载';
  return null;
}

const candidates: Array<Record<string, unknown>> = [];
for (const fe of FE) {
  for (const be of BE) {
    for (const db of DB) {
      for (const ai of AI) {
        for (const dp of DP) {
          const key = [fe, be, db, ai, dp].join('|');
          if (existing.has(key)) continue; // 已有组合
          const reason = viable(fe, be, db, ai, dp);
          if (reason) continue;
          if (candidates.length >= MAX_TOTAL - existing.size) break;
          candidates.push({
            proposed_id: `C${String(13 + candidates.length).padStart(2, '0')}`,
            components: { fe, be, db, ai, deploy: dp },
            name_draft: [fe, be, db].filter(Boolean).map((id) => (COMPONENT_NAMES as any)[id!]?.name ?? id).join(' + '),
            status: '待人工评审',
            // 入库前必须补齐（ROADMAP 验收断言）：
            required_before_merge: [
              'one_liner / first_step / beginner_pitfalls（真实可执行，非模板话术）',
              'base_scores 六维（含 ai_friendliness，须注明判断依据）',
              'fit_rules 与 hard_exclude_when（用现有 DSL）',
              'evidence.official_docs（官方文档 URL）',
              'last_reviewed（人工审核日期）',
              '同步扩展 tests/d1-holdout.json 盲标集（保持跨版本可比）',
            ],
          });
        }
      }
    }
  }
}

const out = {
  generated_at: new Date().toISOString(),
  note: '离线枚举候选，仅供人工评审。按 ROADMAP 约定：评审通过才进 combos.json，同一 PR 必须带 holdout 扩展。',
  current_total: existing.size,
  max_total: MAX_TOTAL,
  candidates,
};
const outPath = resolve(import.meta.dirname, '..', 'out', 'candidates-for-review.json');
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`候选生成完成：现有 ${existing.size} 套，上限 ${MAX_TOTAL}，产出候选 ${candidates.length} 套 → ${outPath}`);
for (const c of candidates) console.log(`  ${c.proposed_id}：${c.name_draft}`);
