/**
 * 截图脚本：完整闭环 —— 大白话 → 追问 → 答两题 → 生成方案 → 等流跑完。
 * 由 scripts/shot.mjs --script=... 加载执行。
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

  // 只答三题里的两个，第三个（需要哪些能力）故意留空——验证"跳过 ≠ 明确不要"
  pick('goal_type', 'product');
  pick('team_size', '1');

  document.querySelector('.ask-actions button.primary').click();
  if (!(await until(() => document.querySelector('.progress-line')?.textContent?.startsWith('完成')))) {
    return 'timeout: 方案没跑完';
  }
  return 'plan-rendered';
})();
