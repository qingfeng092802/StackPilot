/**
 * MCP 冒烟测试：**真的起一个子进程、走 JSON-RPC**，而不是直接调函数。
 *
 * 为什么不用"import 一下 server.ts 然后调 handler"：
 * 那样测不到三件最容易坏的事——
 *   ① stdio 上有没有多余的输出把协议弄坏（`console.log` 是头号杀手）；
 *   ② `registerTool` 的 schema 客户端能不能正确解析；
 *   ③ 打包产物（build/mcp.js）本身能不能跑。
 * 前两条只有真客户端才暴露，第三条只有跑产物才暴露。
 *
 * 用法：
 *   node scripts/build.mjs          # 先打包
 *   npx tsx scripts/mcp-smoke.ts    # 再跑
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const entry = resolve(import.meta.dirname, '..', 'build', 'mcp.js');
if (!existsSync(entry)) {
  console.error(`找不到 ${entry}，先跑 node scripts/build.mjs`);
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  // 让服务端的 stderr 直接进我们的终端，方便看它的降级/模型日志
  stderr: 'inherit',
  env: { ...process.env } as Record<string, string>,
});

const client = new Client({ name: 'stackpilot-smoke', version: '0.0.1' });

const line = (s: string) => console.log('\n' + '='.repeat(78) + '\n' + s + '\n' + '='.repeat(78));

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  line(`已连接。服务端暴露 ${tools.length} 个工具：`);
  for (const t of tools) console.log(`  · ${t.name} — ${t.description?.slice(0, 60)}…`);

  // ① 用户原话（Vibe Coding 场景）
  const vibe = await client.callTool({
    name: 'recommend_stack',
    arguments: { raw_input: '我不会写代码，只想用 Cursor 自然语言让 AI 帮我写，我该选什么技术栈？' },
  });
  line('recommend_stack（Vibe Coding 场景）返回的 Markdown：');
  console.log((vibe.content as any)[0].text);

  // ② 一个普通需求，确认不是所有输入都推同一套
  const normal = await client.callTool({
    name: 'recommend_stack',
    arguments: { raw_input: '想给公司内部做个查资料的网页，就我们组三个人用，要能登录，不要对外' },
  });
  line('recommend_stack（内部工具场景）返回的 Markdown：');
  console.log((normal.content as any)[0].text);

  // ③ 指定技术栈
  const detail = await client.callTool({
    name: 'get_detailed_prompt',
    arguments: { combo_id: 'C11', user_requirements: '做个能随机听世界各地电台的网页，收藏只存浏览器里' },
  });
  line('get_detailed_prompt（C11）返回的 Markdown：');
  console.log((detail.content as any)[0].text);

  // ④ 不存在的组合，确认给的是有用提示而不是报错
  const bad = await client.callTool({
    name: 'get_detailed_prompt',
    arguments: { combo_id: 'C99', user_requirements: '随便' },
  });
  line('get_detailed_prompt（不存在的 C99）：');
  console.log((bad.content as any)[0].text);
} finally {
  await client.close();
}
