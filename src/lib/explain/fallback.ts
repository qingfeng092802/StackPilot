/**
 * 降级文案（fallback）：LLM 不可用 / 输出不合格时，直接交付这个。
 *
 * 为什么要有它：宁可给一份"平实但每句都真"的说明，也不给一份"流畅但可能编"的说明。
 * 它必须能**独立成立**——用户不该看出这是降级产物，只会觉得"话说得直白"。
 *
 * 内容来源全部是闭集里已有的事实：
 *   - 一句话结论 / 为什么 → combo.name + combo.one_liner
 *   - 今晚第一步        → combo.first_step（12 套逐条手写，含真实命令）
 *   - 三步             → 按 components 组合推导（有 db 就接数据层，没有就做纯前端交互）
 *   - 坑点             → combo.beginner_pitfalls 原文
 *   - 不选清单         → rejected[].reason + when_to_leave（翻转后，不是照抄）
 *   - 降档建议         → lighterCandidates
 *
 * 唯一的"推导"是三步与坑点排序，都不引入新事实。
 */

import { COMPONENT_NAMES } from '../../data/component-names.ts';
import type { ExplainContext, ExplanationPackage } from './types.ts';

/**
 * 给人看的组件名，**不带组件 ID**。
 * 为什么不用 componentLabel()：它输出 "Next.js（FE-01）"，那是给"输出侧验证材料"做溯源用的，
 * 混进用户读的方案里就是噪音——用户不需要知道 FE-01。
 */
function plain(id: string | null | undefined): string {
  if (!id) return '（不需要）';
  return COMPONENT_NAMES[id]?.name ?? id;
}

function stepsOf(ctx: ExplainContext): ExplanationPackage['next_three_steps'] {
  const c = ctx.combo.components;
  const fe = plain(c.fe);
  const be = plain(c.be);
  const db = plain(c.db);
  const dp = plain(c.deploy);

  // 小程序系（原生 / uni-app）没有"浏览器里看页面"这回事，效果只在开发者工具的模拟器里。
  // 闭集 23 个组件里非浏览器的 FE 只有这两个，写死在这里即可，新组件进来时同步。
  const localView = ['FE-05', 'FE-06'].includes(c.fe) ? '在开发者工具的模拟器里' : '在浏览器里';

  const first = {
    action: `把 ${fe} 项目在本地跑起来，${localView}看到默认页`,
    minutes: 30,
    blocker: '版本不对导致的报错：先确认本机 Node / Python 版本和项目要求一致',
  };

  let second: ExplanationPackage['next_three_steps'][number];
  if (c.db) {
    second = {
      action: `在 ${db} 里建一张表，写一条数据再读出来（先不管界面好不好看）`,
      minutes: 60,
      blocker: '连接串和环境变量写错：本地能跑、线上连不上，多半是没配连接池或变量没注入',
    };
  } else if (c.be) {
    second = {
      action: `在 ${be} 里加一个接口，先返回固定 JSON，确认前端能调通`,
      minutes: 60,
      blocker: '跨域和路径前缀：接口能 curl 通但页面调不到，先看 Network 面板的状态码',
    };
  } else {
    second = {
      action: '把核心交互做出来：所有逻辑都在浏览器里跑，先不接任何服务',
      minutes: 60,
      blocker: '状态全在内存里，刷新就没了——这是这套方案的正常代价，别当成 bug 去修',
    };
  }

  const third = c.deploy
    ? {
        action: `部署到 ${dp}，拿到一个别人点开就能用的链接`,
        minutes: 120,
        blocker: '构建产物的路径前缀配错，部署后整站白屏或刷新 404',
      }
    : {
        action: '把代码提交到 GitHub，写清怎么跑起来，方便以后回来看',
        minutes: 60,
        blocker: '把密钥提交进仓库：先确认 .env 在 .gitignore 里',
      };

  return [first, second, third];
}

/** KB 里的排除理由是第三人称（"用户不熟 Python"），交付给用户时要改成第二人称 */
function toSecondPerson(s: string): string {
  return String(s ?? '').replace(/用户不熟/g, '你不熟').replace(/^用户/, '你');
}

/**
 * 把 when_to_leave 机械翻转成"何时回头看"。
 *
 * 【为什么不能直接抄 · 2026-10-24】
 * when_to_leave 说的是"什么条件下该**离开**这个落选方案"，
 * reconsider_when 说的是"什么条件下值得**重新捡起**它"。照抄等于把话说反：
 * C03 的 when_to_leave 是「当团队只有你一个人…退回 C01」，抄进"什么时候回头看"，
 * 就变成"你一个人时回头看 C03"——而一个人恰恰是不该用 C03 的场景。
 *
 * 翻转只做一件事：保留条件部分，套进"等这个条件不再成立"的框里。
 * 不做同义词替换、不引入任何新事实，所以它在语义上永远和原文互补。
 */
export function invertWhenToLeave(wtl: string): string {
  const s = String(wtl ?? '').trim();
  if (!s) return '这套方案的适用条件发生变化时，再回来看它';
  // 「当<条件>时，<动作>」→ 只取<条件>。多段条件（含"；"）只取第一段，
  // 因为后半段通常是"改用哪套"，套进这个框里会读不通。
  const m = s.match(/^当(.+?)时[，,]/);
  const cond = m ? m[1] : s.replace(/[，,。].*$/, '');
  return `等你不再处于「${cond}」这种情况时，再回来看它`;
}

export function buildFallback(ctx: ExplainContext): ExplanationPackage {
  const c = ctx.combo;

  const notChosen = ctx.rejected.slice(0, 3).map((r) => ({
    combo_id: r.id,
    what: r.name,
    why: toSecondPerson(r.reason) || `分数 ${r.score ?? '—'}，排在 Top2 之后`,
    // 必须翻转，不能照抄。照抄会让"什么时候回头看"这一栏读成自相矛盾的建议。
    reconsider_when: invertWhenToLeave(r.when_to_leave),
    source_when_to_leave: r.when_to_leave || '',
  }));

  const pitfalls = c.beginner_pitfalls.slice(0, 3).map((p, i) => ({ text: p, source_index: i }));

  const lighter = ctx.lighterCandidates[0];
  const lightNeeded = Boolean(lighter) && ctx.vector.team_size === '1';

  // 兜底的"为什么"也要带上约束依据，否则读起来像在念产品简介
  const bits: string[] = [];
  if (ctx.vector.team_size === '1') bits.push('你只有一个人');
  const budget = ctx.vector.budget_cny_month;
  if (budget === 0) bits.push('预算 0');
  else if (typeof budget === 'number' && budget > 0) bits.push(`每月预算 ¥${budget}`);
  const why = bits.length ? `${bits.join('、')}，${c.one_liner}` : c.one_liner;

  return {
    combo_id: c.id,
    one_pager: {
      headline: c.name,
      why,
      first_step: { action: c.first_step, minutes: c.first_step_minutes },
    },
    not_chosen: notChosen,
    next_three_steps: stepsOf(ctx),
    pitfalls,
    lighter_alternative: {
      needed: lightNeeded,
      combo_id: lightNeeded ? lighter.id : null,
      // 必须把代价说出来。只讲"更轻"不讲"少了什么"，等于诱导用户选一个不满足他需求的方案。
      why: lightNeeded
        ? `你是一个人做，${lighter.name} 少一层东西要维护${lighter.tradeoff ? `；代价是：${lighter.tradeoff}` : ''}`
        : '',
    },
  };
}
