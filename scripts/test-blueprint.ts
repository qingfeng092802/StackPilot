/**
 * apply_stack_blueprint 回归测试：真实写临时目录，验证落盘闭环与安全边界。
 *
 * 断言对象：
 *   1. 双端点写入（.cursor/rules/stackpilot.mdc + CLAUDE.md）与 frontmatter 格式
 *   2. CLAUDE.md 的三种形态：新建 / 无标记追加（不动既有内容）/ 有标记幂等替换
 *   3. 参数安全：非法 combo_id、不存在/非目录/相对路径的 workspace 一律拒绝
 *   4. 确定性：同一组合两次渲染一字不差（架构契约不许有任何模型自由发挥）
 *
 * 用法：npx tsx scripts/test-blueprint.ts
 */

import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import combosRaw from '../src/data/combos.json' with { type: 'json' };
import { applyBlueprint, renderBlueprintBody, renderClaudeBlock } from '../mcp/blueprint.ts';
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

const root = mkdtempSync(join(tmpdir(), 'stackpilot-blueprint-test-'));

try {
  group('一、both 模式：双文件落盘 + frontmatter');
  {
    const ws = join(root, 'ws1');
    mkdirSync(ws, { recursive: true });
    const r = applyBlueprint({ combo_id: 'C07', workspace_path: ws, target_ide: 'both' }, combos);
    ok('写入成功', r.ok);
    if (r.ok) {
      ok('返回 2 个文件', r.files.length === 2);
      const mdcPath = join(ws, '.cursor', 'rules', 'stackpilot.mdc');
      ok('stackpilot.mdc 存在', existsSync(mdcPath));
      const mdc = readFileSync(mdcPath, 'utf8');
      ok('frontmatter 含 description', mdc.includes('description: StackPilot Architecture Blueprint'));
      ok('frontmatter 含 alwaysApply: true', mdc.includes('alwaysApply: true'));
      ok('frontmatter 含 globs 数组', mdc.includes('globs:'));
      ok('frontmatter 在正文之前', mdc.indexOf('---') === 0);
      ok('契约含组合名', mdc.includes('原生小程序 + Supabase 托管后端'));
      ok('契约含明确禁止区块', mdc.includes('## 明确禁止'));
      ok('契约含第一步', mdc.includes('## 第一步'));
      ok('契约含坑点', mdc.includes('高频新手坑'));
      const claude = readFileSync(join(ws, 'CLAUDE.md'), 'utf8');
      ok('CLAUDE.md 含 START 标记', claude.includes('<!-- STACKPILOT:START -->'));
      ok('CLAUDE.md 含 END 标记', claude.includes('<!-- STACKPILOT:END -->'));
      ok('返回立即执行指令', r.instruction.includes('第一步'));
    }
  }

  group('二、CLAUDE.md 幂等性：三种形态');
  {
    // 形态 1：已有内容但无标记 → 追加，既有内容一字不动
    const ws2 = join(root, 'ws2');
    mkdirSync(ws2, { recursive: true });
    writeFileSync(join(ws2, 'CLAUDE.md'), '# 我的项目说明\n\n手工写的内容。\n', 'utf8');
    const r2 = applyBlueprint({ combo_id: 'C12', workspace_path: ws2, target_ide: 'claude_code' }, combos);
    const claude2 = readFileSync(join(ws2, 'CLAUDE.md'), 'utf8');
    ok('既有内容保留', claude2.includes('# 我的项目说明') && claude2.includes('手工写的内容。'));
    ok('契约追加在后', claude2.indexOf('STACKPILOT:START') > claude2.indexOf('手工写的内容。'));
    ok('只写 CLAUDE.md（claude_code 模式无 .mdc）', r2.ok && r2.files.length === 1 && !existsSync(join(ws2, '.cursor')));

    // 形态 2：已有标记 → 区间整体替换，区间外不动，且不产生重复区块
    const r3 = applyBlueprint({ combo_id: 'C01', workspace_path: ws2, target_ide: 'claude_code' }, combos);
    const claude3 = readFileSync(join(ws2, 'CLAUDE.md'), 'utf8');
    ok('幂等替换后区块只有一份', (claude3.match(/STACKPILOT:START/g) ?? []).length === 1);
    ok('换成了新组合内容', claude3.includes('C01'));
    ok('不再包含旧组合内容', !claude3.includes('C12）'));
    ok('既有内容仍保留', claude3.includes('手工写的内容。'));
    ok('第二次写入 action=replaced', r3.ok && r3.files[0]?.action === 'replaced');

    // 形态 3：文件不存在 → 创建
    const ws3 = join(root, 'ws3');
    mkdirSync(ws3, { recursive: true });
    applyBlueprint({ combo_id: 'C11', workspace_path: ws3, target_ide: 'claude_code' }, combos);
    ok('CLAUDE.md 被创建', existsSync(join(ws3, 'CLAUDE.md')));
  }

  group('三、参数安全：非法输入一律拒绝且不写任何文件');
  {
    const ws4 = join(root, 'ws4');
    mkdirSync(ws4, { recursive: true });
    ok('非法 combo_id 拒绝', !applyBlueprint({ combo_id: 'C99', workspace_path: ws4 }, combos).ok);
    ok('空 combo_id 拒绝', !applyBlueprint({ combo_id: '', workspace_path: ws4 }, combos).ok);
    ok('不存在的目录拒绝', !applyBlueprint({ combo_id: 'C01', workspace_path: join(root, 'no-such-dir') }, combos).ok);
    ok('相对路径拒绝', !applyBlueprint({ combo_id: 'C01', workspace_path: 'relative/path' }, combos).ok);
    const filePath = join(root, 'a-file.txt');
    writeFileSync(filePath, 'x', 'utf8');
    ok('指向文件（非目录）拒绝', !applyBlueprint({ combo_id: 'C01', workspace_path: filePath }, combos).ok);
    ok('非法 target_ide 拒绝', !applyBlueprint({ combo_id: 'C01', workspace_path: ws4, target_ide: 'windsurf' as any }, combos).ok);
    ok('拒绝后没有写任何文件', !existsSync(join(ws4, 'CLAUDE.md')) && !existsSync(join(ws4, '.cursor')));
    // 错误信息要可行动（告诉宿主可选值 / 该怎么改）
    const bad = applyBlueprint({ combo_id: 'C99', workspace_path: ws4 }, combos);
    ok('错误信息列出可选组合', bad.ok === false && (bad as any).error.includes('C01'));
  }

  group('四、确定性：同一组合两次渲染一字不差');
  {
    const a = renderBlueprintBody(combos.find((c) => c.id === 'C01')!);
    const b = renderBlueprintBody(combos.find((c) => c.id === 'C01')!);
    ok('renderBlueprintBody 幂等', a === b);
    ok('renderClaudeBlock 幂等', renderClaudeBlock(combos.find((c) => c.id === 'C01')!) === renderClaudeBlock(combos.find((c) => c.id === 'C01')!));
  }

  group('五、内容边界：契约只含组合里真实存在的组件');
  {
    // C12 纯静态无 db / ai（components 里为 null）→ 契约不得出现数据库 / AI 槽位
    const c12 = combos.find((c) => c.id === 'C12')!;
    const body = renderBlueprintBody(c12);
    const hasDbSlot = /^- \*\*数据库\*\*/m.test(body);
    const hasAiSlot = /^- \*\*AI\*\*/m.test(body);
    ok('C12 无数据库槽位', !hasDbSlot);
    ok('C12 无 AI 槽位', !hasAiSlot);
    ok('C12 有前端槽位', /^- \*\*前端\*\*/m.test(body));
    // 防幻觉红线：**技术栈清单区块**里只能出现该组合自己的组件，
    // 不得出现任何闭集之外的中间件名（禁止区块里的反例引用不算——那是"不许装"的名单）
    for (const banned of ['Redis', 'Kafka', 'RabbitMQ', 'Elasticsearch', 'Prisma', 'MongoDB']) {
      const leaked = combos
        .map((c) => renderBlueprintBody(c))
        .some((b) => {
          const stackSection = b.split('## 技术栈')[1]?.split('## 明确禁止')[0] ?? '';
          return stackSection.includes(banned);
        });
      ok(`技术栈清单不出现闭集外的 ${banned}`, !leaked);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) process.exit(1);
