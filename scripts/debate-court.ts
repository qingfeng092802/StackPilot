/**
 * 多 Agent 对抗法庭（v2.2.0）——「顺从性偏见」的解药，离线跑。
 * ------------------------------------------------------------------
 * docs/ROADMAP-v2.2-debate.md 第三节。三阶段：
 *
 *   Phase 1  独立深挖（禁止通信）：3 个代言人分别从「框架 / 数据层 / 开发体验与部署」
 *            维度找真优点；红队专找致命缺陷（要求指向具体机制，禁止"注意性能"式废话）；
 *            集成评估师**真实接入 npm registry 公开 API**查依赖的 deprecated / peerDeps /
 *            dist-tags——这个角色是真数据源，不依赖 key。
 *   Phase 2  法庭辩论（mailbox）：5 份报告互相分发，每个角色看到其他 4 份，
 *            1 轮反驳/再挑刺——正方必须正面回应红队，红队可以不接受。
 *   Phase 3  Lead 裁决：不参与辩论，综合全部记录，输出 ai_friendliness 建议、
 *            red_team_warnings 草案、plan_b 草案。
 *
 * 【红线】产出物一律进 src/data/candidates-pending/debate-results.json，
 * **人工复核后才写入 combos.json**——运行时绝不动态改闭集。
 * 产出 provenance 里记 model / registry 快照 / 各角色延迟，全程可溯源。
 *
 * 用法：
 *   npx tsx scripts/debate-court.ts --combo C01 [--model deepseek-flash] [--mock] [--rounds 1]
 *   --mock：全角色脚本化（确定性、无 key、无网络），验证管道本身。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import combosRaw from '../src/data/combos.json' with { type: 'json' };
import { AnthropicProvider, type LLMProvider } from '../src/lib/explain/provider.ts';
import type { Combo } from '../src/lib/scoring.ts';

const combos = (combosRaw as any).combos as Combo[];

// ── 参数 ──
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const hasFlag = (name: string) => args.includes('--' + name);
const comboId = (opt('combo') ?? 'C01').toUpperCase();
const model = opt('model') ?? process.env.ANTHROPIC_MODEL ?? 'deepseek-flash';
const mailboxRounds = Math.max(1, Math.min(2, Number(opt('rounds') ?? 1)));
const isMock = hasFlag('mock');

const combo = combos.find((c) => c.id === comboId);
if (!combo) {
  console.error(`组合 ${comboId} 不在闭集里。可选：${combos.map((c) => c.id).join(' / ')}`);
  process.exit(1);
}

// ── 角色定义 ──
const COMPS = combo.components as Record<string, string | null>;
const compList = Object.entries(COMPS).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ');
const REGISTRY_RE = /^https?:\/\/registry\.npmjs\.org\//;

const ROLES: Array<{ id: string; label: string; system: string; dependsOnKey: boolean }> = [
  {
    id: 'proponent_framework',
    label: '代言人·框架维度',
    system:
      '你是技术方案的代言人，负责为指定组合的**前端框架**找真实成立的优点。规则：优点必须指向具体机制（路由约定、生态、类型系统），禁止空泛形容词（"高效""强大"）；你必须找真优点而不是奉承——找到一个站不住的"优点"就是失职。',
    dependsOnKey: true,
  },
  {
    id: 'proponent_data',
    label: '代言人·数据与后端维度',
    system:
      '你是技术方案的代言人，负责为指定组合的**数据层与后端**找真实成立的优点。规则同上：指向具体机制，禁止空泛形容词。若该组合无数据库层，就为"无数据库"这个决策本身辩护（它省掉了什么）。',
    dependsOnKey: true,
  },
  {
    id: 'proponent_devex',
    label: '代言人·开发体验与部署',
    system:
      '你是技术方案的代言人，负责为指定组合的**开发体验与部署**找真实成立的优点（工具链、部署路径、运维负担）。规则同上。',
    dependsOnKey: true,
  },
  {
    id: 'red_team',
    label: '红队·反一切',
    system:
      '你是红队，唯一任务是找出这套方案的**致命缺陷与隐藏成本**。规则：每条警告必须指向具体机制（平台锁定、运行时限制、语料断层、合规边界），禁止"需要注意性能"式废话；禁止编造数字门槛（如"冷启动 1.5s"）——没把握的数字一律定性描述；不许客气，但每条都必须是**真的**。',
    dependsOnKey: true,
  },
  {
    id: 'integrator',
    label: '集成评估师·npm registry',
    system: '',
    dependsOnKey: false,
  },
];

/** Phase 1 各角色的独立输入（integrator 走 registry，不走 LLM） */
function phase1Prompt(roleId: string): string {
  return [
    `待评估组合：${combo!.id} ${combo!.name}（组件：${compList}）`,
    `组合声明的能力边界：${(combo!.beginner_pitfalls ?? []).join('；')}`,
    '',
    roleId === 'red_team'
      ? '输出 JSON：{"warnings": ["警告1", "警告2", "警告3"]}。2-4 条，每条 20-80 字，指向具体机制。'
      : '输出 JSON：{"argument": "一段 40-90 字的辩护，指向具体机制"}。只为你负责的维度辩护。',
  ].join('\n');
}

async function llmPhase(provider: LLMProvider, roleId: string, extra: string): Promise<any> {
  const role = ROLES.find((r) => r.id === roleId)!;
  const user = [phase1Prompt(roleId), extra, '只输出 JSON，不要代码围栏，不要解释。'].filter(Boolean).join('\n\n');
  const res = await provider.complete({ system: role.system, user });
  const t = res.text;
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  return JSON.parse(t.slice(start, end + 1));
}

/** 集成评估师：真实接 npm registry（无需 key）。失败降级为 fail_reason，与 facts 快照同一哲学 */
async function integratorRegistry(): Promise<{ reports: Array<{ package: string; data: any; fail_reason?: string }>; summary: string }> {
  const planPkgs = new Set<string>();
  // 从组合的 evidence 快照取该组合用到的 npm 包（与 facts 同源）
  const facts = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'src', 'data', 'facts-snapshot.json'), 'utf8'));
  for (const r of facts.records) {
    if (r.ecosystem === 'npm' && combo!.components && JSON.stringify(combo!.components).includes(r.entry_id)) {
      planPkgs.add(r.package);
    }
  }
  const reports: Array<{ package: string; data: any; fail_reason?: string }> = [];
  for (const pkg of [...planPkgs].sort()) {
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, {
        signal: AbortSignal.timeout(15000),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        reports.push({ package: pkg, data: null, fail_reason: `HTTP ${res.status}` });
        continue;
      }
      const j: any = await res.json();
      reports.push({
        package: pkg,
        data: {
          version: j.version,
          deprecated: j.deprecated ?? null,
          peerDependencies: j.peerDependencies ?? {},
          engines: j.engines ?? null,
        },
      });
    } catch (e) {
      reports.push({ package: pkg, data: null, fail_reason: String((e as Error)?.message ?? e).slice(0, 120) });
    }
  }
  const bad = reports.filter((r) => r.fail_reason);
  const deprecated = reports.filter((r) => r.data?.deprecated);
  const summary = [
    `registry 检查 ${reports.length} 个包：成功 ${reports.length - bad.length}，失败 ${bad.length}`,
    deprecated.length ? `；deprecated：${deprecated.map((d) => d.package).join('、')}` : '；无 deprecated',
  ].join('');
  return { reports, summary };
}

/** --mock：全角色脚本化，确定性输出（验证管道，不代表任何模型能力） */
function mockPhase1(roleId: string): any {
  if (roleId === 'red_team') {
    return { warnings: ['[mock] 平台锁定风险：SSR 与托管平台深度绑定，私有化需要重接运行时。', '[mock] 免费档服务有休眠语义，演示首屏可能遭遇冷启动延迟。'] };
  }
  return { argument: `[mock] ${roleId} 维度的辩护：该组合在其维度上有具体机制层面的优势，此处为管道验证用的脚本化输出。` };
}

function mockMailbox(roleId: string, round: number): any {
  return roleId === 'red_team'
    ? { warnings: [`[mock] 第 ${round} 轮再挑刺：正方的规避方案本身有成本，且未回答部署语义的变化。`] }
    : { rebuttal: `[mock] 第 ${round} 轮反驳：红队指出的问题在目标场景下可控，理由指向具体机制（管道验证输出）。` };
}

// ── 主流程 ──
const provider = new AnthropicProvider({ model });
if (!isMock && !hasFlag('integrator-only') && !provider.available()) {
  console.error('没有可用的模型凭据（P0-1b）：用 --mock 验证管道、--integrator-only 只跑 registry 检查，或配置 ANTHROPIC_API_KEY。');
  process.exit(1);
}
const llm = isMock ? null : provider;

// --integrator-only：只跑 npm registry 真实检查（不依赖 key，key 到位前唯一可真跑的部分）
if (hasFlag('integrator-only')) {
  const registry = await integratorRegistry();
  console.log(`[integrator-only] ${registry.summary}`);
  for (const r of registry.reports) {
    console.log(`  ${r.package}: ${r.fail_reason ? `FAIL ${r.fail_reason}` : `v${r.data.version}${r.data.deprecated ? ' ⚠️ DEPRECATED' : ''} peer={${Object.keys(r.data.peerDependencies ?? {}).join(', ')}}`}`);
  }
  const outDir = resolve(import.meta.dirname, '..', 'src', 'data', 'candidates-pending');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'debate-results.json');
  let all: any = { generated_note: '多 Agent 法庭产出，人工复核后才可写入 combos.json（author 改为 debate-court@<批次>）', combos: {} };
  if (existsSync(outFile)) all = JSON.parse(readFileSync(outFile, 'utf8'));
  all.combos = all.combos ?? {};
  all.combos[comboId] = { ...(all.combos[comboId] ?? {}), registry_evidence_only: { generated_at: new Date().toISOString(), reports: registry.reports } };
  writeFileSync(outFile, JSON.stringify(all, null, 2) + '\n');
  process.exit(0);
}

const t0 = Date.now();
console.log(`法庭开庭：${combo!.id} ${combo!.name} · ${isMock ? 'mock' : model} · mailbox ${mailboxRounds} 轮`);

// ── Phase 1：独立深挖，禁止通信 ──
const phase1: Record<string, any> = {};
await Promise.all(
  ROLES.map(async (r) => {
    if (r.id === 'integrator') return; // registry 单独跑
    phase1[r.id] = isMock ? mockPhase1(r.id) : await llmPhase(llm!, r.id, '');
  }),
);
const registry = isMock
  ? { reports: [{ package: '[mock]', data: { deprecated: null, peerDependencies: {} } }], summary: '[mock] registry 检查通过' }
  : await integratorRegistry();
phase1.integrator = { summary: registry.summary };
console.log(`Phase 1 完成：${Object.keys(phase1).length} 份独立报告（integrator：${registry.summary.slice(0, 60)}…）`);

// ── Phase 2：mailbox 辩论 ──
const mailbox: Array<{ round: number; role: string; payload: any }> = [];
const digest = () =>
  ROLES.map((r) => `【${r.label}】${JSON.stringify(phase1[r.id] ?? mailbox.filter((m) => m.role === r.id).at(-1)?.payload ?? {})}`).join('\n\n');

for (let round = 1; round <= mailboxRounds; round++) {
  const others = digest();
  await Promise.all(
    ROLES.filter((r) => r.id !== 'integrator').map(async (r) => {
      const payload = isMock
        ? mockMailbox(r.id, round)
        : await llmPhase(llm!, r.id, `其他角色的报告如下，请针对性回应：红队必须评估正方的规避方案是否成立；正方必须正面回应红队的每一条。\n\n${others}`);
      mailbox.push({ round, role: r.id, payload });
    }),
  );
}
console.log(`Phase 2 完成：${mailbox.length} 份mailbox 发言`);

// ── Phase 3：Lead 裁决 ──
const fullRecord = JSON.stringify({ phase1, mailbox }, null, 0);
let verdict: any;
if (isMock) {
  verdict = {
    ai_friendliness_suggested: combo!.base_scores.ai_friendliness,
    red_team_warnings: ['[mock] 来自法庭裁决的警告一：平台锁定类风险，触发条件见 plan_b。', '[mock] 警告二：运行时语义限制，定性描述。'],
    plan_b: combo!.debate?.plan_b ?? { trigger: '[mock] 触发条件占位', alternative_combo: 'C12' },
    notes: '[mock] 裁决为管道验证输出，ai_friendliness 建议直接沿用现值。',
  };
} else {
  const leadSystem =
    '你是 Lead 法官，不参与辩论，只综合辩论记录做裁决。规则：裁决里的每句话都必须能追溯到辩论记录；' +
    '不许引入记录之外的新事实；不许和稀泥——如果红队的警告成立，就如实采纳为 warnings。';
  const leadPrompt = [
    `组合：${combo!.id} ${combo!.name}`,
    '完整辩论记录：',
    fullRecord.slice(0, 24000),
    '',
    '输出 JSON：{"ai_friendliness_suggested": 1-5 的整数, "red_team_warnings": ["……"], "plan_b": {"trigger": "……", "alternative_combo": "CXX（必须从闭集选）"}, "notes": "裁决理由 60 字内"}',
    `可选的 alternative_combo：${combos.map((c) => c.id).join(' / ')}`,
  ].join('\n');
  const res = await llm!.complete({ system: leadSystem, user: leadPrompt });
  const t = res.text;
  verdict = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
}
console.log(`Phase 3 完成：裁决 ai_friendliness 建议 = ${verdict.ai_friendliness_suggested}`);

// ── 落盘（人工复核材料，绝不自动写回 combos.json）──
const outDir = resolve(import.meta.dirname, '..', 'src', 'data', 'candidates-pending');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'debate-results.json');
let all: any = { generated_note: '多 Agent 法庭产出，人工复核后才可写入 combos.json（author 改为 debate-court@<批次>）', combos: {} };
if (existsSync(outFile)) all = JSON.parse(readFileSync(outFile, 'utf8'));
all.combos = all.combos ?? {};
all.combos[comboId] = {
  generated_at: new Date().toISOString(),
  model: isMock ? 'mock' : model,
  rounds: mailboxRounds,
  latency_ms: Date.now() - t0,
  phase1,
  registry_evidence: registry.reports,
  mailbox,
  verdict,
};
writeFileSync(outFile, JSON.stringify(all, null, 2) + '\n');
console.log(`\n裁决已写入 ${outFile}（${isMock ? 'mock' : model}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
console.log('下一步：人工复核 verdict，通过后把 author 改为 debate-court@<批次> 并合入 combos.json。');
