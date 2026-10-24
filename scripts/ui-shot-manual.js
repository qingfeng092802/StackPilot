/**
 * 截图脚本：展开手动填表，验证"没勾选 ≠ 明确不需要"。
 * 返回 readForm() 的关键字段，用来断言 multi 字段是 null 而不是 []。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector('#manualToggle').click();
  await sleep(300);

  const before = readForm().vector;

  // 勾一个"登录"，再点"都不需要"，再点回"登录"——验证互斥
  const auth = document.querySelector('.chip[data-field="required_capabilities"][data-value="auth"]');
  const none = document.querySelector('.chip[data-field="required_capabilities"][data-value="__none__"]');
  auth.click();
  const afterAuth = JSON.stringify(readForm().vector.required_capabilities);
  none.click();
  const afterNone = JSON.stringify(readForm().vector.required_capabilities);
  auth.click();
  const afterAuth2 = JSON.stringify(readForm().vector.required_capabilities);

  return JSON.stringify({
    empty: JSON.stringify(before.required_capabilities),
    afterAuth, afterNone, afterAuth2,
  });
})();
