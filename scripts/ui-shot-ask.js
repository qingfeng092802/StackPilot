/**
 * 截图脚本：填一句大白话 → 点「开始选型」→ 等追问渲染 → 答两题（第三题故意留空）。
 * 只到"追问态"，不点生成——用来展示"我读到了什么 + 还差什么"。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, n = 120) => {
    for (let i = 0; i < n; i++) { if (fn()) return true; await sleep(200); }
    return false;
  };
  const pick = (field, value) => {
    const card = document.querySelector(`.q-card[data-field="${field}"]`);
    card?.querySelector(`.opt[data-value="${value}"]`)?.click();
  };

  document.querySelector('#rawInput').value = '我想做个帮人记账的小程序，大概 10 个人用，我会一点 Python';
  document.querySelector('#intakeBtn').click();
  if (!(await until(() => document.querySelector('.q-card')))) return 'timeout: 追问没出现';

  pick('goal_type', 'product');
  pick('team_size', '1');
  // 第三题（需要哪些能力）故意不答：验证"跳过 ≠ 明确不要"
  return 'ask-answered';
})();
