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

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

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

/** 与骨架基线对比 */
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
  const lockedNeeded = [...baseline.values()].filter((p) => p.source === 'facts-snapshot');
  const lockedHit = lockedNeeded.filter((p) => generated.has(p.package)).length;
  const extra = [...generated].filter((p) => !baseline.has(p.package));
  const hasEntry = Object.keys(files).some((p) => /app\/page|src\/main|src\/App|pages\/index|main\.py/.test(p));
  return {
    package_json_valid: pkgOk,
    locked_coverage: lockedNeeded.length ? Math.round((lockedHit / lockedNeeded.length) * 100) / 100 : 1,
    locked_hit: lockedHit,
    locked_total: lockedNeeded.length,
    extra_packages: extra,
    entry_file_present: hasEntry,
    file_count: Object.keys(files).length,
  };
}

function runBuild(dir: string): { ok: boolean; detail: string } {
  const r1 = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', shell: true, timeout: 300000 });
  if (r1.status !== 0) return { ok: false, detail: `npm install 失败：${(r1.stderr || '').slice(0, 200)}` };
  const r2 = spawnSync('npm', ['run', 'build'], { cwd: dir, encoding: 'utf8', shell: true, timeout: 300000 });
  return { ok: r2.status === 0, detail: r2.status === 0 ? 'build 通过' : `build 失败：${(r2.stderr || '').slice(0, 200)}` };
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
    let build: { ok: boolean; detail: string } = { ok: null as unknown as boolean, detail: '跳过（未加 --build）' };
    if (doBuild) {
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const dir = mkdtempSync(join(tmpdir(), 'sp-eval-'));
      for (const [p, c] of Object.entries(files)) {
        const target = join(dir, p);
        mkdirSync(target.slice(0, target.lastIndexOf('/')) || dir, { recursive: true });
        writeFileSync(target, c, 'utf8');
      }
      build = runBuild(dir);
    }
    const passed = s.package_json_valid && s.locked_coverage >= 0.8 && s.entry_file_present && (build.ok !== false);
    if (passed) success++;
    const record = {
      verified_at: new Date().toISOString(),
      combo_id: comboId,
      combo_name: combo!.name,
      model,
      round: i,
      passed,
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
