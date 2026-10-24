/**
 * 打包成 build/server.js：单文件、零运行时依赖、**不含任何凭据**。
 *
 * 和上一版（scripts/build-deploy.mjs）最关键的差别，也是这次迁移的全部理由：
 *   上一版会生成 boot.js，把 `ANTHROPIC_API_KEY` 写进去，随产物一起上传到
 *   **没有环境变量注入能力**的沙箱。产物 = 公网链接背后的代码，等于把 key 交给了平台。
 *   这一版**只从 process.env 读凭据**，产物里一个字符都没有。
 *
 * 产物只有 `build/server.js` 一个文件：
 *   web/ 和 tests/fixtures/ 不复制——server 用 `import.meta.url` 找到项目根，
 *   直接用根目录下的那两份。少一份副本，就少一处"改了 A 忘了改 B"。
 *
 * 用法：
 *   node scripts/build.mjs
 *
 * 单路径折叠不再是构建变体：它现在是纯运行时开关 `SP_SINGLE_PATH=1`。
 * 理由：既然换了能注入环境变量的平台，形态就该由环境决定，而不是由"打了哪个包"决定。
 * 同一个产物，本地多路径、线上按需折叠，不会出现"线上跑的不是你测的那个包"。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'build');
const outFile = join(outDir, 'server.js');

console.log(`打包 → ${outFile}`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Windows 上 npx 是 .cmd，spawnSync 不带 shell 会 EINVAL，所以走 shell + 引号。
const q = (s) => `"${s}"`;
const cmd = [
  'npx esbuild server/index.ts',
  '--bundle --platform=node --format=esm --target=node20 --log-level=warning',
  `--outfile=${q(outFile)}`,
].join(' ');

const r = spawnSync(cmd, { cwd: root, stdio: 'inherit', shell: true });
if (r.status !== 0) {
  console.error('esbuild 打包失败（web server）');
  process.exit(1);
}

// 1.5 MCP Server：打成 build/mcp.js，带 shebang 以便当 bin 用。
//     为什么要 bundle 而不是只转译：bundle 之后 `npx` 拉下来的包里
//     不需要解析 @modelcontextprotocol/sdk 的相对路径，启动更快、更不容易坏。
const mcpFile = join(outDir, 'mcp.js');
const mcpCmd = [
  'npx esbuild mcp/server.ts',
  '--bundle --platform=node --format=esm --target=node20 --log-level=warning',
  `--banner:js=${q('#!/usr/bin/env node')}`,
  `--outfile=${q(mcpFile)}`,
].join(' ');
const r2 = spawnSync(mcpCmd, { cwd: root, stdio: 'inherit', shell: true });
if (r2.status !== 0) {
  console.error('esbuild 打包失败（MCP server）');
  process.exit(1);
}

// ── 红线自检：产物里绝不能出现疑似 API Key ────────────────────────
// 这一条不是"顺手加的检查"，是把"凭据不进产物"从口头承诺变成构建期强制。
// 谁哪天为了图省事把 key 写进默认值，构建会直接失败，而不是等到链接被人扒。
const code = readFileSync(outFile, 'utf8') + readFileSync(join(outDir, 'mcp.js'), 'utf8');
const suspicious = [
  { name: '疑似 Anthropic/DeepSeek key', re: /sk-[A-Za-z0-9_-]{16,}/g },
  { name: '疑似 key 赋值字面量', re: /(api[_-]?key|API_KEY)\s*[:=]\s*["'][^"'\s]{16,}["']/gi },
];
let leaked = false;
for (const { name, re } of suspicious) {
  const hits = code.match(re) ?? [];
  // 排除代码里本来就有的变量名/注释（`ANTHROPIC_API_KEY` 本身不含长字面量，不会命中）
  const real = hits.filter((h) => !/^["']?(api[_-]?key|API_KEY)["']?$/i.test(h));
  if (real.length) {
    leaked = true;
    const masked = real.map((h) => (h.length > 8 ? `${h.slice(0, 4)}…${h.slice(-4)}` : h));
    console.error(`  ✗ 产物里发现${name}：${masked.join(', ')}`);
  }
}
if (leaked) {
  console.error('');
  console.error('  构建已中止。凭据只能从 process.env 读取，不能写进代码。');
  console.error('  见 docs/deploy-safe.md 的「红线」一节。');
  process.exit(1);
}

const size = statSync(outFile).size;
const mcpSize = statSync(join(outDir, 'mcp.js')).size;
console.log(`  server.js  ${(size / 1024).toFixed(0)} KB   （Web 调试台）`);
console.log(`  mcp.js     ${(mcpSize / 1024).toFixed(0)} KB   （MCP Server，stdio）`);
console.log('  路由形态   多路径（要折叠成单路径就设 SP_SINGLE_PATH=1，运行时生效）');
console.log('  凭据       无（运行时从 process.env 读）');
console.log('  依赖       无（只用 node 内置模块）');
console.log('');
console.log('  下一步：');
console.log('    本地跑    npm run dev     （会自动 build，并强制读取 .env.local）');
console.log('    线上      npm start       （由平台注入 ANTHROPIC_API_KEY）');
console.log('');
console.log('  注意：不要用 `node --env-file=.env.local` 启动——它在变量已存在时不覆盖，');
console.log('        会一直用 shell 里的旧 key，然后报 401。');
