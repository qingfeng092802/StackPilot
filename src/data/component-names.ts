/**
 * 组件显示名（人话渲染用）
 * ------------------------------------------------------------------
 * 权威来源是 PRD 附录 A（种子知识库 23 条）。这里只是把 ID 翻成人话，
 * 给"输出侧验证材料"这类需要给真人看的地方用。
 *
 * 为什么不从 PRD 里解析：PRD 是 markdown 表格，解析规则一改就断，
 * 而且渲染失败时会静默退化成裸 ID，比复制一份更难发现。
 * 改为在 check-consistency 里断言"combos.json 用到的每个 ID 都在这里"，
 * 新增组件忘了登记就会红。
 */

export interface ComponentMeta {
  name: string;
  /** 在方案里承担的角色，一句话 */
  role: string;
}

export const COMPONENT_NAMES: Record<string, ComponentMeta> = {
  'FE-01': { name: 'Next.js', role: '前端框架（含服务端渲染能力）' },
  'FE-02': { name: 'Nuxt', role: '前端框架（Vue 系）' },
  'FE-03': { name: 'SvelteKit', role: '前端框架（Svelte 系）' },
  'FE-04': { name: 'Vite + React', role: '前端框架（纯客户端渲染）' },
  'FE-05': { name: '原生小程序', role: '小程序前端' },
  'FE-06': { name: 'uni-app', role: '多端前端框架' },

  'BE-01': { name: 'Next.js Route Handlers', role: '接口层（与前端同进程）' },
  'BE-02': { name: 'Hono', role: '轻量接口层（边缘运行时）' },
  'BE-03': { name: 'FastAPI', role: '独立后端服务（Python）' },
  'BE-04': { name: 'NestJS', role: '独立后端服务（分层架构）' },
  'BE-05': { name: 'Spring Boot', role: '独立后端服务（Java）' },
  'BE-06': { name: 'Supabase', role: '托管后端（登录 / 数据库 / 存储）' },

  'DB-01': { name: 'PostgreSQL', role: '关系型数据库' },
  'DB-02': { name: 'SQLite', role: '单文件数据库' },
  'DB-03': { name: 'Drizzle ORM', role: '数据库访问层' },
  'DB-04': { name: 'Prisma', role: '数据库访问层' },

  'AI-01': { name: 'Vercel AI SDK', role: '模型调用封装' },
  'AI-02': { name: 'LangGraph', role: '多步 Agent 编排' },
  'AI-03': { name: 'LangChain', role: '模型调用链' },
  'AI-04': { name: '直接调模型 API', role: '最薄的模型调用' },

  'DP-01': { name: 'Vercel', role: '托管部署' },
  'DP-02': { name: 'Cloudflare Pages', role: '静态 / 边缘托管部署' },
  'DP-03': { name: '腾讯云 CloudBase / 阿里云 FC', role: '国内云托管部署' },
};

/** 把组件槽位翻成人话；null 表示这套方案在这一层是空的 */
export const SLOT_LABELS: Record<string, string> = {
  fe: '前端',
  be: '接口层',
  db: '数据库',
  ai: 'AI 层',
  deploy: '部署',
};

export function componentLabel(id: string | null | undefined): string {
  if (id === null || id === undefined) return '（不需要）';
  const meta = COMPONENT_NAMES[id];
  return meta ? `${meta.name}（${id}）` : `⚠️ 未登记组件 ${id}`;
}
