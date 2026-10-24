/**
 * LLM Provider 抽象。
 *
 * 三个实现，用途完全不同：
 *   anthropic —— 真跑。走 Anthropic Messages 协议（DeepSeek 的 /anthropic 端点兼容这套）。
 *   mock      —— 管道自测。返回一份**手写的、格式正确的**响应，用来验证
 *                "解析 → 校验 → 渲染"这条链路本身没坏。它不代表任何模型的能力。
 *   broken    —— 对抗测试。故意返回"编造的坑 + 废话第一步"，用来证明校验器真的会拦。
 *
 * 为什么不用 SDK：项目零依赖（连 package.json 都没有，全靠 `npx tsx` 跑）。
 * 引一个 SDK 会带进一堆 node_modules，而这里只需要一个 fetch。
 */

import type { ExplainContext } from './types.ts';
import { invertWhenToLeave } from './fallback.ts';

export interface LLMResponse {
  text: string;
  usage?: { input_tokens: number; output_tokens: number };
  /** 端点给的停止原因。'max_tokens' 意味着输出被截断，调用方必须单独处理 */
  stopReason?: string;
  /** 响应里出现过 thinking 块（用于诊断"text 为空"这类问题） */
  hadThinking?: boolean;
}

export interface LLMProvider {
  name: string;
  /** 凭据/端点是否就绪。false 时不发请求，直接走兜底 */
  available(): boolean;
  /** 不可用的原因，用于日志与汇报 */
  unavailableReason(): string;
  /**
   * `ctx` 是给 MockProvider 用的（它要拿真实上下文才能手写一份合规输出）。
   * 真实 provider 只用 system + user，所以标成可选——
   * 解析层（F1）没有 ExplainContext，硬要它传一个只能靠 `undefined as any` 糊过去，
   * 那种 as any 迟早会把"参数传错了"变成运行时才炸的 bug。
   */
  complete(req: { system: string; user: string; ctx?: ExplainContext }): Promise<LLMResponse>;
}

/**
 * Anthropic Messages 协议（DeepSeek 的 /anthropic 端点走同一套）
 *
 * 【踩过的坑 · 2026-10-23】第一次接 deepseek-flash 时 7 条用例 6 条 JSON 解析失败，
 * 日志只写"JSON 解析失败：Unexpected end of JSON input"，看起来像模型不会写 JSON。
 * 实际原因是：这个模型默认开 thinking，返回 `content: [thinking, text]`，
 * **thinking 块和正文共用 max_tokens 额度**。原来写死 max_tokens: 2000，
 * thinking 先吃掉 1500+，正文写到一半被砍断 → 永远是不完整的 JSON。
 * 更极端的一条用例（H10）2000 全被 thinking 吃光，text 块为空，
 * 报出来是"响应里没有 text 块"，同样指向不了真因。
 *
 * 两条修正：
 *   1. 默认发 `thinking: {type:'disabled'}`。这是"照给定事实写文案"的活，
 *      不需要长链推理，实测关掉后输出 token 从 62 降到 5，延迟从 20s 降到 3s。
 *      想对比思考链质量可用 EXPLAIN_THINKING=enabled 打开。
 *   2. max_tokens 抬到 8192，并且把 stop_reason 透出去——
 *      截断必须报成"截断"，不能报成"JSON 语法错"，否则下次还会误判。
 */
export class AnthropicProvider implements LLMProvider {
  name = 'anthropic';
  private base: string;
  private key: string;
  private model: string;
  private timeoutMs: number;
  private maxTokens: number;
  private thinking: 'disabled' | 'enabled' | 'default';

  constructor(opts: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
    maxTokens?: number;
    thinking?: 'disabled' | 'enabled' | 'default';
  } = {}) {
    this.base = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'claude-sonnet-4-5';
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxTokens = opts.maxTokens ?? Number(process.env.EXPLAIN_MAX_TOKENS ?? 8192);
    const t = opts.thinking ?? (process.env.EXPLAIN_THINKING as any) ?? 'disabled';
    this.thinking = t === 'enabled' || t === 'default' ? t : 'disabled';
  }

  available(): boolean {
    return Boolean(this.key);
  }

  unavailableReason(): string {
    return this.key ? '' : '未配置 ANTHROPIC_API_KEY';
  }

  async complete({ system, user }: { system: string; user: string }): Promise<LLMResponse> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: 0.2, // 解释层要稳，不要创意
        system,
        messages: [{ role: 'user', content: user }],
      };
      // 'default' = 不传这个字段，交给端点自己决定
      if (this.thinking === 'disabled') body.thinking = { type: 'disabled' };
      if (this.thinking === 'enabled') body.thinking = { type: 'enabled', budget_tokens: 2048 };

      const res = await fetch(`${this.base}/v1/messages`, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      if (!res.ok) {
        // 401/403 单独说清楚：这是配置问题，不是模型问题
        const hint = res.status === 401 || res.status === 403 ? '（凭据无效或过期）' : '';
        throw new Error(`HTTP ${res.status}${hint}: ${raw.slice(0, 200)}`);
      }
      const json = JSON.parse(raw);
      const blocks: any[] = Array.isArray(json.content) ? json.content : [];
      const hadThinking = blocks.some((b) => b?.type === 'thinking');
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('');
      if (!text) {
        // 把"为什么没有 text"说清楚，别只报一句"没有 text 块"
        const kinds = blocks.map((b) => b?.type).join('/') || '空';
        throw new Error(
          `响应里没有 text 块（content 块：${kinds}；stop_reason=${json.stop_reason}；output_tokens=${json.usage?.output_tokens}）` +
            (hadThinking ? '——thinking 把 max_tokens 吃光了，用 EXPLAIN_THINKING=disabled 或调大 EXPLAIN_MAX_TOKENS' : ''),
        );
      }
      return { text, usage: json.usage, stopReason: json.stop_reason, hadThinking };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 管道自测用。它返回的是**手写的一份合规输出**，不是模型生成的。
 * 任何人看到 mock 的评测数字，都必须知道那不是模型能力，只是"链路能跑通"。
 */
export class MockProvider implements LLMProvider {
  name = 'mock';
  available() { return true; }
  unavailableReason() { return ''; }
  async complete({ ctx }: { ctx?: ExplainContext }): Promise<LLMResponse> {
    // MockProvider 是照着 ExplainContext 手写输出，解析层没有这个上下文。
    // 与其让它在 `ctx.combo` 上抛 TypeError，不如说清楚它用不了。
    if (!ctx) throw new Error('MockProvider 只用于解释层的管道自测，不能用于解析层（F1）');
    const c = ctx.combo;
    const rej = ctx.rejected[0];
    const light = ctx.lighterCandidates[0];
    const pkg = {
      combo_id: c.id,
      one_pager: {
        headline: `${c.name}：一个人两周能跑通的形态`,
        why: `你只有 ${String(ctx.vector.team_size ?? '1')} 个人、预算 ${String(ctx.vector.budget_cny_month ?? 0)} 元，${c.one_liner}`,
        first_step: { action: c.first_step, minutes: c.first_step_minutes },
      },
      not_chosen: rej
        ? [{
            combo_id: rej.id,
            what: rej.name,
            why: rej.reason || `分数 ${rej.score}，排在 Top2 之后`,
            // 必须翻转，不能照抄——照抄会被 fact.reconsider_copied 打回
            reconsider_when: invertWhenToLeave(rej.when_to_leave),
            source_when_to_leave: rej.when_to_leave || '',
          }]
        : [],
      next_three_steps: [
        { action: '把项目骨架跑起来，看到默认页', minutes: 30, blocker: '版本不一致导致的报错' },
        { action: '接上数据层，写一条数据再读出来', minutes: 60, blocker: '环境变量没注入' },
        { action: '部署上线，拿到一个能打开的链接', minutes: 120, blocker: '构建路径前缀配错' },
      ],
      pitfalls: c.beginner_pitfalls.slice(0, 2).map((p, i) => ({ text: p, source_index: i })),
      lighter_alternative: light
        ? { needed: true, combo_id: light.id, why: `一个人做可以先用 ${light.name}` }
        : { needed: false, combo_id: null, why: '' },
    };
    return { text: JSON.stringify(pkg, null, 2), usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

/** 对抗测试用：模拟"模型开始编"的典型形态 */
export class BrokenProvider implements LLMProvider {
  name = 'broken';
  available() { return true; }
  unavailableReason() { return ''; }
  async complete(): Promise<LLMResponse> {
    return {
      text: JSON.stringify({
        combo_id: 'C99', // 闭集里不存在
        one_pager: {
          headline: '推荐使用 Kubernetes + Istio 构建微服务架构', // 引入了输入里没有的技术
          why: '这套方案业界最流行。',
          first_step: { action: '先去学习一下 Docker 和 K8s 的基本概念', minutes: 30 }, // 废话
        },
        next_three_steps: [{ action: '继续学习', minutes: 60, blocker: '概念太多' }], // 只有 1 条
        not_chosen: [{
          combo_id: 'C88',
          what: '别的方案',
          why: '不如这个好',
          reconsider_when: '永远不会',
          source_when_to_leave: '我编的一句话',
        }],
        pitfalls: [
          { text: '记得配置 Prometheus 监控和 Grafana 面板', source_index: 99 }, // 编的坑 + 越界
        ],
        lighter_alternative: { needed: true, combo_id: 'C77', why: '可以试试更轻的' },
      }, null, 2),
    };
  }
}
