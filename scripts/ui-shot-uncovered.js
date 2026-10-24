/**
 * 截图脚本：超出范围（桌面客户端）→ 不该追问，应直接给"做不了"的说明。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, n = 120) => {
    for (let i = 0; i < n; i++) { if (fn()) return true; await sleep(200); }
    return false;
  };

  document.querySelector('#rawInput').value = '帮我做个桌面软件，用来管理我的照片，就我自己用';
  document.querySelector('#intakeBtn').click();
  if (!(await until(() => document.querySelector('.ask-actions button.primary')))) return 'timeout: 追问区没出现';

  // 按钮文案必须是"看看为什么做不了"，而不是"生成方案"
  const label = document.querySelector('.ask-actions button.primary').textContent;
  document.querySelector('.ask-actions button.primary').click();
  if (!(await until(() => document.querySelector('.blocked')))) return 'timeout: 阻断态没出现';
  return 'blocked: ' + label;
})();
