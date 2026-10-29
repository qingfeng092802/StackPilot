/**
 * 骨架拼装器（v2.1.0）—— 骨架资产的确定性组装。
 * ------------------------------------------------------------------
 * 23 组件片段（scaffold-parts）→ 12 套组合骨架。全部纯函数：
 * 同一组合两次拼装逐字节一致（test-scaffold.ts 钉死）。
 *
 * 【布局规则】
 *   BE-01（Route Handlers）与 FE 同进程            → mount '.'
 *   BE-02/03/04（独立后端）                        → FE mount 'client/'，BE mount 'server/'
 *   BE-06（Supabase 托管）/ DB / AI / DP            → mount '.'
 *   FE-05/FE-06（小程序系，与 BE-06 同用）          → mount '.'
 *
 * 【版本溯源】npm 依赖版本从 facts-snapshot.json 按 entry_id 取；
 * 快照没有的（peer/运行时配套）用片段里的 version 并标 peer-estimate。
 * 全部溯源状态写入 .stackpilot/build-info.json，inspect 与测试据此断言。
 */

import type { Combo } from './scoring.ts';
import { SCAFFOLD_PARTS, GITIGNORE, README_TMPL, type ScaffoldDep } from '../data/scaffold-parts/index.ts';
import factsRaw from '../data/facts-snapshot.json' with { type: 'json' };

const facts = factsRaw as any;

export interface ScaffoldFile {
  path: string;
  content: string;
}

export interface DepProvenance {
  package: string;
  version: string;
  /** facts-snapshot = 精确锁定；peer-estimate = 快照无条目的运行时配套 */
  source: 'facts-snapshot' | 'peer-estimate';
  /** facts 快照的 verified_at，source=facts-snapshot 时有值 */
  verified_at?: string;
  note?: string;
}

export interface ScaffoldPlan {
  comboId: string;
  comboName: string;
  lastReviewed: string;
  files: ScaffoldFile[];
  /** 每个依赖的溯源状态（inspect_project 的偏离基线也从这里出） */
  provenance: DepProvenance[];
  /** 组件清单（组合声明过的），inspect 用它做命中判定 */
  components: string[];
  warnings: string[];
}

function factVersion(entryId: string, pkg: string): { version: string; verified_at: string } | null {
  const rec = (facts.records as any[]).find((r) => r.entry_id === entryId && r.package === pkg && r.ecosystem === 'npm');
  if (!rec?.version) return null;
  return { version: rec.version, verified_at: rec.verified_at };
}

function factPyVersion(entryId: string, pkg: string): { version: string; verified_at: string } | null {
  const rec = (facts.records as any[]).find((r) => r.entry_id === entryId && r.package === pkg && r.ecosystem === 'pypi');
  if (!rec?.version) return null;
  return { version: rec.version, verified_at: rec.verified_at };
}

/** 独立后端（单独 mount server/）的组件集合 */
const STANDALONE_BE = new Set(['BE-02', 'BE-03', 'BE-04']);

/** FE 项目的 package.json scripts（按 FE 组件定） */
const FE_SCRIPTS: Record<string, Record<string, string>> = {
  'FE-01': { dev: 'next dev', build: 'next build', start: 'next start' },
  'FE-02': { dev: 'nuxt dev', build: 'nuxt build', start: 'nuxt preview' },
  'FE-03': { dev: 'vite dev', build: 'vite build', preview: 'vite preview' },
  'FE-04': { dev: 'vite', build: 'vite build', preview: 'vite preview' },
};

function feMountOf(combo: Combo): string {
  return combo.components.be && STANDALONE_BE.has(combo.components.be) ? 'client' : '.';
}
function beMountOf(combo: Combo): string | null {
  const be = combo.components.be;
  if (!be) return null;
  return STANDALONE_BE.has(be) ? 'server' : '.';
}

function mergeDeps(parts: Array<{ part: ScaffoldPart; mount: string }>) {
  // key: `${mount}|${package}` —— 不同目录的 package.json 互相独立
  const byMount = new Map<string, { deps: Map<string, string>; devDeps: Map<string, string>; provenance: DepProvenance[]; warnings: string[] }>();
  const get = (mount: string) => {
    let e = byMount.get(mount);
    if (!e) {
      e = { deps: new Map(), devDeps: new Map(), provenance: [], warnings: [] };
      byMount.set(mount, e);
    }
    return e;
  };

  for (const { part, mount } of parts) {
    const e = get(mount);
    for (const d of part.deps ?? []) {
      const entry = resolveDep(d, e.warnings);
      if (entry.version === null) continue;
      (d.dev ? e.devDeps : e.deps).set(d.package, entry.version);
      e.provenance.push(entry.prov);
    }
  }
  return byMount;
}

function resolveDep(d: ScaffoldDep, warnings: string[]): { version: string | null; prov: DepProvenance } {
  if (d.version_from) {
    const f = factVersion(d.version_from, d.package);
    if (f) {
      return {
        version: f.version,
        prov: { package: d.package, version: f.version, source: 'facts-snapshot', verified_at: f.verified_at, note: d.peer_note },
      };
    }
    warnings.push(`${d.package}（${d.version_from}）在 facts 快照里没有版本，已跳过——请先跑 scripts/build-facts.ts 更新快照`);
    return { version: null, prov: { package: d.package, version: 'MISSING', source: 'peer-estimate', note: 'facts 缺条目' } };
  }
  return {
    version: d.version ?? '',
    prov: { package: d.package, version: d.version ?? '', source: 'peer-estimate', note: d.peer_note },
  };
}

export function buildScaffoldPlan(combo: Combo): ScaffoldPlan {
  const warnings: string[] = [];
  const comps = Object.values(combo.components).filter((v): v is string => Boolean(v));
  const missing = comps.filter((c) => !SCAFFOLD_PARTS[c]);
  if (missing.length) throw new Error(`组合 ${combo.id} 引用了没有片段的组件：${missing.join(', ')}`);

  const feMount = feMountOf(combo);
  const beMount = beMountOf(combo);

  const parts = comps.map((id) => {
    const part = SCAFFOLD_PARTS[id];
    // FE-05/FE-06 与 BE-06/DB/AI/DP 同根；独立 BE 才分 client/server
    let mount = '.';
    if (id.startsWith('FE-') && feMount === 'client') mount = 'client';
    if (id.startsWith('BE-') && beMount === 'server') mount = 'server';
    return { part, mount };
  });

  const files: Map<string, string> = new Map();
  const put = (path: string, content: string) => {
    if (files.has(path)) warnings.push(`文件冲突被覆盖：${path}`);
    files.set(path, content);
  };

  // ── 1. 按 mount 生成 package.json ──
  const byMount = mergeDeps(parts);
  for (const [mount, e] of byMount) {
    const feId = comps.find((c) => c.startsWith('FE-'));
    const isFeMount = mount === feMount;
    const scripts = isFeMount && feId ? (FE_SCRIPTS[feId] ?? {}) : { build: 'tsc' };
    const pkg = {
      name: mount === 'server' ? 'stackpilot-server' : 'stackpilot-app',
      private: true,
      type: 'module',
      scripts,
      dependencies: Object.fromEntries([...e.deps].sort()),
      devDependencies: Object.fromEntries([...e.devDeps].sort()),
    };
    const base = mount === '.' ? '' : mount + '/';
    put(base + 'package.json', JSON.stringify(pkg, null, 2) + '\n');
  }

  // ── 2. 片段文件（挂到各自 mount）──
  for (const { part, mount } of parts) {
    const base = mount === '.' ? '' : mount + '/';
    for (const [p, content] of Object.entries(part.files)) {
      put(base + p, content);
    }
  }

  // ── 3. pypi：requirements.txt（按含 pyDeps 的片段生成到其 mount）──
  for (const { part, mount } of parts) {
    if (!part.pyDeps?.length) continue;
    const base = mount === '.' ? '' : mount + '/';
    const lines: string[] = [];
    for (const d of part.pyDeps) {
      if (d.version_from) {
        const f = factPyVersion(d.version_from, d.package);
        if (f) {
          lines.push(`${d.package}==${f.version}`);
          byMount.get(mount)?.provenance.push({ package: d.package, version: f.version, source: 'facts-snapshot', verified_at: f.verified_at });
          continue;
        }
        warnings.push(`${d.package}（pypi ${d.version_from}）在 facts 快照里没有版本，requirements 里省略`);
        continue;
      }
      lines.push(`${d.package}==${d.version}`);
      byMount.get(mount)?.provenance.push({ package: d.package, version: d.version ?? '', source: 'peer-estimate', note: d.peer_note });
    }
    put(base + 'requirements.txt', lines.sort().join('\n') + '\n');
  }

  // ── 4. 统一注入：.gitignore / .env.example / README / build-info ──
  put('.gitignore', GITIGNORE);
  const envLines = [...new Set(parts.flatMap(({ part }) => part.env ?? []))];
  if (envLines.length) put('.env.example', envLines.join('\n') + '\n');
  const pitfalls = (combo.beginner_pitfalls ?? []).map((p, i) => `${i + 1}. ${p}`).join('\n');
  put(
    'README.md',
    README_TMPL.replace('{{NAME}}', combo.name)
      .replace('{{ID}}', combo.id)
      .replace('{{REVIEWED}}', (combo as any).last_reviewed ?? '（未登记）')
      .replace('{{STEP}}', combo.first_step ?? '（未定义）')
      .replace('{{PITFALLS}}', pitfalls),
  );

  const allProvenance = [...byMount.values()].flatMap((e) => e.provenance).sort((a, b) => a.package.localeCompare(b.package));
  put(
    '.stackpilot/build-info.json',
    JSON.stringify(
      {
        generated_by: 'stackpilot-scaffold',
        combo_id: combo.id,
        combo_name: combo.name,
        last_reviewed: (combo as any).last_reviewed ?? null,
        facts_snapshot_generated_at: facts.generated_at,
        components: comps,
        dependencies: allProvenance,
      },
      null,
      2,
    ) + '\n',
  );

  const ordered = [...files.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([path, content]) => ({ path, content }));

  return {
    comboId: combo.id,
    comboName: combo.name,
    lastReviewed: (combo as any).last_reviewed ?? '',
    files: ordered,
    provenance: allProvenance,
    components: comps,
    warnings,
  };
}

/**
 * inspect_project 的基线：某组合"应该出现"的 npm 包集合（含 dev）。
 * 与拼装器同源——骨架长什么样，反查就按什么算偏离。
 */
export function baselinePackagesOf(combo: Combo): Map<string, { version: string; source: string }> {
  const plan = buildScaffoldPlan(combo);
  const m = new Map<string, { version: string; source: string }>();
  for (const p of plan.provenance) m.set(p.package, { version: p.version, source: p.source });
  return m;
}
