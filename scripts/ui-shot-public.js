/**
 * 截图脚本：**公网单路径部署**上的完整闭环。
 * 由 scripts/shot.mjs --script=... 加载执行。
 *
 * 和 ui-shot-plan.js 的区别：这个脚本跑的是线上地址，所有请求都打在 `POST /` 上
 * （网关把路径压平了，前端靠 body.action 分发）。所以它验证的不只是界面，
 * 而是"内联单文档 + 单路径分发 + SSE"三件事在真实浏览器里同时成立。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, n = 200) => {
    for (let i = 0; i < n; i++) { if (fn()) return true; await sleep(200); }
    return false;
  };
  const pick = (field, value) => {
    const card = document.querySelector(`.q-card[data-field="${field}"]`);
    card?.querySelector(`.opt[data-value="${value}"]`)?.click();
  };
  const setSkill = (sk, v) => {
    const input = document.querySelector(`[data-skill="${sk}"]`);
    if (!input) return;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // 线上首次打开可能是平台的"工作空间启动中"过渡页，DOM 就绪时间不确定。
  // 只等 #rawInput 不够：它在 HTML 里就有，而点击监听是后面那段内联 app.js 绑的。
  // 等得太早 → 赋值成功但点击无效（踩过：截图里文本框有字，页面一点反应没有）。
  // 所以用"手动填表已被 buildForm() 填满"当应用启动完成的判据。
  if (!(await until(() => document.querySelector('#formFields')?.children.length > 0, 300))) {
    return 'timeout: 应用没启动（app.js 未执行）';
  }

  document.querySelector('#rawInput').value =
    '想做个网页，打开就能随机听世界各地电台，收藏只存浏览器里，不要账号，也不要广告';
  document.querySelector('#intakeBtn').click();
  if (!(await until(() => document.querySelector('.q-card')))) return 'timeout: 追问没出现';

  // 只答三题：语言基础 / 目标 / 团队规模。剩下的故意不答——验证"跳过 ≠ 明确不要"
  setSkill('js', 0.8);
  pick('goal_type', 'product');
  pick('team_size', '1');

  const gen = document.querySelector('.ask-actions button.primary');
  if (!gen) return 'timeout: 没有生成按钮';
  gen.click();

  if (!(await until(() => document.querySelector('.progress-line')?.textContent?.startsWith('完成'), 400))) {
    return 'timeout: 方案没跑完';
  }
  return 'plan-rendered';
})();
