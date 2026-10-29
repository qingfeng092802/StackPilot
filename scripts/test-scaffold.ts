/**
 * 骨架资产回归测试（v2.1.0）：单一事实源 → 三工具的底座必须钉死。
 *
 * 断言对象（ROADMAP 第一节验收）：
 *   1. 12 套全部可拼装、两次拼装逐字节一致（确定性红线）
 *   2. 版本溯源：facts 有条目的依赖必须精确锁定；peer-estimate 必须有 note
 *   3. 结构：README / build-info / .gitignore 齐全；布局规则正确（client/server 拆分）
 *   4. scaffoldBlueprint 落盘：空目录可写、非空目录拒绝、契约文件顺带落盘
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import combosRaw from '../src/data/combos.json' with { type: 'json' };
import { buildScaffoldPlan } from '../src/lib/scaffold.ts';
import { scaffoldBlueprint } from '../mcp/scaffold.ts';
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

const root = mkdtempSync(join(tmpdir(), 'stackpilot-scaffold-test-'));
try {
  group('一、12 套全部可拼装 + 确定性');
  {
    for (const combo of combos) {
      const a = buildScaffoldPlan(combo);
      const b = buildScaffoldPlan(combo);
      const same = JSON.stringify(a) === JSON.stringify(b);
      ok(`${combo.id} 可拼装且两次逐字节一致`, a.files.length > 0 && same);
    }
  }

  group('二、版本溯源');
  {
    const facts = JSON.parse(readFileSync(new URL('../src/data/facts-snapshot.json', import.meta.url), 'utf8'));
    const factMap = new Map<string, string>();
    for (const r of facts.records) if (r.version) factMap.set(`${r.entry_id}|${r.package}`, r.version);

    for (const combo of combos) {
      const plan = buildScaffoldPlan(combo);
      // facts 有条目的依赖：版本必须精确等于快照版本（不许 ^ ~）
      const violations = plan.provenance.filter((p) => {
        const entry = plan.components.find((c) => factMap.has(`${c}|${p.package}`));
        return entry && p.source === 'facts-snapshot' && p.version !== factMap.get(`${entry}|${p.package}`);
      });
      ok(`${combo.id} facts 依赖精确锁定`, violations.length === 0, JSON.stringify(violations));
      // peer-estimate 必须带说明
      ok(`${combo.id} peer 依赖都有 note`, plan.provenance.filter((p) => p.source === 'peer-estimate').every((p) => p.note));
      // build-info 存在且可解析
      const info = plan.files.find((f) => f.path === '.stackpilot/build-info.json');
      ok(`${combo.id} build-info 可解析`, Boolean(info) && Boolean(JSON.parse(info!.content)));
    }
  }

  group('三、结构断言');
  {
    const c03 = buildScaffoldPlan(combos.find((c) => c.id === 'C03')!); // React SPA + FastAPI
    ok('C03 拆出 client/package.json', c03.files.some((f) => f.path === 'client/package.json'));
    ok('C03 拆出 server/main.py', c03.files.some((f) => f.path === 'server/main.py'));
    ok('C03 server/requirements.txt 含 fastapi 锁定版', c03.files.some((f) => f.path === 'server/requirements.txt' && f.content.includes('fastapi==')));
    const c01 = buildScaffoldPlan(combos.find((c) => c.id === 'C01')!); // Next 全栈（BE-06 同根）
    ok('C01 单 package.json（托管后端不拆目录）', c01.files.filter((f) => f.path.endsWith('package.json')).length === 1);
    ok('C01 含 Supabase 客户端封装', c01.files.some((f) => f.path === 'lib/supabase.ts'));
    const c12 = buildScaffoldPlan(combos.find((c) => c.id === 'C12')!); // 纯静态
    ok('C12 无 AI 槽位文件', !c12.files.some((f) => f.path.startsWith('lib/ai')));
    ok('C12 README 含 last_reviewed', c12.files.some((f) => f.path === 'README.md' && f.content.includes('最近复核于')));
    for (const combo of combos) {
      const plan = buildScaffoldPlan(combo);
      ok(
        `${combo.id} 基础文件齐全`,
        ['.gitignore', 'README.md', '.stackpilot/build-info.json'].every((p) => plan.files.some((f) => f.path === p)),
      );
    }
  }

  group('四、scaffoldBlueprint 落盘与安全边界');
  {
    // 非空目录拒绝
    const occupied = join(root, 'occupied');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'user-file.txt'), '用户的东西', 'utf8');
    const r1 = scaffoldBlueprint({ combo_id: 'C12', workspace_path: occupied }, combos);
    ok('非空目录拒绝', !r1.ok && (r1 as any).error.includes('永不覆盖'));
    ok('拒绝后用户文件原样', readFileSync(join(occupied, 'user-file.txt'), 'utf8') === '用户的东西');

    // 空目录可写 + 契约顺带落盘
    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    const r2 = scaffoldBlueprint({ combo_id: 'C12', workspace_path: empty, target_ide: 'both' }, combos);
    ok('空目录写入成功', r2.ok);
    ok('骨架 package.json 落盘', existsSync(join(empty, 'package.json')));
    ok('架构契约 .mdc 落盘', existsSync(join(empty, '.cursor', 'rules', 'stackpilot.mdc')));
    ok('架构契约 CLAUDE.md 落盘', existsSync(join(empty, 'CLAUDE.md')));

    // 不存在的路径自动创建
    const fresh = join(root, 'fresh', 'deep');
    const r3 = scaffoldBlueprint({ combo_id: 'C07', workspace_path: fresh, target_ide: 'claude_code' }, combos);
    ok('不存在路径自动创建', r3.ok && existsSync(join(fresh, 'package.json')));
    ok('claude_code 模式不写 .mdc', !existsSync(join(fresh, '.cursor')));

    // 相对路径 / 非法 combo 拒绝
    ok('相对路径拒绝', !scaffoldBlueprint({ combo_id: 'C12', workspace_path: 'rel/path' }, combos).ok);
    ok('非法 combo 拒绝', !scaffoldBlueprint({ combo_id: 'C99', workspace_path: empty }, combos).ok);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) process.exit(1);
