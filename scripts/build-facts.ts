/**
 * 构建期事实快照（对应 PRD v0.4 §6.5）
 * ------------------------------------------------------------------
 * 运行：node --experimental-strip-types scripts/build-facts.ts
 * 产出：src/data/facts-snapshot.json
 *
 * 为什么不在请求链路里跑：
 *   1. Serverless 实例闲置几分钟即销毁，内存缓存存不住 24h
 *   2. 候选池是固定闭集（23 条），没必要让用户等 60 秒去查 npm
 *   3. GitHub 未认证额度 60 次/小时，单次生成 20-30 次调用 → 每小时只能服务 2-3 人
 *
 * 建议接入 GitHub Actions，每日 03:00 跑一次并把产物提交回仓库。
 */
import { writeFileSync } from 'node:fs';
import {
  resolveNpm, resolvePyPI, resolveMaven, resolveDateBuild, resolveGithub,
  type FactRecord, type GithubFact, type FactsSnapshot,
} from '../src/lib/facts/index.ts';

const KB_VERSION = '1.0.0';

/** KB 清单：只列需要查事实层的组件（23 条中的 21 条，FE-05/BE-01 无独立包） */
const MANIFEST: Array<{
  entry_id: string;
  npm?: string;
  pypi?: string;
  maven?: [string, string];
  dateBuild?: string;
  github?: string;
}> = [
  { entry_id: 'FE-01', npm: 'next', github: 'vercel/next.js' },
  { entry_id: 'FE-02', npm: 'nuxt', github: 'nuxt/nuxt' },
  { entry_id: 'FE-03', npm: '@sveltejs/kit', github: 'sveltejs/kit' },
  { entry_id: 'FE-04', npm: 'vite', github: 'vitejs/vite' },
  { entry_id: 'FE-06', dateBuild: '@dcloudio/uni-app' },
  { entry_id: 'BE-02', npm: 'hono' },
  { entry_id: 'BE-03', pypi: 'fastapi' },
  { entry_id: 'BE-04', npm: '@nestjs/core', github: 'nestjs/nest' },
  { entry_id: 'BE-05', maven: ['org.springframework.boot', 'spring-boot-starter-parent'], github: 'spring-projects/spring-boot' },
  { entry_id: 'BE-06', npm: '@supabase/supabase-js', github: 'supabase/supabase' },
  { entry_id: 'DB-03', npm: 'drizzle-orm' },
  { entry_id: 'DB-04', npm: 'prisma' },
  { entry_id: 'AI-01', npm: 'ai' },
  { entry_id: 'AI-02', npm: '@langchain/langgraph', pypi: 'langgraph', github: 'langchain-ai/langgraph' },
  { entry_id: 'AI-03', npm: '@langchain/core', pypi: 'langchain' },
  { entry_id: 'AI-04', pypi: 'openai' },
  { entry_id: 'DP-01', npm: 'vercel' },
  { entry_id: 'DP-02', npm: 'wrangler' },
  { entry_id: 'DP-03', npm: '@cloudbase/cli' },
];

const TOKEN = process.env.GITHUB_TOKEN;

async function main() {
  const records: FactRecord[] = [];
  const github: GithubFact[] = [];

  for (const m of MANIFEST) {
    const tasks: Promise<any>[] = [];
    if (m.npm) tasks.push(resolveNpm(m.entry_id, m.npm));
    if (m.pypi) tasks.push(resolvePyPI(m.entry_id, m.pypi));
    if (m.maven) tasks.push(resolveMaven(m.entry_id, m.maven[0], m.maven[1]));
    if (m.dateBuild) tasks.push(resolveDateBuild(m.entry_id, m.dateBuild));
    if (m.github) tasks.push(resolveGithub(m.github, TOKEN).then((g) => { github.push(g); }));

    const out = await Promise.all(tasks);
    for (const r of out) if (r && r.entry_id) records.push(r as FactRecord);

    const label = m.npm ?? m.pypi ?? m.maven?.[1] ?? m.dateBuild ?? '';
    const mine = records.filter((r) => r.entry_id === m.entry_id);
    const brief = mine.map((r) => `${r.ecosystem}=${r.version ?? 'null'}${r.fail_reason ? `(${r.fail_reason})` : ''}`).join(' ');
    console.log(`  ${m.entry_id.padEnd(6)} ${label.padEnd(34)} ${brief}`);
  }

  const failed = records.filter((r) => r.fail_reason).length;
  const conflicts = records.filter((r) => r.conflict).length;

  const snapshot: FactsSnapshot = {
    generated_at: new Date().toISOString().slice(0, 10),
    kb_version: KB_VERSION,
    records,
    github,
    stats: { total: records.length, ok: records.length - failed, failed, conflicts },
  };

  writeFileSync(
    new URL('../src/data/facts-snapshot.json', import.meta.url),
    JSON.stringify(snapshot, null, 2),
    'utf8'
  );

  console.log(`\n共 ${records.length} 条事实记录，成功 ${records.length - failed}，失败 ${failed}，冲突 ${conflicts}`);
  console.log(`GitHub 活跃度 ${github.length} 条`);
  console.log('→ src/data/facts-snapshot.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
