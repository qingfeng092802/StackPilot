/**
 * inspect_project（v2.1.0）：存量项目反查——"你现在的栈离哪套蓝图最近、偏离几条"。
 * ------------------------------------------------------------------
 * 【只读红线】这个工具一个字都不写。读到的每个文件都回显在结果里，
 * 用户能核对"它到底看了我什么"。
 *
 * 【边界哲学】monorepo / 多包仓库 MVP 直接拒绝（不为覆盖面硬猜）；
 * 非 Node / 非小程序项目明确说"覆盖不了 + 替代问法"，与 recommend_stack 的 uncovered 拦截同一条哲学。
 *
 * 【基线】"正确形态"来自骨架拼装器（buildScaffoldPlan 的 provenance）——
 * 骨架长什么样，反查就按什么算偏离。同一份资产喂三个工具。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { Combo } from '../src/lib/scoring.ts';
import { baselinePackagesOf } from '../src/lib/scaffold.ts';

export interface InspectInput {
  workspace_path: string;
}

export interface InspectOutcome {
  ok: boolean;
  /** isError 语义：参数/边界问题为 true */
  isError: boolean;
  markdown: string;
}

/** 读过的文件（回显用）——绝对路径不进输出，只回显相对路径，避免泄露目录结构 */
export function inspectProject(input: InspectInput, combos: Combo[]): InspectOutcome {
  const ws = String(input.workspace_path ?? '').trim();
  if (!ws || !isAbsolute(ws)) {
    return { ok: false, isError: true, markdown: `# 反查失败\n\nworkspace_path 必须是本地绝对路径，收到「${ws || '(空)'}」` };
  }
  const root = resolve(ws);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, isError: true, markdown: `# 反查失败\n\nworkspace_path 不存在或不是目录：${root}` };
  }

  const read: string[] = []; // 相对路径清单（回显）
  const tryRead = (rel: string): string | null => {
    const p = join(root, rel);
    if (!existsSync(p)) return null;
    try {
      const st = statSync(p);
      if (!st.isFile()) return null;
      read.push(rel);
      return readFileSync(p, 'utf8');
    } catch {
      read.push(rel + '（读取失败）');
      return null;
    }
  };
  const exists = (rel: string): boolean => {
    const hit = existsSync(join(root, rel));
    if (hit) read.push(rel);
    return hit;
  };

  // ── 1. 形态识别 ──
  const pkgRaw = tryRead('package.json');
  const isMiniprogram = exists('project.config.json') || exists('app.json');
  const isUni = exists('src/manifest.json') || exists('src/pages.json');

  // monorepo 边界：MVP 直接拒绝（不做硬猜）
  const monorepoMarkers = ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json'];
  const hasWorkspaces = pkgRaw ? /"workspaces"\s*:/.test(pkgRaw) : false;
  const monorepoHit = monorepoMarkers.some((m) => exists(m));
  if (hasWorkspaces || monorepoHit) {
    return {
      ok: false,
      isError: true,
      markdown:
        `# 覆盖不了：这是 monorepo / 多包仓库\n\n` +
        `> 这不是失败，是**主动不猜**。反查基线按"单包项目"建立，对多包仓库的偏离报告会是噪声。\n\n` +
        `检测到：${hasWorkspaces ? 'package.json 的 workspaces 字段' : monorepoMarkers.filter((m) => existsSync(join(root, m))).join(' / ')}。\n` +
        '可以只对其中一个子包做反查（把 workspace_path 指到该子包目录）。\n\n' +
        `---\n\n读取的文件：${read.join('、') || '（无）'}`,
    };
  }

  if (pkgRaw === null && !isMiniprogram && !isUni) {
    return {
      ok: false,
      isError: true,
      markdown:
        `# 覆盖不了：没有可识别的项目形态\n\n` +
        '> 反查目前认得两类项目：Node 单包（package.json）与微信小程序（project.config.json）。\n' +
        '> 你的目录里两者都没有。这不是失败——闭集覆盖不了就明说。\n\n' +
        `读取尝试：${read.length ? read.join('、') : '（目录为空或没有任何可识别文件）'}`,
    };
  }

  // ── 2. 提取"项目里实际有什么" ──
  let deps = new Set<string>();
  let projectName = '(未命名)';
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      projectName = pkg.name ?? projectName;
      for (const d of Object.keys(pkg.dependencies ?? {})) deps.add(d);
      for (const d of Object.keys(pkg.devDependencies ?? {})) deps.add(d);
    } catch {
      return { ok: false, isError: true, markdown: `# 反查失败\n\npackage.json 不是合法 JSON，无法解析。` };
    }
  }

  // ── 3. 对 12 套组合打"接近分"：先比命中数，再比命中率，最后比缺口数 ──
  // 为什么不是纯命中率：小组合（如 C05 基线只有 5 个包）靠分母小占便宜，
  // 会把"装了 7 个正确包"的大项目压下去。命中数才是"你有多少蓝图要求的东西"。
  const scored = combos
    .map((c) => {
      const base = baselinePackagesOf(c);
      let hit = 0;
      for (const pkg of base.keys()) if (deps.has(pkg)) hit++;
      const miss = [...base.keys()].filter((p) => !deps.has(p));
      const extra = [...deps].filter((p) => !base.has(p));
      return { combo: c, base, hit, hitRate: base.size ? hit / base.size : 0, miss, extra };
    })
    .sort((a, b) => b.hit - a.hit || b.hitRate - a.hitRate || a.miss.length - b.miss.length);

  const top = scored[0];
  const lines: string[] = [];

  if (isMiniprogram || isUni) {
    // 小程序没有 package.json 也可能成立（原生）：按形态直接给结论
    lines.push(`# 反查：${projectName}`);
    lines.push('');
    lines.push(`> 识别为**${isUni ? 'uni-app 多端' : '微信原生小程序'}**项目。读取的文件：${read.join('、') || '（无）'}`);
    lines.push('');
    if (deps.size === 0) {
      lines.push('没有 package.json（原生小程序），依赖维度无从比对。');
      lines.push(`形态上最接近的组合是 **${top.combo.id} ${top.combo.name}**（按组件基线匹配）。`);
      lines.push('下一步建议：确认是否已按组合的第一步完成初始化，再用 `recommend_stack` 复核选型。');
    } else {
      emitClosest(lines, top, projectName);
    }
  } else {
    emitClosest(lines, top, projectName);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`**读取的文件**：${read.join('、') || '（无）'}`);
  lines.push('');
  lines.push('> 本工具只读不写。以上"偏离"基于骨架基线（facts 快照锁定版本 + 运行时配套），');
  lines.push('> extra 依赖里标注为配套的（如 react、typescript）属于正常形态，不是偏离。');

  return { ok: true, isError: false, markdown: lines.join('\n') };

  // ── 输出"最接近组合 + 偏离清单" ──
  function emitClosest(out: string[], t: (typeof scored)[number], name: string) {
    out.push(`# 反查：${name}`);
    out.push('');
    out.push(`> 最接近的蓝图：**${t.combo.id} ${t.combo.name}**（组件包命中 ${t.hit}/${t.base.size}）。读取的文件：${read.join('、') || '（无）'}`);
    out.push('');
    if (t.miss.length) {
      out.push('## 缺了这些（蓝图里有、项目里没有）');
      out.push('');
      for (const p of t.miss) out.push(`- ${p}（${t.base.get(p)?.source === 'peer-estimate' ? '运行时配套' : '蓝图锁定依赖'}）`);
      out.push('');
    }
    if (t.extra.length) {
      out.push('## 多了这些（项目里有、不在蓝图基线里）');
      out.push('');
      out.push('> 不是都要删：有些是宿主工具自动加的或你自己需要的。但每一条都该能回答"为什么在这"。');
      out.push('');
      for (const p of t.extra) out.push(`- ${p}`);
      out.push('');
    }
    if (!t.miss.length && !t.extra.length) {
      out.push('✅ 与蓝图完全一致，没有偏离。');
      out.push('');
    }
    out.push('## 下一步');
    out.push('');
    out.push(`- 想按这套蓝图继续：用 \`apply_stack_blueprint\`（combo_id=${t.combo.id}）把架构契约写进项目规则文件；`);
    out.push('- 想从差异里挑几条先补：把缺的依赖装上，或评估 extra 里每一条的必要性；');
    out.push('- 觉得蓝图本身选错了：用 `recommend_stack` 重新选型。');
  }
}
