/**
 * 本地启动器：读 .env.local → **覆盖**已有环境变量 → 拉起 build/server.js。
 *
 * 为什么不用 `node --env-file=.env.local`：
 *   Node 的 `--env-file` 在变量**已存在**时**不覆盖**（和 dotenv 默认行为一样）。
 *   而本机 shell 里经常已经有别的 `ANTHROPIC_API_KEY`（别的工具、别的项目、CI 变量……）。
 *   结果就是你改了 .env.local 却一直在用旧 key，接口报 401「凭据无效」，
 *   而启动日志、代码、配置文件看起来全对——这种问题极难查。实测踩过一次。
 *
 * 为什么这个文件里没有凭据：
 *   它只负责**把 .env.local 读进内存**，key 本身不进仓库、不进产物。
 *   线上根本不用它——平台会直接把环境变量注入给 `node build/server.js`。
 *
 * 用法：
 *   npm run dev          # = 先 build，再跑这个
 *   node scripts/dev.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const envPath = resolve(root, '.env.local');

let raw;
try {
  raw = readFileSync(envPath, 'utf8');
} catch {
  console.error('');
  console.error('  ✗ 没找到 .env.local');
  console.error('');
  console.error('    从 .env.example 复制一份，填上真实的 key：');
  console.error('      cp .env.example .env.local');
  console.error('');
  process.exit(1);
}

// 【.env.local 是本地唯一的凭据来源】先清掉从 shell 继承来的同名变量。
//
// 为什么必须清：实测发现，本机 shell 里另有一个 ANTHROPIC_API_KEY（别的工具设的）。
// 把 .env.local 里的 key 行删掉之后，服务**照样起来了**——用的是那个全局 key，
// 启动日志显示 `key 已加载（…7547）`，而 .env.local 里明明没有。
//
// 这比"报错"危险得多：你以为凭据已经拿掉了，实际还在用一把你没在管的 key。
// 也会让"删掉 key 应该起不来"这条反向验收永远通不过。
// 所以只保留 .env.local 里写的，其余一律不认。只清这三个受管变量，不动 PORT 等。
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']) delete process.env[k];

let loaded = 0;
for (const line of raw.split(/\r?\n/)) {
  if (/^\s*#/.test(line) || !line.trim()) continue;
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  // 去掉成对引号，避免 "sk-xxx" 把引号也带进 header
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  process.env[m[1]] = v; // 覆盖，不跳过
  loaded++;
}
console.log(`  已从 .env.local 载入 ${loaded} 个变量（覆盖同名环境变量）`);

// build/ 是 .gitignore 的产物，没 build 过就提示清楚，别让它报 MODULE_NOT_FOUND
try {
  await import('../build/server.js');
} catch (e) {
  if (String(e?.code) === 'ERR_MODULE_NOT_FOUND') {
    console.error('');
    console.error('  ✗ 找不到 build/server.js —— 先打包：');
    console.error('      npm run build');
    console.error('');
    process.exit(1);
  }
  throw e;
}
