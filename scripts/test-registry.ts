/**
 * 工具注册表回归测试（v2.1.1）：补上"误删 toParseInfo"暴露的盲区。
 *
 * 304 条数字断言覆盖的是数据/渲染层；"工具名 → handler"的接线层此前只有
 * smoke（spawn 子进程）覆盖，太慢进不了每次 npm test。本套件 import
 * buildToolTools()（不启动 stdio），毫秒级断言接线层：
 *   1. 五个工具名齐全、schema 必填字段在
 *   2. 每个 handler 对空输入不抛（safeHandler 保证异常转 isError 结构）
 *   3. 参数错误路径返回 isError:true 而不是异常
 *   4. 最小合法输入端到端可调（recommend_stack 无 key 走路径 C，确定性）
 *
 * 用法：npx tsx scripts/test-registry.ts
 */

import { buildToolTools } from '../mcp/tools.ts';

// registry 测试必须确定性：抹掉 shell 里可能存在的（哪怕失效的）key，
// 强制路径 A/C。isLlmEnabled() 是运行时求值，这里删除即可生效。
delete (process.env as any).ANTHROPIC_API_KEY;

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

const tools = buildToolTools();
const byName = new Map(tools.map((t) => [t.name, t]));

const EXPECTED = ['recommend_stack', 'get_detailed_prompt', 'apply_stack_blueprint', 'scaffold_blueprint', 'inspect_project'];

group('一、注册表完整性：五个工具名齐全 + schema 必填字段在');
{
  ok('工具名与预期完全一致', JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify([...EXPECTED].sort()), tools.map((t) => t.name).join(','));
  for (const t of tools) {
    ok(`${t.name} 有 title/description/inputSchema`, Boolean(t.spec.title && t.spec.description && t.spec.inputSchema));
  }
  const rec = byName.get('recommend_stack')!;
  ok('recommend_stack schema 含 raw_input 与 extracted_constraints', 'raw_input' in rec.spec.inputSchema && 'extracted_constraints' in rec.spec.inputSchema);
  const det = byName.get('get_detailed_prompt')!;
  ok('get_detailed_prompt schema 含 combo_id / user_requirements', 'combo_id' in det.spec.inputSchema && 'user_requirements' in det.spec.inputSchema);
  const sc = byName.get('scaffold_blueprint')!;
  ok('scaffold_blueprint schema 含 combo_id / workspace_path / target_ide', 'combo_id' in sc.spec.inputSchema && 'workspace_path' in sc.spec.inputSchema && 'target_ide' in sc.spec.inputSchema);
  const insp = byName.get('inspect_project')!;
  ok('inspect_project schema 含 workspace_path', 'workspace_path' in insp.spec.inputSchema);
}

group('二、空输入不抛：safeHandler 兜底要能扛住"误删一个函数"级别的断裂');
{
  for (const t of tools) {
    let threw = false;
    let result: any;
    try {
      result = await t.handler({});
    } catch (e) {
      threw = true;
      console.log(`    （${t.name} 抛出：${String((e as Error)?.message ?? e).slice(0, 80)}）`);
    }
    ok(`${t.name} 空输入不抛异常`, !threw);
    ok(`${t.name} 空输入返回结构化 content`, Boolean(result?.content?.[0]?.text));
  }
}

group('三、参数错误路径：isError:true 而非异常');
{
  // 注意写法：`await get(x)!(...)` 在顶层 await 场景下转译有歧义（实测炸），
  // 一律先取出 handler 再调用——这也是给后来人的写法示范。
  const inspH = byName.get('inspect_project')!.handler;
  ok('inspect 空路径 isError', (await inspH({ workspace_path: '' })).isError === true);
  ok('inspect 相对路径 isError', (await inspH({ workspace_path: 'relative/path' })).isError === true);
  const scH = byName.get('scaffold_blueprint')!.handler;
  ok('scaffold 空参数 isError', (await scH({ combo_id: '', workspace_path: '' })).isError === true);
  const apH = byName.get('apply_stack_blueprint')!.handler;
  ok('apply 非法 combo isError', (await apH({ combo_id: 'C99', workspace_path: 'D:/definitely-not-exist-xyz' })).isError === true);
}

group('四、最小合法输入端到端（无 key → 路径 C，确定性）');
{
  const recH = byName.get('recommend_stack')!.handler;
  const rec = await recH({ raw_input: '我想做个记账的小程序，我自己一个人做' });
  const text = rec.content[0].text;
  ok('recommend 正常出方案', !rec.isError && text.startsWith('# 推荐：'), text.slice(0, 120));
  const detH = byName.get('get_detailed_prompt')!.handler;
  const det = await detH({ combo_id: 'C12', user_requirements: '测试' });
  ok('detailed 正常返回', det.content[0].text.includes('C12'));
  const bad = await detH({ combo_id: 'C99', user_requirements: '测试' });
  ok('不存在的组合给提示而非报错', !bad.isError && bad.content[0].text.includes('没有 C99'));
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) process.exit(1);
