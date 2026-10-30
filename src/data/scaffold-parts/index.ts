/**
 * 组件片段库（v2.1.0）—— 骨架模板的**单一事实源**。
 * ------------------------------------------------------------------
 * 一份骨架资产，喂三个工具（见 docs/ROADMAP-v2.1.md）：
 *   scaffold_blueprint  发布可运行项目
 *   eval harness        AI 生成结果的期望基线（fixture）
 *   inspect_project     存量项目反查的"正确形态"基线
 *
 * 【按组件组织，不按组合】23 个 KB 组件里被 12 套组合引用的有 20 个
 * （BE-05 / DB-03 / DB-04 无组合使用，不写空转片段）。片段库 + 拼装器
 * 拼出全部 12 套，避免为每套组合手写一遍模板树。
 *
 * 【版本铁律】npm/pypi 依赖的版本号**只能**来自 src/data/facts-snapshot.json
 * （version_from 指向 entry_id）。快照里没有的依赖（如 next 的 peer react）
 * 必须写 version + peer_note，拼装器会在 build-info.json 里把它的溯源状态
 * 标成 "peer-estimate"——inspect 与测试都能断言"有 fact 的依赖必须精确锁定"。
 *
 * 【边界】片段只包含组合**声明过**的组件。DB-01/DB-02 是数据库本体，
 * 片段只给运行配置（docker-compose / .env），**不引入组合未声明的 ORM**；
 * AI-04 在 JS 侧用 fetch 封装，不引包。
 */

export interface ScaffoldDep {
  package: string;
  dev?: boolean;
  /** facts 快照的 entry_id（如 'FE-01'）。设置了它，版本号必须由拼装器从快照取 */
  version_from?: string;
  /** facts 没有的依赖才允许直接写版本，必须说明为什么（peer / 运行时配套） */
  version?: string;
  peer_note?: string;
}

export interface ScaffoldPart {
  component: string;
  /** npm 依赖（版本一律走拼装器的溯源管线，见 version_from） */
  deps: ScaffoldDep[];
  /** pypi 依赖：拼装器据此生成 requirements.txt，同样过溯源管线 */
  pyDeps?: ScaffoldDep[];
  /** 相对项目根的文件（path 用 / 分隔，内容为完整文件） */
  files: Record<string, string>;
  /** .env.example 逐行（不含注释行也可） */
  env?: string[];
}

const GITIGNORE = ['node_modules/', 'dist/', '.env', '.env.local', '*.local', '.DS_Store'].join('\n') + '\n';

/** 统一注入的基础文件（所有组合共有），{NAME}/{STEP}/{PITFALLS} 由拼装器替换 */
const README_TMPL = `# {{NAME}}

> 由 StackPilot \`scaffold_blueprint\` 确定性生成（组合 {{ID}}，最近复核于 {{REVIEWED}}）。
> 技术栈与目录结构来自闭集模板，请勿替换框架或引入清单外的依赖。

## 第一步

{{STEP}}

## 高频新手坑

{{PITFALLS}}

## 协作方式

- 一次只做一步，改完说明改了哪些文件、为什么。
- 需要 key / 账号 / 域名时先停下来问，不要自己编。
`;

// ────────────────────────────────────────────────────────────
// FE 片段
// ────────────────────────────────────────────────────────────

const FE_01: ScaffoldPart = {
  component: 'FE-01',
  deps: [
    { package: 'next', version_from: 'FE-01' },
    { package: 'react', version: '^19.0.0', peer_note: 'next 的 peer 依赖，facts 快照无条目' },
    { package: 'react-dom', version: '^19.0.0', peer_note: 'next 的 peer 依赖，facts 快照无条目' },
    { package: 'typescript', version: '^5.6.0', dev: true, peer_note: 'TS 项目运行时配套' },
    { package: '@types/node', version: '^22.0.0', dev: true, peer_note: 'TS 项目运行时配套' },
    { package: '@types/react', version: '^19.0.0', dev: true, peer_note: 'next 的 peer 依赖' },
  ],
  files: {
    'app/layout.tsx': `export const metadata = { title: 'StackPilot App' };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="zh-CN">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
    'app/page.tsx': `export default function Home() {\n  return <main style={{ padding: 40 }}><h1>项目已就绪</h1><p>按 README 的第一步继续。</p></main>;\n}\n`,
    'next.config.ts': `import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n`,
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022', lib: ['dom', 'dom.iterable', 'esnext'], allowJs: true, skipLibCheck: true,
          strict: true, noEmit: true, esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler',
          resolveJsonModule: true, isolatedModules: true, jsx: 'preserve', incremental: true,
          plugins: [{ name: 'next' }], paths: { '@/*': ['./*'] },
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      }, null, 2) + '\n',
  },
};

const FE_02: ScaffoldPart = {
  component: 'FE-02',
  deps: [
    { package: 'nuxt', version_from: 'FE-02' },
    { package: 'typescript', version: '^5.6.0', dev: true, peer_note: 'TS 项目运行时配套' },
  ],
  files: {
    'app/app.vue': `<template>\n  <main style="padding: 40px">\n    <h1>项目已就绪</h1>\n    <p>按 README 的第一步继续。</p>\n  </main>\n</template>\n`,
    'nuxt.config.ts': `export default defineNuxtConfig({\n  devtools: { enabled: false },\n});\n`,
    'tsconfig.json': `{\n  "extends": "./.nuxt/tsconfig.json"\n}\n`,
  },
};

const FE_03: ScaffoldPart = {
  component: 'FE-03',
  deps: [
    { package: '@sveltejs/kit', version_from: 'FE-03' },
    { package: 'svelte', version: '^5.0.0', peer_note: '@sveltejs/kit 的 peer 依赖，facts 快照无条目' },
    { package: 'vite', version: '^6.0.0', dev: true, peer_note: '@sveltejs/kit 的 peer 依赖（运行时 vite 版本以 kit 兼容矩阵为准）' },
    { package: '@sveltejs/adapter-static', version: '^3.0.0', peer_note: 'SvelteKit 静态输出配套' },
  ],
  files: {
    'src/routes/+page.svelte': `<main style="padding: 40px">\n  <h1>项目已就绪</h1>\n  <p>按 README 的第一步继续。</p>\n</main>\n`,
    'src/app.html': `<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="utf-8" />\n    %sveltekit.head%\n  </head>\n  <body data-sveltekit-preload-data="hover">\n    %sveltekit.body%\n  </body>\n</html>\n`,
    'svelte.config.js': `import adapter from '@sveltejs/adapter-static';\n\nexport default {\n  kit: { adapter: adapter({ fallback: 'index.html' }) },\n};\n`,
    'vite.config.ts': `import { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({ plugins: [sveltekit()] });\n`,
  },
};

const FE_04: ScaffoldPart = {
  component: 'FE-04',
  deps: [
    { package: 'vite', version_from: 'FE-04' },
    { package: 'react', version: '^19.0.0', peer_note: 'vite+react 运行时配套，facts 快照无条目' },
    { package: 'react-dom', version: '^19.0.0', peer_note: 'vite+react 运行时配套，facts 快照无条目' },
    { package: '@vitejs/plugin-react', version: '^4.3.0', peer_note: 'vite react 插件运行时配套' },
    { package: 'typescript', version: '^5.6.0', dev: true, peer_note: 'TS 项目运行时配套' },
  ],
  files: {
    'index.html': `<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>StackPilot App</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
    'src/main.tsx': `import { createRoot } from 'react-dom/client';\nimport App from './App';\n\ncreateRoot(document.getElementById('root')!).render(<App />);\n`,
    'src/App.tsx': `export default function App() {\n  return <main style={{ padding: 40 }}><h1>项目已就绪</h1><p>按 README 的第一步继续。</p></main>;\n}\n`,
    'vite.config.ts': `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n`,
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022', lib: ['DOM', 'DOM.Iterable', 'ESNext'], module: 'ESNext', moduleResolution: 'bundler',
          jsx: 'react-jsx', strict: true, skipLibCheck: true, noEmit: true,
        },
        include: ['src'],
      }, null, 2) + '\n',
  },
};

const FE_05: ScaffoldPart = {
  component: 'FE-05',
  deps: [],
  files: {
    'project.config.json': JSON.stringify(
      { appid: 'touristappid', compileType: 'miniprogram', libVersion: 'latest', setting: { es6: true, minified: true } },
      null, 2) + '\n',
    'app.json': JSON.stringify({ pages: ['pages/index/index'], window: { navigationBarTitleText: 'StackPilot App' } }, null, 2) + '\n',
    'app.js': `App({});\n`,
    'app.wxss': `page { padding: 40rpx; }\n`,
    'pages/index/index.wxml': `<view class="main">\n  <text>项目已就绪，按 README 的第一步继续。</text>\n</view>\n`,
    'pages/index/index.js': `Page({});\n`,
    'pages/index/index.json': '{}\n',
  },
};

const FE_06: ScaffoldPart = {
  component: 'FE-06',
  deps: [
    { package: '@dcloudio/uni-app', version_from: 'FE-06', peer_note: 'uni-app 日期构建号，semver 不适用' },
    { package: 'vue', version: '^3.4.0', peer_note: 'uni-app Vue3 版运行时配套，facts 快照无条目' },
  ],
  files: {
    'src/pages.json': JSON.stringify({ pages: [{ path: 'pages/index/index' }], globalStyle: { navigationBarTitleText: 'StackPilot App' } }, null, 2) + '\n',
    'src/manifest.json': JSON.stringify({ name: 'StackPilot App', appid: '', 'mp-weixin': { appid: 'touristappid' } }, null, 2) + '\n',
    'src/pages/index/index.vue': `<template>\n  <view class="main">\n    <text>项目已就绪，按 README 的第一步继续。</text>\n  </view>\n</template>\n\n<script>\nexport default {};\n</script>\n`,
    'src/main.js': `import { createSSRApp } from 'vue';\nexport function createApp() {\n  const app = createSSRApp({ onLaunch() {} });\n  return { app };\n}\n`,
  },
};

// ────────────────────────────────────────────────────────────
// BE 片段（BE-01 与 FE 同进程；BE-02/03/04 为独立后端；BE-06 托管后端）
// ────────────────────────────────────────────────────────────

const BE_01: ScaffoldPart = {
  component: 'BE-01',
  deps: [],
  files: {
    'app/api/hello/route.ts': `export async function GET() {\n  return Response.json({ ok: true, message: '接口层已就绪' });\n}\n`,
  },
};

const BE_02: ScaffoldPart = {
  component: 'BE-02',
  deps: [{ package: 'hono', version_from: 'BE-02' }],
  files: {
    'src/index.ts': `import { Hono } from 'hono';\n\nconst app = new Hono();\n\napp.get('/api/hello', (c) => c.json({ ok: true, message: '接口层已就绪' }));\n\nexport default app;\n`,
    'wrangler.toml': `name = "stackpilot-api"\nmain = "src/index.ts"\ncompatibility_date = "2026-01-01"\n`,
  },
};

const BE_03: ScaffoldPart = {
  component: 'BE-03',
  deps: [],
  pyDeps: [
    { package: 'fastapi', version_from: 'BE-03' },
    { package: 'uvicorn', version: '0.37.0', peer_note: 'ASGI 运行时配套，facts 快照无条目' },
  ],
  files: {
    'main.py': `from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/api/hello")\ndef hello() -> dict:\n    return {"ok": True, "message": "接口层已就绪"}\n`,
  },
};

const BE_04: ScaffoldPart = {
  component: 'BE-04',
  deps: [
    { package: '@nestjs/core', version_from: 'BE-04' },
    { package: '@nestjs/common', version: '^12.0.0', peer_note: '与 @nestjs/core 同版发布，facts 快照无条目' },
    { package: '@nestjs/platform-express', version: '^12.0.0', peer_note: 'Nest 默认 HTTP 适配器' },
    { package: 'reflect-metadata', version: '^0.2.0', peer_note: 'Nest 装饰器运行时必需' },
    { package: 'rxjs', version: '^7.8.0', peer_note: 'Nest 运行时依赖' },
  ],
  files: {
    'src/main.ts': `import { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module';\n\nasync function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n  await app.listen(3000);\n}\n\nvoid bootstrap();\n`,
    'src/app.module.ts': `import { Module } from '@nestjs/common';\nimport { AppController } from './app.controller';\n\n@Module({ controllers: [AppController] })\nexport class AppModule {}\n`,
    'src/app.controller.ts': `import { Controller, Get } from '@nestjs/common';\n\n@Controller()\nexport class AppController {\n  @Get('/api/hello')\n  hello() {\n    return { ok: true, message: '接口层已就绪' };\n  }\n}\n`,
  },
};

const BE_06: ScaffoldPart = {
  component: 'BE-06',
  deps: [{ package: '@supabase/supabase-js', version_from: 'BE-06' }],
  files: {
    'lib/supabase.ts': `import { createClient } from '@supabase/supabase-js';\n\n/** 服务端用 service role key；浏览器端只用 anon key。密钥从环境变量读，禁止写死 */\nexport const supabase = createClient(\n  process.env.SUPABASE_URL ?? '',\n  process.env.SUPABASE_ANON_KEY ?? '',\n);\n`,
    'supabase/README.md': '# Supabase 迁移\n\n1. 在 Supabase 控制台建项目，拿 URL 与 anon key 填入 .env\n2. 上线前逐表开启 RLS（高频坑：表默认不开启，拿到 anon key 的任何人都能读写）\n',
  },
  env: ['SUPABASE_URL=', 'SUPABASE_ANON_KEY='],
};

// ────────────────────────────────────────────────────────────
// DB / AI / DP 片段
// ────────────────────────────────────────────────────────────

const DB_01: ScaffoldPart = {
  component: 'DB-01',
  deps: [],
  files: {
    'docker-compose.yml': `# PostgreSQL 本体（DB-01）的本地运行配置。组合未声明 ORM（DB-03/DB-04），\n# 访问层由实现时按需决定，本骨架不引入清单外的依赖。\nservices:\n  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_PASSWORD: dev\n      POSTGRES_DB: app\n    ports:\n      - "5432:5432"\n`,
    'db/README.md': '# 数据库\n\n`docker compose up -d` 启动本地 Postgres，连接串：`postgres://postgres:dev@localhost:5432/app`。\n',
  },
  env: ['DATABASE_URL=postgres://postgres:dev@localhost:5432/app'],
};

const DB_02: ScaffoldPart = {
  component: 'DB-02',
  deps: [
    {
      package: '@libsql/client',
      version: '^0.14.0',
      peer_note: '纯 JS/WASM 的 SQLite 客户端，facts 快照无条目。实测批次 2026-10-30-flash-v1 证明：AI 自选 better-sqlite3（原生编译）在 Windows 上 3 轮 install 全部编译失败——数据层只允许纯 JS 实现',
    },
  ],
  files: {
    'db/README.md': [
      '# SQLite（DB-02）',
      '',
      '**访问层已定：`@libsql/client`（纯 JS/WASM，零编译）。**',
      '',
      '## 禁止',
      '',
      '- **严禁引入需要 node-gyp 编译的原生依赖**（better-sqlite3、sqlite3、bcrypt 等）：',
      '  实测批次 2026-10-30-flash-v1 中，AI 自选 better-sqlite3 的项目在 Windows 上 3 轮 install 全部编译失败。',
      '- 连接串：`file:./dev.db`（见 .env.example）',
      '',
    ].join('\n'),
  },
  env: ['DATABASE_URL=file:./dev.db'],
};

const AI_01: ScaffoldPart = {
  component: 'AI-01',
  deps: [{ package: 'ai', version_from: 'AI-01' }],
  files: {
    'lib/ai.ts': `import { generateText } from 'ai';\n\n/** 模型凭据从环境变量读，禁止写死进仓库 */\nexport async function ask(prompt: string): Promise<string> {\n  const { text } = await generateText({\n    model: process.env.AI_MODEL ?? 'deepseek-chat',\n    prompt,\n  });\n  return text;\n}\n`,
  },
  env: ['AI_API_KEY=', 'AI_BASE_URL=https://api.deepseek.com', 'AI_MODEL=deepseek-chat'],
};

const AI_02: ScaffoldPart = {
  component: 'AI-02',
  deps: [{ package: '@langchain/langgraph', version_from: 'AI-02' }, { package: '@langchain/core', version: '^1.0.0', peer_note: 'langgraph 的 peer 依赖' }],
  files: {
    'lib/graph.ts': `import { StateGraph, Annotation, START } from '@langchain/langgraph';\n\nconst State = Annotation.Root({\n  input: Annotation<string>,\n  output: Annotation<string>,\n});\n\nconst chain = new StateGraph(State)\n  .addNode('echo', async (s) => ({ output: s.input }))\n  .addEdge(START, 'echo')\n  .compile();\n\nexport async function run(input: string): Promise<string> {\n  const r = await chain.invoke({ input });\n  return r.output;\n}\n`,
  },
  env: ['LLM_API_KEY=', 'LLM_BASE_URL=https://api.deepseek.com'],
};

const AI_03: ScaffoldPart = {
  component: 'AI-03',
  deps: [{ package: '@langchain/core', version_from: 'AI-03' }],
  files: {
    'src/lib/ai.ts': `import { ChatOpenAI } from '@langchain/openai';\n\nconst model = new ChatOpenAI({\n  modelName: process.env.LLM_MODEL ?? 'deepseek-chat',\n  configuration: { baseURL: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com' },\n});\n\nexport async function ask(prompt: string): Promise<string> {\n  const res = await model.invoke(prompt);\n  return String(res.content);\n}\n`,
  },
  env: ['LLM_API_KEY=', 'LLM_BASE_URL=https://api.deepseek.com', 'LLM_MODEL=deepseek-chat'],
};

const AI_04: ScaffoldPart = {
  component: 'AI-04',
  deps: [],
  files: {
    'lib/ai.ts': `/** 最薄的模型调用：直接 fetch，不引 SDK（组合 AI-04 的定义就是这一层不引入依赖） */\nexport async function ask(prompt: string): Promise<string> {\n  const base = process.env.LLM_BASE_URL ?? 'https://api.deepseek.com';\n  const res = await fetch(base + '/chat/completions', {\n    method: 'POST',\n    headers: {\n      'content-type': 'application/json',\n      authorization: \`Bearer \${process.env.LLM_API_KEY ?? ''}\`,\n    },\n    body: JSON.stringify({ model: process.env.LLM_MODEL ?? 'deepseek-chat', messages: [{ role: 'user', content: prompt }] }),\n  });\n  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };\n  return json.choices[0]?.message?.content ?? '';\n}\n`,
  },
  env: ['LLM_API_KEY=', 'LLM_BASE_URL=https://api.deepseek.com', 'LLM_MODEL=deepseek-chat'],
};

const DP_01: ScaffoldPart = {
  component: 'DP-01',
  deps: [{ package: 'vercel', version_from: 'DP-01', dev: true }],
  files: { 'vercel.json': JSON.stringify({ framework: null }, null, 2) + '\n', 'deploy/README.md': '# 部署（Vercel）\n\n`npx vercel` 首次部署，按提示关联项目。\n' },
};

const DP_02: ScaffoldPart = {
  component: 'DP-02',
  deps: [{ package: 'wrangler', version_from: 'DP-02', dev: true }],
  files: { 'deploy/README.md': '# 部署（Cloudflare Pages）\n\n`npx wrangler pages deploy dist`（dist 换成实际构建产物目录）。\n' },
};

const DP_03: ScaffoldPart = {
  component: 'DP-03',
  deps: [{ package: '@cloudbase/cli', version_from: 'DP-03', dev: true }],
  files: { 'deploy/README.md': '# 部署（腾讯云 CloudBase / 阿里云 FC）\n\n腾讯云：`npx cloudbase framework deploy`；阿里云 FC 按 Fun/YAML 规范配置。密钥走环境变量，禁止入库。\n' },
};

/** 全部片段。新组件必须同步登记（check-consistency 会断言"组合引用的组件都有片段"） */
export const SCAFFOLD_PARTS: Record<string, ScaffoldPart> = Object.fromEntries(
  [FE_01, FE_02, FE_03, FE_04, FE_05, FE_06, BE_01, BE_02, BE_03, BE_04, BE_06, DB_01, DB_02, AI_01, AI_02, AI_03, AI_04, DP_01, DP_02, DP_03].map(
    (p) => [p.component, p],
  ),
);

export { GITIGNORE, README_TMPL };
