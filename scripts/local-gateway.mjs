/**
 * 本地代理网关：真实 key 只留在你电脑上，线上产物只拿一个**可撤销的令牌**。
 *
 * 解决什么问题：
 *   如果非要用"不能注入环境变量"的平台，产物里就必须有个凭据。
 *   那就别放真 key，放一个只能穿过这台机器、随时能换掉的令牌。
 *
 *     线上 app  ──x-api-key: <GATEWAY_TOKEN>──▶  本机网关  ──x-api-key: <真 key>──▶  模型端点
 *
 * 这样即使产物被人扒了：
 *   - 拿到的是令牌，不是你的 key，模型账单不是直接漏的；
 *   - 令牌可以随时换（改一个环境变量重启网关），不用去模型后台轮换 key；
 *   - 你能在网关日志里看到**每一次**调用，包括来源 IP。
 *
 * 但它**不是免费的**，两条残余风险必须知道：
 *   ① 令牌在产物里，谁拿到产物谁就能用你的额度。所以加了每 IP 每分钟限流；
 *   ② 网关一旦公网可达（ngrok 之类），就是一个开放入口。所以默认只绑 127.0.0.1，
 *      要走公网必须显式 HOST=0.0.0.0，并且**务必换一个长随机令牌**。
 *
 * 用法：
 *   # 1) 本机起网关（终端 A）
 *   export UPSTREAM_API_KEY='真实的 key'
 *   export GATEWAY_TOKEN="$(openssl rand -hex 24)"   # 或 node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
 *   node scripts/local-gateway.mjs
 *
 *   # 2) 把网关暴露到公网（终端 B）
 *   ngrok http 8799
 *
 *   # 3) 线上 app 的两个环境变量（或用平台的 env 面板）
 *   ANTHROPIC_BASE_URL=https://<ngrok 域名>
 *   ANTHROPIC_API_KEY=<GATEWAY_TOKEN 的值>      # 注意：这不是真 key
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8799);
const HOST = process.env.HOST ?? '127.0.0.1';
const UPSTREAM = (
  process.env.UPSTREAM_BASE_URL ??
  process.env.ANTHROPIC_BASE_URL ??
  'https://api.deepseek.com/anthropic'
).replace(/\/$/, '');

// 真 key 只从这里读，且只在内存里用，不落盘、不进日志
const REAL_KEY = process.env.UPSTREAM_API_KEY ?? process.env.ANTHROPIC_API_KEY;
const TOKEN = process.env.GATEWAY_TOKEN;

// 每 IP 每分钟允许的请求数。定这个值不是防黑客，是防"令牌泄露后被人当免费 API 刷"。
const RATE_LIMIT = Number(process.env.GATEWAY_RATE_LIMIT ?? 30);
const TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS ?? 90_000);

if (!REAL_KEY) {
  console.error('  ✗ 缺少 UPSTREAM_API_KEY（真实 key）。这是给网关自己用的，不会传给线上。');
  process.exit(1);
}
if (!TOKEN || TOKEN.length < 16) {
  console.error('  ✗ 缺少 GATEWAY_TOKEN，或长度不足 16 位。');
  console.error('    生成一个：node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"');
  process.exit(1);
}
if (TOKEN === REAL_KEY) {
  console.error('  ✗ GATEWAY_TOKEN 不能等于真实 key —— 那就白折腾了。');
  process.exit(1);
}

// ── 限流：滑动窗口够用，不做精确计数 ────────────────────────────
const hits = new Map(); // ip -> { count, resetAt }
function allow(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  rec.count++;
  return rec.count <= RATE_LIMIT;
}
// 定期清掉过期记录，避免 Map 无限涨
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now > rec.resetAt) hits.delete(ip);
}, 60_000).unref();

const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() ||
  req.socket.remoteAddress ||
  'unknown';

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 512 * 1024) throw new Error('请求体过大');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const ip = clientIp(req);
  const started = Date.now();

  if (req.method === 'GET' && req.url === '/healthz') {
    // 不泄露上游地址和 key 的任何信息
    return json(res, 200, { ok: true, upstream: new URL(UPSTREAM).host });
  }

  if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
    return json(res, 404, { error: 'only POST /v1/messages' });
  }

  if (!allow(ip)) {
    console.log(`  429  ${ip}  超出限流（${RATE_LIMIT}/min）`);
    return json(res, 429, { error: 'rate limited' });
  }

  // 线上带过来的是令牌，必须**完全匹配**才放行
  if (String(req.headers['x-api-key'] ?? '') !== TOKEN) {
    console.log(`  401  ${ip}  令牌不对`);
    return json(res, 401, { error: 'bad gateway token' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const up = await fetch(`${UPSTREAM}/v1/messages`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        // 真 key 在这里替换进去。线上从来没见过它。
        'x-api-key': REAL_KEY,
        'anthropic-version': String(req.headers['anthropic-version'] ?? '2023-06-01'),
      },
      body,
    });

    const buf = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, {
      'content-type': up.headers.get('content-type') ?? 'application/json',
    });
    res.end(buf);

    const ms = Date.now() - started;
    console.log(`  ${up.status}  ${ip}  ${ms}ms  ${(buf.length / 1024).toFixed(1)}KB`);
  } catch (e) {
    const ms = Date.now() - started;
    const aborted = e?.name === 'AbortError';
    console.log(`  5xx  ${ip}  ${ms}ms  ${aborted ? '上游超时' : String(e?.message ?? e)}`);
    json(res, 502, { error: aborted ? 'upstream timeout' : 'upstream failed' });
  } finally {
    clearTimeout(timer);
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  本地代理网关已启动： http://${HOST}:${PORT}`);
  console.log(`  上游            ${UPSTREAM}`);
  console.log(`  令牌            已加载（长度 ${TOKEN.length}）—— 这个给线上用`);
  console.log(`  真实 key        已加载（长度 ${REAL_KEY.length}）—— 这个只在本机`);
  console.log(`  限流            ${RATE_LIMIT} 次/分钟/IP`);
  console.log('');
  if (HOST === '127.0.0.1') {
    console.log('  当前只绑 127.0.0.1，公网访问不到。要用 ngrok 暴露：');
    console.log(`    ngrok http ${PORT}`);
  } else {
    console.log('  ⚠️ 已绑到非本地地址，网关现在对公网可达。确认令牌是长随机值。');
  }
  console.log('');
});
