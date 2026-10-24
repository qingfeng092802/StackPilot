/**
 * 用 CDP 截全页图（Edge headless + Node 原生 WebSocket）。
 *
 * 为什么不用 `msedge --screenshot`：那条路的 `--virtual-time-budget` 会跟 SSE 的
 * 长连接打架——流还没读完就截图，抓到的永远是"正在生成说明文案…"那半屏。
 * 这里改成：起一个带 remote-debugging-port 的浏览器，轮询页面里的 `#doneMark`，
 * 等到流结束再 `Page.captureScreenshot`，并且用 captureBeyondViewport 抓整页。
 *
 * 用法：
 *   node scripts/shot.mjs --url=http://127.0.0.1:8787/?demo=medium --out=out/ui-medium.png
 *
 * 需要"先点几下再截"的场景（比如 F1 的追问态）用 --script 传一个 js 文件，
 * 里面的表达式会在页面加载后求值（支持 async，会等 Promise 落地）：
 *   node scripts/shot.mjs --url=... --script=scripts/ui-shot-ask.js --waitjs="!!document.querySelector('.q-card')"
 */

import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.join('=')];
  }),
);
const url = args.url ?? 'http://127.0.0.1:8787/?demo=medium';
const out = args.out ?? 'out/ui.png';
const port = Number(args.port ?? 9333);
const waitMs = Number(args.wait ?? 9000);
const scriptPath = args.script;
/** 默认等"完成"那一行；--script 场景通常要换一个更贴切的判据 */
const waitJs = args.waitjs ?? `!!document.querySelector('.progress-line')?.textContent?.startsWith('完成')`;

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const proc = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-proxy-server',
  '--hide-scrollbars',
  '--window-size=1440,1000',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${process.env.TEMP}\\edge-shot-profile`,
  url,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 浏览器还没起来 */ }
    await sleep(250);
  }
  throw new Error('没等到可调试的页面');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  return {
    ready,
    call(method, params = {}) {
      const myId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(myId, { resolve, reject });
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

const page = await findPage();
const c = cdp(page.webSocketDebuggerUrl);
await c.ready;
await c.call('Page.enable');
await c.call('Runtime.enable');

// 先等页面真正稳定，再执行脚本。
// 线上分享链接会先过一个"工作空间启动中"的过渡页、再跳到应用，这个跳转会销毁执行上下文，
// 于是 Runtime.evaluate 抛 "Execution context was destroyed"。所以这里带重试地轮询，
// 并且**只吞这一种错误**——别的错还是要抛出来，不然会把真实问题藏掉。
const readyJs = args.readyjs ?? 'document.readyState === "complete" && !!document.body';
{
  const readyDeadline = Date.now() + 30000;
  while (Date.now() < readyDeadline) {
    try {
      const { result } = await c.call('Runtime.evaluate', { expression: readyJs, returnByValue: true });
      if (result?.value) break;
    } catch (e) {
      if (!/Execution context was destroyed|Cannot find context/i.test(String(e.message))) throw e;
    }
    await sleep(300);
  }
}

// 页面脚本：awaitPromise 让它能等异步（点按钮 → 等 /api/intake 回来）
if (scriptPath) {
  const expr = await readFile(scriptPath, 'utf8');
  let r;
  try {
    r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  } catch (e) {
    // 同上：跳转导致的上下文销毁，重试一次就够（第二次通常已经在目标页上了）
    if (!/Execution context was destroyed|Cannot find context/i.test(String(e.message))) throw e;
    console.warn('⚠️ 脚本求值期间页面跳转，重试一次');
    r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  }
  if (r.exceptionDetails) console.warn('⚠️ 页面脚本抛异常：', r.exceptionDetails.text);
  else console.log('页面脚本返回：', JSON.stringify(r.result?.value));
}

// 等流跑完：轮询给定的判据
const deadline = Date.now() + waitMs;
let done = false;
while (Date.now() < deadline) {
  const { result } = await c.call('Runtime.evaluate', {
    expression: waitJs,
    returnByValue: true,
  });
  if (result.value) { done = true; break; }
  await sleep(200);
}
if (!done) console.warn('⚠️ 等待超时，页面可能还没渲染完');

// 让进场动画跑完
await sleep(700);

const { contentSize } = await c.call('Page.getLayoutMetrics');
// --clip=x,y,w,h 只截一块。整页图在对话里会被缩到看不清，检查细节时要局部截。
const clip = args.clip
  ? (([x, y, width, height]) => ({ x, y, width, height, scale: 1 }))(args.clip.split(',').map(Number))
  : { x: 0, y: 0, width: Math.ceil(contentSize.width), height: Math.ceil(contentSize.height), scale: 1 };
const shot = await c.call('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
  clip,
});
await writeFile(out, Buffer.from(shot.data, 'base64'));
console.log(`已截图 ${out}  ${Math.ceil(clip.width)}×${Math.ceil(clip.height)}`);

c.close();
proc.kill();
process.exit(0);
