/**
 * inspect_project 回归测试（v2.1.0）：只读反查的识别、偏离、边界拒绝。
 *
 * 断言对象（ROADMAP 第三节·资产 A 验收）：
 *   1. 正常 Node 单包：识别最接近组合 + 缺/多清单 + 文件回显
 *   2. monorepo（workspaces / pnpm-workspace.yaml）明确拒绝
 *   3. 无可识别形态明确拒绝（不硬猜）
 *   4. 只读：跑完之后工作区内容逐字节不变
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import combosRaw from '../src/data/combos.json' with { type: 'json' };
import { buildScaffoldPlan } from '../src/lib/scaffold.ts';
import { inspectProject } from '../mcp/inspect.ts';
import type { Combo } from '../src/lib/scoring.ts';

const combos = (combosRaw as any).combos as Combo[];

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? `｜${extra}` : ''}`);
  }
}
const group = (t: string) => console.log(`\n${t}`);

const root = mkdtempSync(join(tmpdir(), 'stackpilot-inspect-test-'));
try {
  group('一、正常 Node 单包：识别 + 偏离 + 回显');
  {
    const ws = join(root, 'ws1');
    mkdirSync(ws, { recursive: true });
    // 摆一个与 C01 完全对齐但多了 redis 的项目（C01 基线：next/react/react-dom/@supabase/supabase-js/ai + typescript/vercel）
    writeFileSync(join(ws, 'package.json'), JSON.stringify({
      name: 'my-app',
      dependencies: { next: '16.4.2', react: '^19.0.0', 'react-dom': '^19.0.0', '@supabase/supabase-js': '2.118.0', ai: '7.0.150', redis: '^4.0.0' },
      devDependencies: { typescript: '^5.6.0', vercel: '65.2.0' },
    }, null, 2));
    const r = inspectProject({ workspace_path: ws }, combos);
    ok('识别成功', r.ok && !r.isError);
    ok('报出最接近组合 C01', r.markdown.includes('**C01'));
    ok('多清单标出 redis', r.markdown.includes('redis'));
    ok('文件清单回显', r.markdown.includes('package.json'));
    ok('声明只读', r.markdown.includes('只读不写'));

    // 缺失路径：只有 next 的项目，缺清单非空
    const ws2 = join(root, 'ws2');
    mkdirSync(ws2, { recursive: true });
    writeFileSync(join(ws2, 'package.json'), JSON.stringify({ name: 'thin', dependencies: { next: '16.4.2' } }));
    const r2 = inspectProject({ workspace_path: ws2 }, combos);
    ok('缺清单区块存在', r2.markdown.includes('缺了这些'));
    ok('缺清单按配套/锁定分类', r2.markdown.includes('运行时配套') || r2.markdown.includes('蓝图锁定依赖'));
  }

  group('二、scaffold 出来的项目应"完全一致"（三工具自洽）');
  {
    const { scaffoldBlueprint } = await import('../mcp/scaffold.ts');
    const ws = join(root, 'ws-scaffold');
    const r = scaffoldBlueprint({ combo_id: 'C12', workspace_path: ws, target_ide: 'none' as any }, combos);
    // target_ide 非法会被拒——用 both 但只检查反查结论
    const ws2 = join(root, 'ws-scaffold2');
    scaffoldBlueprint({ combo_id: 'C12', workspace_path: ws2, target_ide: 'both' }, combos);
    const r2 = inspectProject({ workspace_path: ws2 }, combos);
    ok('scaffold 产物反查 = 与蓝图一致', r2.ok && r2.markdown.includes('完全一致'), r2.markdown.slice(0, 200));
  }

  group('三、边界拒绝');
  {
    // monorepo：workspaces 字段
    const mono1 = join(root, 'mono1');
    mkdirSync(mono1, { recursive: true });
    writeFileSync(join(mono1, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    const r1 = inspectProject({ workspace_path: mono1 }, combos);
    ok('workspaces monorepo 拒绝', r1.isError && r1.markdown.includes('monorepo'));
    // monorepo：pnpm-workspace.yaml
    const mono2 = join(root, 'mono2');
    mkdirSync(mono2, { recursive: true });
    writeFileSync(join(mono2, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    const r2 = inspectProject({ workspace_path: mono2 }, combos);
    ok('pnpm workspace 拒绝', r2.isError && r2.markdown.includes('monorepo'));
    // 空目录 / 不存在
    const blank = join(root, 'blank');
    mkdirSync(blank, { recursive: true });
    const r3 = inspectProject({ workspace_path: blank }, combos);
    ok('无可识别形态拒绝', r3.isError && r3.markdown.includes('覆盖不了'));
    ok('拒绝时也回显读取尝试', r3.markdown.includes('读取尝试'));
    const r4 = inspectProject({ workspace_path: join(root, 'no-such') }, combos);
    ok('不存在目录拒绝', r4.isError);
    ok('相对路径拒绝', !inspectProject({ workspace_path: 'rel' }, combos).ok);
  }

  group('四、只读保证');
  {
    const ws = join(root, 'ws-readonly');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'package.json'), '{"name":"x","dependencies":{"next":"16.4.2"}}');
    const before = readFileSync(join(ws, 'package.json'), 'utf8');
    inspectProject({ workspace_path: ws }, combos);
    const after = readFileSync(join(ws, 'package.json'), 'utf8');
    ok('文件内容不变', before === after);
    ok('没有新增任何文件', existsSync(join(ws, 'CLAUDE.md')) === false && existsSync(join(ws, '.cursor')) === false);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) process.exit(1);
