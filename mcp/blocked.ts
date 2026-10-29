/**
 * blocked 时的回复渲染（v2.1.0 从 server.ts 抽出）：
 * 抽出的原因不是整洁，是**可测试**——server.ts 顶层有 connect(transport) 副作用，
 * 测试 import 它会真起 stdio；blocked 文案的断言（尤其 EXTRACTED_CONSTRAINTS_HINT
 * 防丢失）必须能直接 import 纯函数。
 */

/**
 * 追问答案的合并指引（v2.1.0 模板常量）。
 * 会话记忆不做在 MCP 侧（单进程多会话会串台），状态归宿主——
 * 这句文案就是闭环的桥：宿主把用户回答转成 extracted_constraints 再调一次。
 * test-host-intake.ts 断言追问文案包含此常量，防止以后润色时静默丢失。
 */
export const EXTRACTED_CONSTRAINTS_HINT =
  '再次调用时，请把用户对上述问题的回答转换成 extracted_constraints 的字段（附逐字 evidence）一并传入。';

/** 把缺字段翻成"该问用户什么"。blocked 时用它组织回复 */
function missingHint(result: any): string[] {
  const fields: string[] = result.suggested_fields ?? [];
  const Q: Record<string, string> = {
    delivery: '这个东西最终以什么形式给用户用？（网页 / 小程序 / 桌面 / 命令行）',
    ai_workflow: '你打算让 AI 写多少？全让它写，还是你也会改？',
    required_capabilities: '需要登录、支付、AI、文件上传这些能力里的哪些？',
    team_size: '几个人做？',
    goal_type: '做这个是为了内部用、对外做产品，还是放作品集？',
    timeline_weeks: '希望多久能用上？',
    budget_cny_month: '每月能接受多少服务器成本？0 也可以。',
    expected_users: '预计多少人用？',
    compliance: '涉及支付或个人隐私数据吗？',
  };
  return fields.map((f) => `- ${Q[f] ?? f}`);
}

/**
 * blocked 时的回复。
 *
 * low_confidence / insufficient_candidates 走【追问协议】：顶部醒目区块 + 给宿主
 * 模型的行动指令代码块——"低置信度拦截与追问闭环"的出口。
 * uncovered 是另一回事（闭集没有对应形态），保持"做不了 + 替代问法"的说明。
 */
export function blockedMarkdown(result: any, rawInput: string): string {
  const reasonCn: Record<string, string> = {
    uncovered: '当前模板库还没覆盖你的场景',
    low_confidence: '信息不足以给出可靠方案',
    insufficient_candidates: '约束之间互相打架，过滤后剩不下两套可比的方案',
  };
  const out: string[] = [];

  if (result.reason === 'low_confidence' || result.reason === 'insufficient_candidates') {
    const hints = missingHint(result);
    const questions: string[] = result.questions?.length ? result.questions : hints;
    out.push(`# ⚠️ 需要补充信息（${reasonCn[result.reason] ?? result.reason}）`);
    out.push('');
    out.push('## 请先向用户追问以下问题');
    out.push('');
    out.push(...(questions.length ? questions : ['- 再多说两句你想做的东西：给谁用、大概什么形态、要哪些功能']));
    out.push('');
    out.push('```text');
    out.push('请先停止生成代码与方案输出。');
    out.push('向用户确认上述问题后，把用户的回答与原始需求合并，');
    out.push('再次调用 stackpilot 的 recommend_stack 工具（建议同时传入 extracted_constraints）。');
    out.push(EXTRACTED_CONSTRAINTS_HINT);
    out.push('```');
    out.push('');
    out.push('> 这不是失败，是**主动不猜**。缺这几个字段时选出的方案是猜的，硬给一个方案比不给更糟。');
    out.push('');
    out.push('---');
    out.push('');
    out.push(`原始需求：${rawInput}`);
    return out.join('\n');
  }

  // uncovered
  out.push(`# 暂时给不出方案：${reasonCn[result.reason] ?? result.reason}`);
  out.push('');
  out.push('> 这不是失败，是**主动不猜**。硬给一个方案比不给更糟。');
  out.push('');
  out.push('当前闭集里的 12 套组合覆盖的是 Web / 小程序 / 自部署 / API / Agent / CLI 这几类形态，');
  out.push('你这套需求不在其中。可以告诉我：换成网页版（功能会打折）能不能接受？');
  out.push('');
  out.push('---');
  out.push('');
  out.push(`原始需求：${rawInput}`);
  return out.join('\n');
}
