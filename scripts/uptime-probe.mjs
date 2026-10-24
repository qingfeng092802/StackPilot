/**
 * 部署可用性探针：按 PRD §14 Q4 第 2 关的判据跑 N 次，输出失败率 + 分位延迟。
 *
 * 为什么要有这个脚本而不是"我手动 curl 几次看看"：
 *   第 2 关的判据是"失败率 > 5% 淘汰"，这是个**比例**判据。
 *   手测 3 次全过说明不了任何事——3 次里 1 次失败就是 33%。
 *   而且三网要各测 20 次，人工敲 60 次命令既慢又容易记错数。
 *
 * 用法：
 *   node scripts/uptime-probe.mjs                       # 默认 20 次 GET 首页
 *   node scripts/uptime-probe.mjs --n=20 --label=联通    # 三网分别跑，label 只用于输出
 *   node scripts/uptime-probe.mjs --mode=intake --n=5    # 顺带验接口（会调模型，别开太大）
 *   node scripts/uptime-probe.mjs --url=http://127.0.0.1:8899/
 *
 * 退出码：失败率 > 5% 时为 1，否则 0。这样它能直接进 CI / 定时任务。
 *
 * 判定"成功"的口径（比"HTTP 200"严）：
 *   GET   —— 200 且正文包含 __SP_EP__（证明拿到的是真实应用页，不是网关错误页/占位页）
 *   intake—— 200 且 JSON.ok === true 且有 parsed 字段
 *   只看状态码会把"网关 200 返回一张错误页"当成成功，那正是最难发现的一类故障。
 */

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] || 'true'] : [a, 'true'];
  }),
);

const URL_ = args.get('url') ?? 'http://127.0.0.1:8787/';
const N = Number(args.get('n') ?? 20);
const MODE = args.get('mode') ?? 'page';
const LABEL = args.get('label') ?? '本机网络';
const TIMEOUT_MS = Number(args.get('timeout') ?? 20000);
const RAW_INPUT = '想做个网页，打开就能随机听世界各地电台，收藏只存浏览器里，不要账号，也不要广告';

// 本机有全局 HTTP 代理时，探本地端口会被代理劫持（返回 502），所以 loopback 一律不走代理。
const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(URL_);
if (isLoopback) {
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
  process.env.NO_PROXY = '*';
}

async function onePage() {
  const t0 = performance.now();
  const res = await fetch(URL_, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.text();
  const ms = performance.now() - t0;
  if (res.status !== 200) return { ok: false, ms, why: `HTTP ${res.status}` };
  if (!body.includes('__SP_EP__')) return { ok: false, ms, why: `200 但正文不是应用页（${body.length}B）` };
  return { ok: true, ms, bytes: body.length };
}

async function oneIntake() {
  const t0 = performance.now();
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'intake', raw_input: RAW_INPUT }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  if (res.status !== 200) return { ok: false, ms, why: `HTTP ${res.status}` };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, ms, why: '200 但不是 JSON' };
  }
  if (data.ok !== true || !data.parsed) return { ok: false, ms, why: `ok=${data.ok}` };
  // 顺带守住极性：这条原文的正确答案是 no_persistence，读反了说明模型/校验回退了
  const caps = data.parsed.required_capabilities ?? [];
  if (!caps.includes('no_persistence')) return { ok: false, ms, why: `极性回退：caps=${JSON.stringify(caps)}` };
  return { ok: true, ms, elapsed_ms: data.elapsed_ms };
}

const run = MODE === 'intake' ? oneIntake : onePage;

console.log(`探针 ${MODE} × ${N} → ${URL_}`);
console.log(`网络标注：${LABEL}\n`);

const results = [];
for (let i = 1; i <= N; i++) {
  let r;
  try {
    r = await run();
  } catch (e) {
    r = { ok: false, ms: 0, why: e?.name === 'TimeoutError' ? `超时 >${TIMEOUT_MS}ms` : String(e?.message ?? e) };
  }
  results.push(r);
  const tag = r.ok ? 'ok  ' : 'FAIL';
  const detail = r.ok ? `${r.bytes ? r.bytes + 'B' : 'elapsed ' + r.elapsed_ms + 'ms'}` : r.why;
  console.log(`  #${String(i).padStart(2, '0')} ${tag} ${r.ms.toFixed(0).padStart(5)}ms  ${detail}`);
}

const okList = results.filter((r) => r.ok);
const fail = results.length - okList.length;
const rate = (fail / results.length) * 100;

const pct = (p) => {
  if (!okList.length) return NaN;
  const s = okList.map((r) => r.ms).sort((a, b) => a - b);
  // 最近秩法：小样本下比插值更诚实，不会给出一个"没被观测到"的延迟值
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

console.log(`\n── 汇总（${LABEL}）──`);
console.log(`  样本      ${results.length}`);
console.log(`  成功      ${okList.length}`);
console.log(`  失败      ${fail}`);
console.log(`  失败率    ${rate.toFixed(1)}%   ${rate > 5 ? '✗ 超过 5% 判据' : '✓ 在 5% 判据内'}`);
if (okList.length) {
  console.log(`  p50       ${pct(50).toFixed(0)}ms`);
  console.log(`  p95       ${pct(95).toFixed(0)}ms`);
  console.log(`  max       ${Math.max(...okList.map((r) => r.ms)).toFixed(0)}ms`);
}
if (fail) {
  const reasons = {};
  for (const r of results.filter((x) => !x.ok)) reasons[r.why] = (reasons[r.why] ?? 0) + 1;
  console.log('  失败原因：');
  for (const [k, v] of Object.entries(reasons)) console.log(`    ${v}×  ${k}`);
}

process.exit(rate > 5 ? 1 : 0);
