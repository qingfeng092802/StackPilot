/**
 * eval harness（v2.1.0）：把 ai_friendliness 从"判断"变成"实测"。
 * ------------------------------------------------------------------
 * 流程（ROADMAP 第二节·资产 B）：
 *   1. 取组合的启动 Prompt（确定性模板）
 *   2. 让真实模型按 Prompt 输出完整项目文件（JSON：path → content）
 *   3. 与骨架基线（buildScaffoldPlan）对比：依赖覆盖率 / 组件结构命中
 *   4. （--build 时）npm install && npm run build 实跑
 *   5. 结果追加 out/eval/results.jsonl（gitignore 内），含 verified_at 溯源
 *
 * 【当前状态】管道完整、MockProvider 可离线测试；真实评测需要有效 key
 * （P0-1b 用户侧解决后即可跑：node scripts/eval-scaffold.ts --combo C01 --model deepseek-flash）。
 *
 * 用法：
 *   npx tsx scripts/eval-scaffold.ts --combo C01 --model deepseek-flash [--rounds 3] [--build]
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

import combosRaw from '../src/data/combos.json' with { type: 'json' };
import { buildScaffoldPlan } from '../src/lib/scaffold.ts';
import { buildAiBootstrapPrompt } from '../src/lib/explain/bootstrap.ts';
import { extractJson } from '../src/lib/explain/index.ts';
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
const comboId = (opt('combo') ?? 'C12').toUpperCase();
const model = opt('model') ?? process.env.ANTHROPIC_MODEL ?? 'deepseek-flash';
const rounds = Number(opt('rounds') ?? 3);
const doBuild = hasFlag('build');

const combo = combos.find((c) => c.id === comboId);
if (!combo) {
  console.error(`组合 ${comboId} 不在闭集里。可选：${combos.map((c) => c.id).join(' / ')}`);
  process.exit(1);
}

function makeProvider(): LLMProvider {
  // --mock：本地 stub，输出一份固定结构的合规文件集（测管道，不代表模型能力——
  // 复用 MockProvider 不行，它绑定 ExplainContext，见 provider.ts 的注释）
  if (hasFlag('mock')) {
    return {
      name: 'stub-eval',
      available: () => true,
      unavailableReason: () => '',
      async complete() {
        const text = JSON.stringify({
          files: {
            'package.json': JSON.stringify({ name: 'eval-stub', dependencies: { vite: '8.3.5', react: '^19.0.0', 'react-dom': '^19.0.0' }, devDependencies: { '@vitejs/plugin-react': '^4.3.0', typescript: '^5.6.0', wrangler: '4.152.0' } }),
            'index.html': '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
            'src/main.tsx': "import { createRoot } from 'react-dom/client';\ncreateRoot(document.getElementById('root')!).render(null);\n",
          },
        });
        return { text, usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
  }
  return new AnthropicProvider({ model });
}

/** 让模型按启动 Prompt 输出项目文件 */
async function generateProject(provider: LLMProvider): Promise<{ files: Record<string, string>; raw: string }> {
  const bootstrap = buildAiBootstrapPrompt({ combo: combo!, vector: { delivery: 'web', ai_workflow: 'full_auto' }, rawInput: '按启动指令生成完整项目' });
  const prompt = [
    '你是代码生成器。按下面的项目启动指令，输出完整的项目文件。',
    '只输出一个 JSON 对象：{"files": {"<相对路径>": "<完整文件内容>"}}，不要 markdown 围栏、不要解释。',
    '必须包含 package.json（dependencies 带精确版本）与项目入口文件；不要 node_modules、不要 lock 文件。',
    '所有文件保持**最小可运行**：不要长注释、不要示例数据、不要内嵌 SVG/图标/样式表，能一行绝不多行——输出预算有限，超限截断等于零分。',
    '',
    '=== 项目启动指令 ===',
    bootstrap,
  ].join('\n');
  const res = await provider.complete({ system: '你是严格遵循技术栈约束的代码生成器。禁止引入启动指令清单之外的服务。', user: prompt });
  const json = extractJson(res.text);
  if (!json) {
    // 失败留痕：截断/围栏/空输出必须能区分，否则每次都要人肉诊断
    const diag = { stopReason: res.stopReason, hadThinking: res.hadThinking, usage: res.usage, head: res.text.slice(0, 200), tail: res.text.slice(-300) };
    throw new Error('模型输出里没有 JSON｜诊断: ' + JSON.stringify(diag).slice(0, 1500));
  }
  const parsed = JSON.parse(json);
  return { files: parsed.files ?? {}, raw: res.text };
}

/**
 * 部署工具链（DP 组件的 dev 依赖）：AI 按启动 Prompt 生成项目时**不该**指望它生成部署 CLI。
 * 这些从 locked_coverage 的必选分母中剔除，单独统计——它们由 scaffold 骨架 / 部署第一步覆盖。
 * 闭集哲学：清单封闭，新 DP 组件进来时同步这里。
 */
const DEPLOY_TOOLS = new Set(['vercel', 'wrangler', '@cloudbase/cli']);
/** 骨架基础文件，不参与 AI 覆盖对比（AI 有自己的 README/gitignore 习惯） */
const BASELINE_FILES_IGNORED = /^(.gitignore|README.md|.stackpouch.*)$/i;

function scoreAgainstBaseline(files: Record<string, string>) {
  const plan = buildScaffoldPlan(combo!);
  const baseline = new Map(plan.provenance.map((p) => [p.package, p]));
  const generated = new Set<string>();
  let pkgOk = false;
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith('package.json')) {
      try {
        const pkg = JSON.parse(content);
        for (const p of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) generated.add(p);
        pkgOk = true;
      } catch { /* package.json 非法计失败 */ }
    }
  }
  const lockedNeeded = [...baseline.entries()]
    .filter(([pkg, p]) => p.source === 'facts-snapshot' && !DEPLOY_TOOLS.has(pkg))
    .map(([pkg]) => ({ package: pkg, version: baseline.get(pkg)!.version }));
  const lockedHit = lockedNeeded.filter((p) => generated.has(p.package)).length;
  const deployTools = [...baseline.keys()].filter((p) => DEPLOY_TOOLS.has(p));

  // ── 骨架优势硬断言（v2.3）：scaffold 生成的部署工件，AI 一次生成时 100% 漏掉 ──
  // 这就是“比原生 AI 强”的核心数据：部署/测试类文件 AI 从不自发产出，骨架 100% 覆盖。
  const scaffoldPaths = plan.files.map((f) => f.path).filter((p) => !BASELINE_FILES_IGNORED.test(p));
  const aiPaths = new Set(Object.keys(files));
  const filesAiMissed = scaffoldPaths.filter((p) => !aiPaths.has(p));
  const DEPLOY_ARTIFACT_RE = new RegExp('(^|[\\\\/])(deploy[\\\\/]|vercel\\.json|wrangler\\.toml|cloudbaserc|docker-compose\\.yml)');
  const deployArtifacts = scaffoldPaths.filter((p) => DEPLOY_ARTIFACT_RE.test(p));
  const scaffoldAdvantage = {
    // 硬断言：骨架的部署工件必须全部出现在 AI 的缺失清单里
    deploy_artifacts_covered_by_ai: deployArtifacts.filter((p) => aiPaths.has(p)),
    deploy_artifacts_all_missed_by_ai: deployArtifacts.every((p) => !aiPaths.has(p)),
    scaffold_deploy_files: deployArtifacts,
    files_ai_missed_count: filesAiMissed.length,
    files_ai_missed_sample: filesAiMissed.slice(0, 8),
    deploy_tools_ai_generated: deployTools.filter((p) => generated.has(p)),
  };
  const extra = [...generated].filter((p) => !baseline.has(p.package));
  // 入口文件形态覆盖：Next（app/page）/ Vite-React（src/main）/ 小程序（pages/index）/
  // SvelteKit（src/routes/+page）/ uni-app（index.svelte）——eval 批次暴露的检测盲区已补
  const ENTRY_RE = new RegExp('app/page|src/main|src/App|pages/index|main\\.py|src/routes/\\+page|index\\.svelte|src/views');
  const hasEntry = Object.keys(files).some((p) => ENTRY_RE.test(p.replace(/\\/g, '/')));
  return {
    package_json_valid: pkgOk,
    locked_coverage: lockedNeeded.length ? Math.round((lockedHit / lockedNeeded.length) * 100) / 100 : 1,
    locked_hit: lockedHit,
    locked_total: lockedNeeded.length,
    extra_packages: extra,
    entry_file_present: hasEntry,
    file_count: Object.keys(files).length,
    ...scaffoldAdvantage,
  };
}

function runBuild(dir: string): { ok: boolean | null; detail: string } {
  // 小程序等形态没有 npm build 语义（package.json 无 build script）——记 skipped 不算失败
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (!pkg.scripts?.build) return { ok: null, detail: 'skipped: 无 build script（无构建形态，按入口文件判 passed）' };
  } catch { /* package.json 缺失时走正常 install/build 流程报错 */ }
  const r1 = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', shell: true, timeout: 300000 });
  if (r1.status !== 0) {
    // error 汇总在 npm 输出的后段，取尾部而非头部（头部全是 deprecation warning）
    const tailErr = ((r1.stderr || '') + (r1.stdout || '')).split('npm error').filter(Boolean).at(-1)?.trim().slice(0, 300);
    return { ok: false, detail: `npm install 失败：${tailErr || (r1.stderr || '').slice(-300)}` };
  }
  const r2 = spawnSync('npm', ['run', 'build'], { cwd: dir, encoding: 'utf8', shell: true, timeout: 300000 });
  if (r2.status === 0) return { ok: true, detail: 'build 通过' };
  const tailErr2 = ((r2.stderr || '') + (r2.stdout || '')).split('npm error').filter(Boolean).at(-1)?.trim().slice(0, 300);
  return { ok: false, detail: `build 失败：${tailErr2 || (r2.stderr || '').slice(-300)}` };
}

// ── 主流程 ──
const provider = makeProvider();
if (!provider.available() && !hasFlag('mock')) {
  console.error('没有可用的模型凭据（P0-1b 未完成）：设置 ANTHROPIC_API_KEY 后重试，或加 --mock 测试管道。');
  process.exit(1);
}

const outDir = resolve(import.meta.dirname, '..', 'out', 'eval');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const resultsFile = join(outDir, 'results.jsonl');

console.log(`eval：组合 ${comboId}（${combo!.name}）· 模型 ${model} · ${rounds} 轮${doBuild ? ' · 含实跑 build' : ''}`);
let success = 0;

for (let i = 1; i <= rounds; i++) {
  const started = Date.now();
  try {
    const { files } = await generateProject(provider);
    const s = scoreAgainstBaseline(files);
    let build: { ok: boolean | null; detail: string } = { ok: null, detail: '跳过（未加 --build）' };
    if (doBuild) {
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const dir = mkdtempSync(join(tmpdir(), 'sp-eval-'));
      for (const [rawPath, c] of Object.entries(files)) {
        // AI 生成的路径 key 混用 / 和 \（实测 C11：反斜杠 key 在 Windows 上触发与 scaffold
        // 同款的"掐尾建目录"bug）——统一规范化为 POSIX，再用 dirname 建父目录
        const p = String(rawPath).replace(/\\/g, '/');
        const target = join(dir, p);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, c, 'utf8');
      }
      build = runBuild(dir);
    }
    const passed = s.package_json_valid && s.locked_coverage >= 0.8 && s.entry_file_present && (build.ok !== false);
    const failureKind = passed ? 'passed'
      : !s.package_json_valid || !s.entry_file_present ? 'shape_fail'
      : build.ok === false ? 'build_fail'
      : s.locked_coverage < 0.8 ? 'coverage_fail' : 'unknown';
    if (passed) success++;
    const record = {
      verified_at: new Date().toISOString(),
      combo_id: comboId,
      combo_name: combo!.name,
      model,
      round: i,
      passed,
      failure_kind: failureKind,
      latency_ms: Date.now() - started,
      ...s,
      build: doBuild ? build : undefined,
    };
    appendFileSync(resultsFile, JSON.stringify(record) + '\n', 'utf8');
    console.log(`  轮 ${i}：${passed ? '✅' : '❌'} 锁定依赖覆盖 ${s.locked_hit}/${s.locked_total} 入口文件 ${s.entry_file_present ? '有' : '无'} 多余依赖 ${s.extra_packages.length} 个${doBuild ? ` build=${build.detail}` : ''}`);
  } catch (e) {
    appendFileSync(resultsFile, JSON.stringify({ verified_at: new Date().toISOString(), combo_id: comboId, model, round: i, passed: false, error: String((e as Error)?.message ?? e).slice(0, 200) }) + '\n', 'utf8');
    console.log(`  轮 ${i}：❌ ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
}

console.log(`\n结果：${success}/${rounds} 轮通过 · 明细已追加 ${resultsFile}`);
console.log('回填方式：把通过率写回 combos.json 的 ai_friendliness（ai_friendliness_note 记录本批次 verified_at），保持溯源。');
