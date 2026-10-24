/**
 * F1 解析层 Prompt：大白话 → ConstraintVector。
 *
 * 这一层的失败模式和解解释层不一样：
 *   解释层怕的是"编事实"（编一个不存在的坑）；
 *   解析层怕的是"补需求"（用户说"我会一点代码"，它填 skills.js=0.6）。
 *
 * 后者更隐蔽——补出来的值看起来总是合理的，用户也不会反驳，
 * 但整个选型就建立在一个模型自己编的前提上。所以这一层的核心约束不是"写得准"，
 * 而是**每一个字段都必须能指回原文里的一句话**。
 *
 * 三条写死在 prompt 里的规则：
 *   1. 每个字段带 evidence，evidence 必须是原文逐字连续出现的片段
 *   2. 原文没说到的字段一律 null，不许填默认值、不许按常见情况估计
 *   3. 数值只输出 amount + unit，不许自己换算（换算是代码的事，可复算、可审计）
 */

/** 解析层允许的枚举值——和 scoring.ts 的枚举严格一致，改这里必须同步改那边 */
export const DELIVERY_VALUES = ['web', 'miniprogram', 'desktop', 'api', 'agent', 'cli', 'selfhost'] as const;
export const TEAM_SIZE_VALUES = ['1', '2-3', '5+'] as const;
export const GOAL_VALUES = ['portfolio', 'product', 'internal_tool'] as const;
export const CAPABILITY_VALUES = [
  'auth', 'payment', 'ai', 'realtime',
  'file_upload', 'file_storage', 'data_persistence', 'multi_platform',
  /** 反向能力：用户明确说"不要服务端存储"。与 data_persistence 互斥 */
  'no_persistence',
] as const;
export const COMPLIANCE_VALUES = ['personal_data', 'payment'] as const;
export const SKILL_LANGS = ['js', 'python', 'sql', 'ops', 'go', 'rust', 'java'] as const;
export const SKILL_LEVELS = ['none', 'beginner', 'basic', 'proficient', 'expert'] as const;
export const TIME_UNITS = ['day', 'week', 'month'] as const;

export const INTAKE_SYSTEM_PROMPT = `你是一个需求解析器，不是需求补全器。

你的唯一工作：从用户的大白话里，抽出**他已经说出口的**约束。
你没有的权力：推断、补全、估计、猜。

## 铁律（违反任何一条，输出作废）

1. 每个字段都必须带 evidence。evidence 必须是原文里**逐字连续出现**的片段。
   不许改写、不许概括、不许把分开的两处拼在一起、不许补主语。

2. 原文没有明确说到的字段，一律输出 null。
   **不许填默认值，不许按"这类项目通常怎样"估计，不许给出"合理范围"。**

3. 下面是典型错误，你必须避免：

   ✗ 用户说「我会一点代码」→ 你输出 skills: [{lang:"js", level:"beginner"}]
     错在哪：他既没说语言，也没说程度。skills 必须是 []，交给系统去问。

   ✗ 用户说「做个工具给同事用」→ 你输出 delivery: "web"
     错在哪：工具可能是网页、可能是桌面、可能是命令行。delivery 必须是 null。

   ✗ 用户说「人不多」→ 你输出 team_size: "2-3"
     错在哪："人不多"不是"2-3 人"。team_size 必须是 null。

   ✗ 用户说「希望快一点」→ 你输出 timeline: {amount:2, unit:"week"}
     错在哪："快一点"没有数值。timeline 必须是 null。

   ✓ 用户说「就我自己用」→ team_size: {value:"1", evidence:"就我自己用"} 正确。
   ✓ 用户说「大概十个人用」→ expected_users: {amount:10, evidence:"大概十个人用"} 正确。

4. 否定表述要如实记录，它和"没说"是两件不同的事：
   用户说「不要账号」→ capabilities: {values:[], evidence:"不要账号"}
   用户没提任何能力 → capabilities: null

   **关于"存不存数据"的极性，这是最容易读反的一条：**
   - 「要记录历史 / 存在服务端 / 换设备也要能看到」→ data_persistence
   - 「只存浏览器里 / 存本地就行 / 不要数据库 / 清缓存没了也没事」→ **no_persistence**
   - 这两个值**不能同时出现**。用户没说存哪儿 → 两个都不填。
   - 特别注意：「收藏只存浏览器里」的落点是"只存浏览器"，不是"存"。
     填 data_persistence 就是把用户的意思说反了，而这条错误会让引擎推一套带数据库的方案。

5. 数值字段只输出 amount + unit，**不要自己换算**。
   「两周」→ {amount:2, unit:"week"}
   「一个月」→ {amount:1, unit:"month"}
   「半年」→ {amount:6, unit:"month"}
   换算成周/月由代码做，因为那必须是可复算的，不能是模型心算的结果。

6. 枚举字段只能从给定的取值里选，不许自造新值。

## 输出格式
只输出一个 JSON 对象，不要 markdown 代码围栏，不要任何解释性文字。
没有把握的字段就写 null，写 null 不扣分，瞎填会让整个方案作废。`;

export function buildIntakePrompt(rawInput: string): string {
  return `### 用户的原始描述
"""
${rawInput}
"""

### 可选枚举值
delivery: ${DELIVERY_VALUES.join(' | ')}
team_size: ${TEAM_SIZE_VALUES.join(' | ')}
goal_type: ${GOAL_VALUES.join(' | ')}
capabilities: ${CAPABILITY_VALUES.join(' | ')}
compliance: ${COMPLIANCE_VALUES.join(' | ')}
skills.lang: ${SKILL_LANGS.join(' | ')}（另有 "*" 仅当用户明确说"完全不会写代码"时用，此时 level 必须是 none）
skills.level: ${SKILL_LEVELS.join(' | ')}（none=完全不会, beginner=会一点, basic=能独立写小功能, proficient=熟练, expert=精通）
timeline.unit: day | week | month
budget.unit: month | year

### 你要产出的 JSON（每个字段要么是带 evidence 的对象，要么是 null）

{
  "delivery":      { "value": "web", "evidence": "原文里的连续片段" } 或 null,
  "team_size":     { "value": "1", "evidence": "…" } 或 null,
  "skills":        [ { "lang": "python", "level": "beginner", "evidence": "…" } ],
  "timeline":      { "amount": 1, "unit": "month", "evidence": "…" } 或 null,
  "budget":        { "amount": 100, "unit": "month", "evidence": "…" } 或 null,
  "expected_users":{ "amount": 10, "evidence": "…" } 或 null,
  "capabilities":  { "values": ["auth"], "evidence": "…" } 或 null,
  "compliance":    { "values": ["personal_data"], "evidence": "…" } 或 null,
  "goal_type":     { "value": "product", "evidence": "…" } 或 null
}

### 三个示范

输入：「我想做个帮人记账的小程序，大概 10 个人用，我会一点 Python」
输出：
{
  "delivery": { "value": "miniprogram", "evidence": "做个帮人记账的小程序" },
  "team_size": null,
  "skills": [ { "lang": "python", "level": "beginner", "evidence": "我会一点 Python" } ],
  "timeline": null,
  "budget": null,
  "expected_users": { "amount": 10, "evidence": "大概 10 个人用" },
  "capabilities": null,
  "compliance": null,
  "goal_type": null
}
（注意：没说几个人做、没说多久上线、没说预算、没说要不要登录——全部 null）

输入：「想给公司内部做个查资料的网页，就我们组三个人用，不要账号」
输出：
{
  "delivery": { "value": "web", "evidence": "做个查资料的网页" },
  "team_size": { "value": "2-3", "evidence": "我们组三个人用" },
  "skills": [],
  "timeline": null,
  "budget": null,
  "expected_users": null,
  "capabilities": { "values": [], "evidence": "不要账号" },
  "compliance": null,
  "goal_type": { "value": "internal_tool", "evidence": "给公司内部做个查资料的网页" }
}
（注意：capabilities 是 [] 而不是 null——用户明确说了"不要账号"，这是信息，不是缺失）

输入：「想做个网页，打开就能随机听世界各地电台，收藏只存浏览器里，不要账号」
输出：
{
  "delivery": { "value": "web", "evidence": "想做个网页" },
  "team_size": null,
  "skills": [],
  "timeline": null,
  "budget": null,
  "expected_users": null,
  "capabilities": { "values": ["no_persistence"], "evidence": "收藏只存浏览器里" },
  "compliance": null,
  "goal_type": null
}
（注意：这里填的是 no_persistence 而**不是** data_persistence。
 「只存浏览器里」的意思是"不要服务端存储"，填成 data_persistence 会把意思说反，
 引擎会据此推一套带数据库的方案。
 「不要账号」也是同一句里说的，但一条 evidence 只能对应一个 values 列表，
 所以这里只写「收藏只存浏览器里」能支撑的结论。原文里这几句是连着的，
 也可以整段当 evidence：「不要账号、不要广告，收藏只存浏览器里」。）`;
}
