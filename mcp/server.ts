/**
 * StackPilot MCP Server（stdio 传输）v2.1.1 —— 薄壳。
 *
 * 全部工具定义与业务逻辑在 mcp/tools.ts（可 import、可单测）；
 * 这个文件只做三件事：
 *   1. stdout 守卫（源码直跑场景；bundle 产物由 build.mjs 注入更早的同一套守卫）
 *   2. 进程级异常兜底（uncaughtException / unhandledRejection 绝不退出）
 *   3. 循环注册五个工具 + connect
 */

for (const m of ['log', 'info', 'warn', 'debug'] as const) {
  (console as any)[m] = (...args: unknown[]) => console.error('[stdout-guard]', ...args);
}
process.on('uncaughtException', (e) => {
  console.error('[stackpilot] uncaughtException（进程保持存活）:', (e as Error)?.stack ?? String(e));
});
process.on('unhandledRejection', (e) => {
  console.error('[stackpilot] unhandledRejection（进程保持存活）:', e instanceof Error ? e.stack : String(e));
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildToolTools, log, VERSION } from './tools.ts';

const server = new McpServer({ name: 'stackpilot', version: VERSION });
for (const t of buildToolTools()) {
  server.registerTool(t.name, t.spec, t.handler);
}

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready v${VERSION} (mode=${Boolean(process.env.ANTHROPIC_API_KEY?.trim()) ? 'llm + rule + host' : 'rule + host, no key'}; 5 tools registered)`);
