/**
 * M3 前端渲染的本地服务（零依赖，只用 node:http）。
 *
 * 为什么不用 Next.js / Vite：
 *   项目至今没有 package.json、没有任何 node_modules，全靠 `npx tsx` 跑。
 *   为了一个渲染页引入整套构建链，会把"改一行代码就能看效果"变成"等 30 秒热更新"，
 *   而且 M3 要验证的是**渲染结构**，不是构建工具。等真要上线再换框架不迟。
 *
 * 路由：
 *   GET  /                      → web/index.html
 *   GET  /styles.css, /app.js   → 静态资源
 *   GET  /api/demo?state=...    → 用冻结的真实交付包跑一遍完整 SSE（不调模型）
 *   POST /api/intake            → 大白话 → ConstraintVector + missing + 追问（普通 JSON，不是 SSE）
 *   POST /api/plan              → 真实链路：rank → explain → SSE 分模块下发
 *
 * 部署形态（`SP_SINGLE_PATH=1`）：
 *   上面五条路由会被折叠成 `GET /` + `POST /`（body.action 分发）。
 *   原因见下方「单路径模式」一节——不是设计选择，是某些网关会把路径改写成 `/`。
 *   折叠后业务逻辑不变，只是"请求怎么进来"变了。
 *
 * 为什么 /api/intake 不用 SSE：
 *   它要返回的是一组**互相依赖**的东西——缺了哪几个字段，才决定问哪几个问题。
 *   边流边渲染就等于"问题还没定就先画了一半"，没有意义。
 *   而且它快（单次模型调用，约 2–3s），不像 /api/plan 要等 5s 需要心跳。
 *
 * SSE 事件（前端只认这 6 种）：
 *   meta      方案身份 + confidence 三态（最先到，用户立刻知道"给了什么"）
 *   progress  模型调用期间的心跳（elapsed_ms），避免用户盯着空白屏
 *   module    一个模块的完整内容，带 module / seq 字段
 *   blocked   不出方案（low_confidence / uncovered / insufficient_candidates）
 *   done      结束，带 source（llm / fallback）、attempts、latency_ms
 *   error     服务端异常
 *
 * 启动：
 *   npx tsx server/index.ts
 *   PORT=8787 npx tsx server/index.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import combosRaw from '../src/data/combos.json' with { type: 'json' };
import { rank } from '../src/lib/scoring.ts';
import type { Combo, ConstraintVector } from '../src/lib/scoring.ts';
import { AnthropicProvider, MockProvider } from '../src/lib/explain/provider.ts';
import type { LLMProvider } from '../src/lib/explain/provider.ts';
import { buildExplainContext, explain } from '../src/lib/explain/index.ts';
import type { ExplanationPackage } from '../src/lib/explain/types.ts';
import { intake } from '../src/lib/intake/index.ts';
import { buildBlockedPayload, buildMeta, buildPlanPayload } from './view-model.ts';

const combos = (combosRaw as any).combos as Combo[];

/**
 * 项目根目录：**按本文件位置算，不按 cwd 算**。
 *
 * 原来写的是 `resolve(process.cwd(), 'web')`，本地跑没问题，因为 `npx tsx server/index.ts`
 * 的 cwd 就是项目根。但部署到 PaaS 后有两种启动方式（`npm start` 从根目录跑、
 * 或平台从别处拉起），cwd 不一定还是根目录——那时 web/ 和 fixtures 全部 404，
 * 表现是"服务起来了但页面 404"，而且日志里什么错都没有。
 *
 * `import.meta.url` 指向**本文件**：源码态是 `<root>/server/index.ts`，
 * 打包后是 `<root>/build/server.js`，两种都是往上退一层就是根。
 * 这也是为什么打包产物能放在 build/ 里而不必把 web/ 复制过去。
 */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = resolve(PROJECT_ROOT, 'web');
const PORT = Number(process.env.PORT ?? 8787);
/**
 * 默认绑 0.0.0.0 而不是 localhost。
 *
 * 本地开发时两者没区别（0.0.0.0 也接受 127.0.0.1），但部署到容器/沙箱时，
 * 只监听 127.0.0.1 的进程在反向代理外面**根本不可达**，表现是"部署成功但打不开"。
 * 这种问题在本地永远复现不出来，所以默认值直接按部署环境给。
 */
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * 模块之间的下发间隔。
 *
 * 必须说清楚：这不是模型的产出节奏，是**为了让"增量出现"看得见**而加的节奏。
 * 为什么不做真流式：validate() 是**全有或全无**的——它要拿到完整 JSON 才能判
 * "坑有没有编、combo_id 有没有被换"。边流边渲染就等于把未校验的内容交给用户，
 * 直接违反 M1 定的"绝不把未通过校验的内容交给用户"。
 * 所以这里的分块边界是**模块边界**，不是 token 边界。
 */
const MODULE_STAGGER_MS = Number(process.env.M3_MODULE_STAGGER_MS ?? 180);

// ────────────────────────────────────────────────────────────
// 启动自检：环境变量
// ────────────────────────────────────────────────────────────

/**
 * 缺 key 就**立刻退出**，不做降级。
 *
 * 解释层本来有兜底：没 key 就退回模板文案。那在本地开发时是好事——
 * 改个渲染结构不用等模型。但把这个行为带上线是错的，两个理由：
 *
 *   ① 它把"配置错了"伪装成"产品就长这样"。用户看到干巴巴的模板句子，
 *      你以为是模型稳定，其实一次都没调通。
 *   ② 更危险的反面：为了让"没 key 也能跑"，很容易滑向"把 key 写进代码当默认值"。
 *      那正是这次迁移要根除的东西。所以宁可起不来。
 *
 * 报错必须包含"缺哪个 + 去哪配"，否则新手只会看到一句 exit 1 和空屏幕。
 */
function assertEnv(): void {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    console.error('');
    console.error('  ✗ 启动失败：缺少环境变量 ANTHROPIC_API_KEY');
    console.error('');
    console.error('    本地：在项目根放 .env.local（不要提交），然后');
    console.error('          node --env-file=.env.local build/server.js');
    console.error('    线上：在平台的环境变量面板里配置，不要写进代码或仓库');
    console.error('');
    process.exit(1);
  }

  // 端点也走环境变量。没配就用官方端点，但**打出来**——
  // 配错 base url 的典型表现是 401/404，而日志里根本看不出你打的是哪个地址。
  const base = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const model = process.env.ANTHROPIC_MODEL ?? '(端点默认)';
  // 只打后 4 位：能确认"加载的是我粘的那把"，又不至于把凭据写进日志
  const tail = key.length > 4 ? key.slice(-4) : '****';
  console.log(`  key   已加载（…${tail}，长度 ${key.length}）`);
  console.log(`  端点  ${base}`);
  console.log(`  模型  ${model}`);
}

assertEnv();

// ────────────────────────────────────────────────────────────
// SSE 基础
// ────────────────────────────────────────────────────────────

interface SseCtx {
  res: ServerResponse;
  closed: boolean;
}

function openSse(req: IncomingMessage, res: ServerResponse): SseCtx {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // 反代（nginx 等）不加这句会把流缓冲起来，SSE 就变成"最后一次性吐出"
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();
  const ctx: SseCtx = { res, closed: false };
  req.on('close', () => {
    ctx.closed = true;
  });
  return ctx;
}

function send(ctx: SseCtx, event: string, data: unknown) {
  if (ctx.closed || ctx.res.writableEnded) return;
  ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────
// 演示数据：H06 的真实交付包（冻结于 2026-10-24，M1 结项那一轮）
// ────────────────────────────────────────────────────────────

const H06_RAW_INPUT =
  '上班路上爱听广播，但经常听一半就到公司了；干活时也想听点新鲜的。我想做个网页：打开按一下就随机掉进世界上某个城市的电台，' +
  '同一个浏览器下次打开能接着上次听；按「下一站」随机换台，能只听高码率；能读到曲名的直接显示，读不到的点一下就识别；' +
  '收藏的歌能跳到音乐 App 去搜。星图按流派铺开可以拖着逛，也有地球视图。不要账号、不要广告，收藏只存浏览器里。';

/** H06 原始标注（6/9 字段有值 → medium） */
const VEC_MEDIUM: ConstraintVector = {
  delivery: 'web',
  team_size: '1',
  skills: { js: 0.8, python: 0.1, sql: 0.4, ops: 0.3 },
  timeline_weeks: null,
  budget_cny_month: null,
  expected_users: null,
  required_capabilities: [],
  compliance: [],
  goal_type: 'product',
} as ConstraintVector;

/** 补齐 3 个缺失项 → high。Top1 仍是 C01，所以可以复用同一份冻结交付包 */
const VEC_HIGH: ConstraintVector = {
  ...VEC_MEDIUM,
  timeline_weeks: 8,
  budget_cny_month: 0,
  expected_users: 200,
} as ConstraintVector;

/** 只给 2 个字段 → 核心组缺 skills / required_capabilities + 补充组全空 → low，直接阻断 */
const VEC_LOW: ConstraintVector = {
  delivery: 'web',
  team_size: '1',
  skills: null,
  timeline_weeks: null,
  budget_cny_month: null,
  expected_users: null,
  required_capabilities: null,
  compliance: null,
  goal_type: null,
} as ConstraintVector;

let frozenPkg: ExplanationPackage | null = null;
async function loadFrozen(): Promise<ExplanationPackage> {
  if (frozenPkg) return frozenPkg;
  const raw = await readFile(join(PROJECT_ROOT, 'tests/fixtures/plan-H06.json'), 'utf8');
  frozenPkg = JSON.parse(raw) as ExplanationPackage;
  return frozenPkg;
}

// ────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────

interface PlanRequest {
  raw_input?: string;
  vector: ConstraintVector;
  /** 'mock' 用于前端联调，不烧 token */
  provider?: 'auto' | 'mock';
}

function pickProvider(kind: PlanRequest['provider']): LLMProvider {
  return kind === 'mock' ? new MockProvider() : new AnthropicProvider();
}

async function runPlan(ctx: SseCtx, body: PlanRequest) {
  const started = Date.now();
  const rawInput = body.raw_input ?? '';

  const r = rank(combos, body.vector, { raw_input: rawInput });

  // 不出方案：低置信度 / 超出范围 / 候选不足。三种都不调模型。
  // low 直接阻断是 M3 的 UI 决策 ③——兑现 M0 立的"不知道绝不当懂王"。
  if (!r.ok) {
    send(ctx, 'blocked', buildBlockedPayload(r));
    send(ctx, 'done', { source: 'engine', attempts: 0, latency_ms: Date.now() - started });
    return ctx.res.end();
  }

  const explainCtx = buildExplainContext(r, combos, body.vector);

  // meta 先发：rank 是同步的，用户不用等模型就知道"引擎选了哪套、要不要打警告条"
  send(ctx, 'meta', buildMeta(r, combos));

  // 模型调用期间的心跳。没有它，5 秒的空白屏会被当成"卡死了"。
  const beat = setInterval(() => {
    send(ctx, 'progress', { elapsed_ms: Date.now() - started, stage: 'explaining' });
  }, 700);

  let res;
  try {
    res = await explain({ context: explainCtx, provider: pickProvider(body.provider), maxAttempts: 2 });
  } finally {
    clearInterval(beat);
  }

  const finalPlan = buildPlanPayload(r, res.pkg, combos);

  for (const m of finalPlan.modules) {
    if (ctx.closed) return ctx.res.end();
    send(ctx, 'module', m);
    if (MODULE_STAGGER_MS > 0) await sleep(MODULE_STAGGER_MS);
  }

  send(ctx, 'done', {
    source: res.source,
    attempts: res.attempts,
    latency_ms: Date.now() - started,
    // 被拦下的校验问题只进控制台，不进 UI——用户不需要看校验日志
    issues: res.issues.map((i) => i.code),
  });
  ctx.res.end();
}

async function runDemo(ctx: SseCtx, state: string) {
  const started = Date.now();
  const vec = state === 'high' ? VEC_HIGH : state === 'low' ? VEC_LOW : VEC_MEDIUM;
  const r = rank(combos, vec, { raw_input: H06_RAW_INPUT });

  if (!r.ok) {
    // demo_vector 随包下发，前端用它把左侧表单回填成同一份数据，避免左右不一致
    send(ctx, 'blocked', { ...buildBlockedPayload(r), demo_vector: vec });
    send(ctx, 'done', { source: 'demo', attempts: 0, latency_ms: Date.now() - started });
    return ctx.res.end();
  }

  const pkg = await loadFrozen();
  if (pkg.combo_id !== r.top1.id) {
    // 冻结包和当前引擎结论不一致时必须报错，不能张冠李戴地把 C01 的文案套在别的方案上
    send(ctx, 'error', { message: `演示数据与引擎结论不一致：fixture=${pkg.combo_id}，引擎=${r.top1.id}` });
    return ctx.res.end();
  }

  const plan = buildPlanPayload(r, pkg, combos);
  send(ctx, 'meta', { ...plan.meta, demo_vector: vec });
  await sleep(320); // 让"方案身份先出现、内容后到"这个顺序在视觉上成立
  for (const m of plan.modules) {
    if (ctx.closed) return ctx.res.end();
    send(ctx, 'module', m);
    if (MODULE_STAGGER_MS > 0) await sleep(MODULE_STAGGER_MS);
  }
  send(ctx, 'done', { source: 'demo', attempts: 0, latency_ms: Date.now() - started });
  ctx.res.end();
}

// ────────────────────────────────────────────────────────────
// 静态资源 + 路由
// ────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(res: ServerResponse, pathname: string) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = normalize(join(WEB_DIR, rel));
  // 目录穿越防护：解析后必须仍在 web/ 里
  if (!full.startsWith(WEB_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const buf = await readFile(full);
    res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new Error('请求体过大');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

// ────────────────────────────────────────────────────────────
// 解析层：大白话 → 约束向量 + 追问
// ────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/**
 * 解析失败**不抛 500**，而是 200 + ok:false。
 *
 * 这两件事必须分开：
 *   ok:false  → "我没读懂你的话" —— 前端的正确反应是把手动填表展开，用户继续能用；
 *   500       → "服务挂了"     —— 前端的正确反应是报错。
 * 混成一个状态码，前端就只能写"出错了，刷新试试"，把一个可恢复的降级路径弄没了。
 */
async function runIntake(res: ServerResponse, raw: string) {
  const started = Date.now();
  const r = await intake({ raw_input: raw, provider: new AnthropicProvider() });
  sendJson(res, 200, { ...r, raw_input: raw, elapsed_ms: Date.now() - started });
}

// ────────────────────────────────────────────────────────────
// 三个 handler（多路径模式与单路径模式共用，只差"怎么被调进来"）
// ────────────────────────────────────────────────────────────

/** 读 body；失败时已经写好 400 响应，调用方直接 return 即可。 */
async function readBodyOr400(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ ok: true; body: any } | { ok: false }> {
  try {
    return { ok: true, body: await readJsonBody(req) };
  } catch (e) {
    sendJson(res, 400, { error: `请求体解析失败：${(e as Error).message}` });
    return { ok: false };
  }
}

async function routeIntake(res: ServerResponse, body: any) {
  const raw = String(body?.raw_input ?? '').trim();
  if (raw.length < 4) {
    sendJson(res, 400, { error: '描述太短了，至少写一句话（比如"想做个记账的小程序"）' });
    return;
  }
  await runIntake(res, raw);
}

async function routePlan(req: IncomingMessage, res: ServerResponse, body: any) {
  if (!body?.vector || typeof body.vector !== 'object') {
    sendJson(res, 400, { error: '缺少 vector 字段' });
    return;
  }
  const ctx = openSse(req, res);
  try {
    await runPlan(ctx, body as PlanRequest);
  } catch (e) {
    send(ctx, 'error', { message: String((e as Error)?.message ?? e).slice(0, 300) });
    res.end();
  }
}

async function routeDemo(req: IncomingMessage, res: ServerResponse, state: string) {
  const ctx = openSse(req, res);
  try {
    await runDemo(ctx, state);
  } catch (e) {
    send(ctx, 'error', { message: String((e as Error)?.message ?? e).slice(0, 300) });
    res.end();
  }
}

// ────────────────────────────────────────────────────────────
// 单路径模式（部署适配层，不是功能）
// ────────────────────────────────────────────────────────────

/**
 * 为什么需要它：
 *   有些部署平台的网关会把**任意路径重写成 `/`** 再转发给后端。实测（WorkBuddy 分享链接）：
 *   `GET /api/demo`、`GET /a/b/c.js`、`POST /api/intake` 到 Node 时 `req.url` 全是 `"/"`，
 *   连 `?state=high` 的查询串也一起没了（网关自己 rewrite，不是 Node 的问题）。
 *   表现是"部署成功、首页能开、但所有接口和静态资源都返回 index.html"。
 *
 * 这确实不是应用的问题，但它是**部署的**问题，所以只能在部署这一层解：
 *   设 `SP_SINGLE_PATH=1` 后，整个应用折叠成两个入口——
 *     GET  /  → 一个把 CSS/JS 全部内联的 HTML（不再产生任何子资源请求）
 *     POST /  → 按 body.action 分发到 intake / plan / demo
 *   网关再怎么改写路径，改写结果都是 `/`，于是恰好就是我们要的。
 *
 * 折叠的代价（写清楚，别装作没有）：
 *   ① 首屏变成一个约 55 KB 的单文档，CSS/JS 无法被浏览器单独缓存；
 *   ② 三个接口共用同一个 URL，只能靠 body.action 区分，不再符合 REST 直觉；
 *   ③ 线上只有一条路径，排查时必须记住这一点。
 *   所以它**默认关闭**，只有确认网关吃路径时才开。业务逻辑一行没变。
 */
const SINGLE_PATH = process.env.SP_SINGLE_PATH === '1';

const EP_SINGLE = { single: true, intake: '/', plan: '/', demo: '/' };

let inlinedHtml: string | null = null;

/**
 * 把 index.html / styles.css / app.js 合成一个单文档。
 *
 * 三道断言都必须过，否则**直接抛错**：宁可让部署失败，也不要静默返回一个
 * "样式全丢、脚本没跑"的页面——那种页面看起来是好的，排查起来最费时间。
 */
async function buildInlinedHtml(): Promise<string> {
  const [html, css, js] = await Promise.all([
    readFile(join(WEB_DIR, 'index.html'), 'utf8'),
    readFile(join(WEB_DIR, 'styles.css'), 'utf8'),
    readFile(join(WEB_DIR, 'app.js'), 'utf8'),
  ]);

  const cssTag = '<link rel="stylesheet" href="/styles.css">';
  const jsTag = '<script src="/app.js"></script>';
  if (!html.includes(cssTag)) throw new Error(`单路径模式：index.html 里找不到 ${cssTag}`);
  if (!html.includes(jsTag)) throw new Error(`单路径模式：index.html 里找不到 ${jsTag}`);
  // 内联进 <script>/<style> 的内容里若出现闭合标签会提前截断文档
  if (/<\/script/i.test(js)) throw new Error('单路径模式：app.js 里出现 </script，无法安全内联');
  if (/<\/style/i.test(css)) throw new Error('单路径模式：styles.css 里出现 </style，无法安全内联');

  const ep = `<script>window.__SP_EP__=${JSON.stringify(EP_SINGLE)};</script>`;
  return html.replace(cssTag, `<style>\n${css}\n</style>`).replace(jsTag, `${ep}\n<script>\n${js}\n</script>`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  // 诊断用：确认响应真的来自这个 Node 进程，而不是前面的网关/静态托管。
  // 部署排查时这一行能省掉一整轮"到底是服务没起还是路由不对"的猜测。
  res.setHeader('x-stackpilot', 'boot');

  try {
    // ── 单路径模式：只有 GET / 和 POST / ──────────────────
    if (SINGLE_PATH) {
      if (req.method === 'GET') {
        inlinedHtml ??= await buildInlinedHtml();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(inlinedHtml);
        return;
      }
      if (req.method === 'POST') {
        const r = await readBodyOr400(req, res);
        if (!r.ok) return;
        const action = r.body?.action;
        if (action === 'intake') return await routeIntake(res, r.body);
        if (action === 'plan') return await routePlan(req, res, r.body);
        if (action === 'demo') return await routeDemo(req, res, String(r.body?.state ?? 'medium'));
        sendJson(res, 400, {
          error: `单路径模式必须带 action（intake / plan / demo），收到 ${JSON.stringify(action)}`,
        });
        return;
      }
      res.writeHead(405).end('method not allowed');
      return;
    }

    // ── 多路径模式（本地开发 / 正常平台）──────────────────
    if (req.method === 'POST' && url.pathname === '/api/intake') {
      const r = await readBodyOr400(req, res);
      if (!r.ok) return;
      await routeIntake(res, r.body);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/plan') {
      const r = await readBodyOr400(req, res);
      if (!r.ok) return;
      await routePlan(req, res, r.body);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/demo') {
      await routeDemo(req, res, url.searchParams.get('state') ?? 'medium');
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(res, url.pathname);
      return;
    }

    res.writeHead(405).end('method not allowed');
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`server error: ${(e as Error).message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`M3 渲染页已启动： http://localhost:${PORT}  （绑定 ${HOST}:${PORT}）`);
  if (SINGLE_PATH) {
    console.log('  模式: 单路径折叠（SP_SINGLE_PATH=1）—— GET / 出内联页面，POST / 按 action 分发');
  } else {
    console.log(`  演示（不调模型）: http://localhost:${PORT}/?demo=medium   （high / medium / low 三态）`);
    console.log(`  真实链路: 页面顶部用大白话描述需求 → POST /api/intake → 追问 → POST /api/plan（需 ANTHROPIC_API_KEY）`);
  }
  console.log(`  模块间隔: ${MODULE_STAGGER_MS}ms（M3_MODULE_STAGGER_MS 可调，0 为不间隔）`);
});
