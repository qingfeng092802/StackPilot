/**
 * 前端：大白话输入 → 追问 → SSE 增量渲染。
 *
 * 三条 UI 决策由服务端 view-model 决定，前端只负责"照着渲染"，不自己判断：
 *   ① not_chosen 的分组顺序 → 服务端给的是已排好的 groups 数组
 *   ② source_when_to_leave 不进 UI → payload 里根本没有这个字段
 *   ③ confidence 三态 → high 正常 / medium 顶部黄条 / low 只有追问表单
 *
 * F1 新增的一条同等重要的规则：
 *   ④ 解析层没读到的字段，前端**不许补默认值**。
 *      没答的题就是 null（"没说"），不是 0、不是"最常见的那项"。
 *      唯一例外是用户主动点了「都不需要」——那是明确回答，编码成 []。
 *
 * 为什么不用 EventSource：
 *   EventSource 只能发 GET、不能带 body、不能加 header。
 *   真实链路是 POST + JSON body，所以统一用 fetch + ReadableStream 手写 SSE 解析，
 *   让演示和真实请求走**同一套**前端代码——两套解析逻辑迟早会不一致。
 */

// ── 端点解析（部署适配，不是功能）────────────────────────────────
/**
 * 默认走多路径（本地开发、正常平台）。
 *
 * 但有些部署平台的网关会把**任意路径重写成 `/`** 再转发给后端
 * （实测 WorkBuddy 分享链接：`/api/intake`、`/a/b/c.js` 到 Node 时都变成 `/`），
 * 于是静态资源和所有 API 路由全部失效。服务端这时会用 `SP_SINGLE_PATH=1`
 * 把整个应用折叠成 `GET /` + `POST /`，并把这份端点表注入到页面里。
 *
 * 关键点：**折叠只影响"请求发到哪"，不影响任何业务逻辑**。
 * 三个调用点仍然是同一个函数、同一份 body，只是多带一个 action 字段。
 */
const EP = (typeof window !== 'undefined' && window.__SP_EP__) || {
  single: false,
  intake: '/api/intake',
  plan: '/api/plan',
  demo: '/api/demo',
};

// ── 字段定义（与服务端 ConstraintVector 的枚举严格一致）──────────
const FIELDS = {
  delivery: {
    label: '交付形态', type: 'select',
    options: [['web', '网页'], ['miniprogram', '微信小程序'], ['selfhost', '自部署'], ['desktop', '桌面客户端'], ['api', 'API 服务'], ['agent', 'AI Agent'], ['cli', '命令行工具']],
  },
  team_size: {
    label: '团队规模', type: 'select',
    options: [['1', '只有我'], ['2-3', '2–3 人'], ['5+', '5 人以上']],
  },
  skills: { label: '语言基础（0–1）', type: 'skills' },
  timeline_weeks: { label: '多久上线（周）', type: 'number' },
  budget_cny_month: { label: '每月预算（元）', type: 'number' },
  expected_users: { label: '预计用户数', type: 'number' },
  required_capabilities: {
    label: '需要的能力', type: 'multi', wide: true,
    options: [['auth', '登录'], ['payment', '支付'], ['ai', 'AI'], ['realtime', '实时'], ['file_upload', '文件上传'], ['file_storage', '文件存储'], ['data_persistence', '数据存服务端'], ['no_persistence', '只存浏览器']],
  },
  compliance: {
    label: '合规要求', type: 'multi', wide: true,
    options: [['personal_data', '个人隐私数据'], ['payment', '支付合规']],
  },
  goal_type: {
    label: '做这个的目标', type: 'select',
    options: [['product', '对外做产品'], ['internal_tool', '内部工具'], ['portfolio', '放作品集']],
  },
};

const SKILL_KEYS = [['js', 'JS'], ['python', 'Py'], ['sql', 'SQL'], ['ops', '运维'], ['go', 'Go'], ['rust', 'Rust'], ['java', 'Java']];

/** 字段名中文化。视图层已有同名映射，但那是服务端给警告条用的，这里要单独一份：
 *  前端还会渲染 dropped 字段名，不走服务端那条链路。 */
const FIELD_CN = {
  delivery: '交付形态',
  team_size: '团队规模',
  skills: '语言基础',
  timeline_weeks: '上线时间',
  budget_cny_month: '每月预算',
  expected_users: '用户量',
  required_capabilities: '需要的能力',
  compliance: '合规要求',
  goal_type: '目标类型',
};

/** H06 的冻结向量——演示态与"演示态里补字段重跑"共用同一份基线 */
const PREFILL = {
  raw_input: '上班路上爱听广播，但经常听一半就到公司了；干活时也想听点新鲜的。我想做个网页：打开按一下就随机掉进世界上某个城市的电台，同一个浏览器下次打开能接着上次听；按「下一站」随机换台，能只听高码率；能读到曲名的直接显示，读不到的点一下就识别；收藏的歌能跳到音乐 App 去搜。星图按流派铺开可以拖着逛，也有地球视图。不要账号、不要广告，收藏只存浏览器里。',
  vector: {
    delivery: 'web', team_size: '1',
    skills: { js: 0.8, python: 0.1, sql: 0.4, ops: 0.3 },
    timeline_weeks: null, budget_cny_month: null, expected_users: null,
    required_capabilities: [], compliance: [], goal_type: 'product',
  },
};

/** 四个示例，覆盖四种典型局面：字段齐 / 内部工具 / 否定表述 / 超出范围 */
const EXAMPLES = [
  '我想做个帮人记账的小程序，大概 10 个人用，我会一点 Python',
  '想给公司内部做个查资料的网页，就我们组三个人用，不要账号，预算每月 100 块',
  '想做个网页，打开就能随机听世界各地电台，收藏只存浏览器里，不要账号，也不要广告',
  '帮我做个桌面软件，用来管理我的照片，就我自己用',
];

// ── DOM ──────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
/** LLM 输出一律转义后再插 DOM */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 把枚举值翻成中文，用于"我读到了什么" */
function labelOf(field, value) {
  if (field === 'skills') {
    return Object.entries(value ?? {}).map(([k, s]) => `${SKILL_KEYS.find(([id]) => id === k)?.[1] ?? k} ${s}`).join('、');
  }
  if (field === 'timeline_weeks') return `${value} 周`;
  if (field === 'budget_cny_month') return `¥${value}/月`;
  if (field === 'expected_users') return `${value} 人`;
  if (Array.isArray(value)) {
    if (!value.length) return '不需要';
    return value.map((v) => FIELDS[field]?.options?.find(([id]) => id === v)?.[1] ?? v).join('、');
  }
  return FIELDS[field]?.options?.find(([id]) => id === value)?.[1] ?? String(value);
}

// ── 手动表单 ─────────────────────────────────────────────────
function buildForm() {
  const host = $('#formFields');
  host.innerHTML = '';
  for (const [key, def] of Object.entries(FIELDS)) {
    const wrap = el('label', 'field' + (def.wide ? ' wide' : ''));
    if (def.type === 'skills') {
      wrap.innerHTML = `<span class="field-label">${def.label}</span>`;
      const box = el('div');
      for (const [sk, label] of SKILL_KEYS) {
        const row = el('div', 'skill-row');
        row.innerHTML = `<span>${label}</span>
          <input type="range" min="0" max="1" step="0.1" data-skill="${sk}" value="0">
          <output data-out="${sk}">0</output>`;
        box.appendChild(row);
      }
      wrap.appendChild(box);
    } else if (def.type === 'multi') {
      wrap.innerHTML = `<span class="field-label">${def.label}</span>`;
      const box = el('div', 'chips');
      const mk = (val, label, cls) => {
        const c = el('span', 'chip' + (cls ? ' ' + cls : ''), label);
        c.dataset.field = key;
        c.dataset.value = val;
        box.appendChild(c);
        return c;
      };
      for (const [val, label] of def.options) mk(val, label);
      // 【F1 补的一致性缺口】原来这里只有选项本身，于是"一个都没勾"在 readForm 里
      // 变成了 `[]`——等于替用户宣布"这些能力我都不需要"。
      // 而 `[]` 在引擎里是**已填写**（会抬高 confidence，还会让零数据库方案占便宜）。
      // 加一个显式的"都不需要"，才能把"没填"和"明确不要"分开。
      const none = mk('__none__', '都不需要', 'none-chip');
      box.addEventListener('click', (e) => {
        const t = e.target.closest('.chip');
        if (!t) return;
        if (t === none) {
          const on = !none.classList.contains('on');
          box.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
          none.classList.toggle('on', on);
        } else {
          none.classList.remove('on');
          t.classList.toggle('on');
          if (t.classList.contains('on')) clearOpposite(box, t.dataset.value);
        }
      });
      wrap.appendChild(box);
    } else if (def.type === 'select') {
      const opts = ['<option value="">（不填）</option>']
        .concat(def.options.map(([v, t]) => `<option value="${v}">${t}</option>`)).join('');
      wrap.innerHTML = `<span class="field-label">${def.label}</span><select data-field="${key}">${opts}</select>`;
    } else {
      wrap.innerHTML = `<span class="field-label">${def.label}</span>
        <input type="number" min="0" data-field="${key}" placeholder="留空 = 没说">`;
    }
    host.appendChild(wrap);
  }
  // 滑块数值回显
  host.addEventListener('input', (e) => {
    if (e.target.matches('[data-skill]')) {
      const out = host.querySelector(`[data-out="${e.target.dataset.skill}"]`);
      if (out) out.textContent = e.target.value;
    }
  });
}

/**
 * 把一份约束向量回填到手动表单。
 *
 * 为什么需要：演示态用的是服务端冻结的向量，如果不回填，手动表单还是空的，
 * 右边却提示"信息不足"——用户点开手动填表会以为页面出错了。
 * 向量由服务端随 meta / blocked 一起下发（demo_vector），前端不自己维护一份副本，
 * 否则两边迟早不一致。
 */
function applyVectorToForm(vec) {
  if (!vec) return;
  for (const [key, def] of Object.entries(FIELDS)) {
    const v = vec[key];
    if (def.type === 'skills') {
      for (const [sk] of SKILL_KEYS) {
        const val = v?.[sk] ?? 0;
        const input = document.querySelector(`[data-skill="${sk}"]`);
        if (input) input.value = val;
        const out = document.querySelector(`[data-out="${sk}"]`);
        if (out) out.textContent = val;
      }
    } else if (def.type === 'multi') {
      const on = v ?? [];
      const isNone = Array.isArray(v) && v.length === 0;
      document.querySelectorAll(`.chip[data-field="${key}"]`).forEach((c) => {
        if (c.dataset.value === '__none__') c.classList.toggle('on', isNone);
        else c.classList.toggle('on', on.includes(c.dataset.value));
      });
    } else if (def.type === 'select') {
      const s = document.querySelector(`[data-field="${key}"]`);
      if (s) s.value = v ?? '';
    } else {
      const i = document.querySelector(`[data-field="${key}"]`);
      if (i) i.value = v === null || v === undefined ? '' : v;
    }
  }
}

function readForm() {
  const vector = {};
  for (const [key, def] of Object.entries(FIELDS)) {
    if (def.type === 'skills') {
      const s = {};
      let any = false;
      for (const [sk] of SKILL_KEYS) {
        const v = Number(document.querySelector(`[data-skill="${sk}"]`).value);
        s[sk] = v;
        if (v > 0) any = true;
      }
      // 全部 0 视为"没填"——否则会把"完全不会"和"没问"混成同一个值
      vector.skills = any ? s : null;
    } else if (def.type === 'multi') {
      const on = [...document.querySelectorAll(`.chip[data-field="${key}"].on`)].map((c) => c.dataset.value);
      // 空数组只能来自显式的"都不需要"；一个都没勾就是"没说"，留 null
      if (on.includes('__none__')) vector[key] = [];
      else vector[key] = on.length ? on : null;
    } else if (def.type === 'select') {
      const v = document.querySelector(`[data-field="${key}"]`).value;
      vector[key] = v || null;
    } else {
      const raw = document.querySelector(`[data-field="${key}"]`).value;
      vector[key] = raw === '' ? null : Number(raw);
    }
  }
  return { raw_input: $('#rawInput').value.trim(), vector };
}

function setManualOpen(open) {
  const panel = $('#manual');
  panel.hidden = !open;
  const btn = $('#manualToggle');
  btn.textContent = open ? '收起表单' : '我要自己填表';
  btn.setAttribute('aria-expanded', String(open));
}

// ── SSE 解析 ─────────────────────────────────────────────────
async function* sseEvents(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try { yield { event, data: JSON.parse(data) }; }
      catch { console.warn('无法解析的 SSE 数据', event, data.slice(0, 120)); }
    }
  }
}

// ── 渲染：结果区 ─────────────────────────────────────────────
const state = { running: false, lastRequest: null, intake: null };

function resetResult() {
  $('#empty').style.display = 'none';
  $('#banner').innerHTML = '';
  $('#meta').innerHTML = '';
  $('#modules').innerHTML = '';
}

function renderBanners(meta) {
  const slot = $('#banner');
  if (meta.confidence === 'medium' && meta.confidence_banner) {
    slot.appendChild(el('div', 'banner warn', `<span class="ico">⚠</span><div><strong>信息不完整</strong><br>${esc(meta.confidence_banner)}</div>`));
  }
  if (meta.coverage_warning) {
    slot.appendChild(el('div', 'banner info', `<span class="ico">ⓘ</span><div>${esc(meta.coverage_warning)}</div>`));
  }
}

function renderMeta(meta) {
  const confText = { high: '信息充分', medium: '信息不足', low: '信息严重不足' }[meta.confidence] ?? meta.confidence;
  const card = el('div', 'meta-card');
  card.innerHTML = `
    <div class="meta-head">
      <span class="meta-id">${esc(meta.combo_id)}</span>
      <span class="meta-name">${esc(meta.combo_name)}</span>
      <span class="conf-pill conf-${esc(meta.confidence)}">${esc(confText)}</span>
    </div>
    <p class="meta-one">${esc(meta.one_liner)}</p>
    <div class="comps">${meta.components.map((c) => `
      <div class="comp${c.name ? '' : ' empty-slot'}">
        <div class="comp-slot">${esc(c.slotLabel)}</div>
        <div class="comp-name" title="${esc(c.role ?? '')}">${esc(c.name ?? '不需要')}</div>
      </div>`).join('')}
    </div>
    ${meta.inferred.capabilities.length ? `
      <div class="inferred">引擎从你的原文里推断出「${esc(meta.inferred.capabilities.join('、'))}」这个隐性需求${
        meta.inferred.evidence ? `（依据：${esc(meta.inferred.evidence)}）` : ''
      }，已作为建议项参与打分。</div>` : ''}`;
  $('#meta').appendChild(card);
}

const TITLES = {
  one_pager: '一页纸结论',
  not_chosen: '为什么不选那个',
  next_three_steps: '接下来三步',
  pitfalls: '新手最容易踩的坑',
  lighter_alternative: '要不要降一档',
};

function renderModule(m) {
  const box = el('section', 'mod');
  const head = `<h3 class="mod-title"><span class="num">${String(m.seq).padStart(2, '0')}</span>${TITLES[m.module] ?? m.module}</h3>`;
  let body = '';

  if (m.module === 'one_pager') {
    const p = m.payload;
    body = `
      <h2 class="headline">${esc(p.headline)}</h2>
      <p class="why">${esc(p.why)}</p>
      <div class="first-step">
        <div class="first-step-head">
          <span class="tag">今晚第一步</span>
          <span class="minutes">约 ${p.first_step.minutes} 分钟</span>
        </div>
        <div class="first-step-action">${esc(p.first_step.action)}</div>
      </div>`;
  }

  if (m.module === 'not_chosen') {
    body = m.payload.groups.map((g) => `
      <div class="group group-${g.tier === 'runner_up' ? 'near' : 'filtered'}">
        <div class="group-head">
          <span class="group-title ${g.tier === 'runner_up' ? 'near' : 'filtered'}">${esc(g.title)}</span>
          <span class="group-count">${g.items.length} 套</span>
        </div>
        <p class="group-hint">${esc(g.hint)}</p>
        ${g.items.map((it) => `
          <div class="nc-item">
            <div class="nc-top">
              <span class="nc-what">${esc(it.what)}</span>
              ${it.score !== null ? `<span class="nc-score">${it.score.toFixed(2)} 分</span>` : ''}
            </div>
            <p class="nc-why">${esc(it.why)}</p>
            ${it.filter_reason ? `<p class="nc-filter">硬性冲突：${esc(it.filter_reason)}</p>` : ''}
            <div class="nc-reconsider">
              <span class="arrow">↩</span>
              <div><b>什么时候回头用它：</b>${esc(it.reconsider_when)}</div>
            </div>
          </div>`).join('')}
      </div>`).join('');
  }

  if (m.module === 'next_three_steps') {
    body = `<div class="steps">${m.payload.steps.map((s) => `
      <div class="step">
        <div class="step-idx">${s.index}</div>
        <div>
          <div class="step-action">${esc(s.action)}</div>
          <div class="step-meta">
            <span class="minutes">约 ${s.minutes} 分钟</span>
            <span class="step-blocker"><b>可能卡在：</b>${esc(s.blocker)}</span>
          </div>
        </div>
      </div>`).join('')}</div>`;
  }

  if (m.module === 'pitfalls') {
    body = `<ul class="pitfalls">${m.payload.items.map((t) => `
      <li class="pitfall"><span class="dot">▲</span><span>${esc(t)}</span></li>`).join('')}</ul>`;
  }

  if (m.module === 'lighter_alternative') {
    const p = m.payload;
    body = `<div class="lighter">
      <span class="lighter-badge ${p.needed ? 'yes' : 'no'}">${p.needed ? '建议降档' : '不需要降档'}</span>
      <div class="lighter-body">${p.needed && p.combo_name ? `<b>${esc(p.combo_name)}</b>：` : ''}${esc(p.why)}</div>
    </div>`;
  }

  box.innerHTML = head + body;
  $('#modules').appendChild(box);
}

function showProgress(label) {
  let node = $('#progress');
  if (!node) {
    node = el('div', 'progress-line');
    node.id = 'progress';
    node.innerHTML = `<span class="spinner"></span><span class="txt"></span>`;
    $('#modules').appendChild(node);
  }
  node.querySelector('.txt').textContent = label;
}

function hideProgress() {
  $('#progress')?.remove();
}

function renderBlocked(b) {
  const cls = b.reason === 'low_confidence' ? 'low' : 'uncovered';
  const box = el('div', `blocked ${cls}`);
  box.innerHTML = `
    <h2 class="blocked-title">${esc(b.title)}</h2>
    <p class="blocked-msg">${esc(b.message)}</p>
    <div class="ask-list" id="askList"></div>`;

  if (b.questions.length) {
    const list = box.querySelector('#askList');
    b.questions.forEach((q, i) => {
      const field = b.suggested_fields[i];
      const def = FIELDS[field];
      if (!def) return;
      const item = el('div', 'ask-item');
      item.innerHTML = `<label>${esc(q)} <span class="hint">（${esc(def.label)}）</span></label>`;
      let control;
      if (def.type === 'select') {
        control = el('select');
        control.dataset.field = field;
        control.innerHTML = ['<option value="">请选择</option>']
          .concat(def.options.map(([v, t]) => `<option value="${v}">${t}</option>`)).join('');
      } else if (def.type === 'multi') {
        control = el('div', 'chips');
        for (const [v, t] of def.options) {
          const c = el('span', 'chip', t);
          c.dataset.value = v;
          control.appendChild(c);
        }
        control.addEventListener('click', (e) => {
          const t = e.target.closest('.chip');
          if (!t) return;
          t.classList.toggle('on');
          if (t.classList.contains('on')) clearOpposite(control, t.dataset.value);
        });
      } else if (def.type === 'number') {
        control = el('input');
        control.type = 'number';
        control.min = '0';
        control.dataset.field = field;
      } else if (def.type === 'skills') {
        // 语言基础必须用滑块，不能用文本框：
        // 自由文本（"我会一点 JS"）没法回填成这组 0–1 数值，
        // 强行解析等于在 UI 层写一个 NLP，必然错。
        control = el('div');
        for (const [sk, label] of SKILL_KEYS) {
          const row = el('div', 'skill-row');
          row.innerHTML = `<span>${label}</span>
            <input type="range" min="0" max="1" step="0.1" data-ask-skill="${sk}" value="0">
            <output data-ask-out="${sk}">0</output>`;
          control.appendChild(row);
        }
        control.addEventListener('input', (e) => {
          if (e.target.matches('[data-ask-skill]')) {
            const out = control.querySelector(`[data-ask-out="${e.target.dataset.skill}"]`);
            if (out) out.textContent = e.target.value;
          }
        });
      } else {
        control = el('input');
        control.type = 'text';
        control.dataset.field = field;
      }
      item.appendChild(control);
      list.appendChild(item);
    });

    const actions = el('div', 'ask-actions');
    const btn = el('button', 'primary', '补上这些，重新跑一次');
    btn.addEventListener('click', () => {
      const patch = {};
      for (const field of b.suggested_fields) {
        const def = FIELDS[field];
        if (!def) continue;
        if (def.type === 'multi') {
          const on = [...box.querySelectorAll('.chip.on')].map((c) => c.dataset.value);
          // 一个都没勾就不进 patch——保持原来的 null，别把"没填"改写成"不需要"
          if (on.length) patch[field] = on;
        } else if (def.type === 'skills') {
          const s = {};
          for (const [sk] of SKILL_KEYS) s[sk] = Number(box.querySelector(`[data-ask-skill="${sk}"]`)?.value ?? 0);
          patch[field] = s;
        } else if (def.type === 'select' || def.type === 'number') {
          const input = box.querySelector(`[data-field="${field}"]`);
          if (input) patch[field] = def.type === 'number' ? (input.value === '' ? null : Number(input.value)) : (input.value || null);
        }
      }
      runPlan({ ...state.lastRequest, vector: { ...state.lastRequest.vector, ...patch } }, btn);
    });
    actions.appendChild(btn);
    box.appendChild(actions);
  }

  $('#modules').appendChild(box);
}

// ── 渲染：追问区 ─────────────────────────────────────────────
/** 极性互斥：data_persistence 与 no_persistence 只能有一个亮着。
 *  两个都勾上会被服务端判为自相矛盾、双双丢弃，用户等于白答一次。 */
const OPPOSITE_CAP = { data_persistence: 'no_persistence', no_persistence: 'data_persistence' };
function clearOpposite(scope, value) {
  const opp = OPPOSITE_CAP[value];
  if (!opp) return;
  scope.querySelectorAll(`[data-value="${opp}"]`).forEach((n) => n.classList.remove('on'));
}

function makeOpt(label, value) {
  const b = el('button', 'opt', esc(label));
  b.type = 'button';
  b.dataset.value = value;
  b.addEventListener('click', () => b.classList.toggle('on'));
  return b;
}

/** 单选组：点谁谁亮，其余灭 */
function bindSingle(box) {
  box.addEventListener('click', (e) => {
    const t = e.target.closest('.opt');
    if (!t) return;
    box.querySelectorAll('.opt').forEach((x) => x.classList.toggle('on', x === t));
  });
}

function renderReadback(data) {
  const box = el('div', 'readback');
  const entries = Object.entries(data.evidence ?? {});
  box.appendChild(el('div', 'readback-title', `我从你的话里读到了 ${entries.length} 项`));

  if (entries.length) {
    const list = el('div', 'readback-list');
    for (const [field, ev] of entries) {
      const v = data.parsed?.[field];
      const item = el('span', 'rb', `<b>${esc(labelOf(field, v))}</b><i>「${esc(ev)}」</i>`);
      item.title = `${field} = ${JSON.stringify(v)}`;
      list.appendChild(item);
    }
    box.appendChild(list);
  } else {
    box.appendChild(el('p', 'readback-empty', '一句都没读出确定的字段——你写的每一条都需要我猜，而我不猜。下面逐个问你。'));
  }

  // 把"差点被自动填上"摆出来。这不是技术细节，是用户判断"该不该信这个系统"的依据。
  // 字段名必须翻成中文——直接甩 expected_users 出去，等于把内部字段名漏给用户。
  if (data.dropped?.length) {
    const names = [...new Set(data.dropped.map((d) => FIELD_CN[d.field.split('.')[0]] ?? d.field))];
    box.appendChild(el('div', 'dropped-note',
      `<b>有 ${names.length} 个字段差点被自动填上，我拦下了</b>：${esc(names.join('、'))}。
       原文里找不到依据的值一律不采纳，宁可问你。`));
  }
  return box;
}

function renderQuestion(q, i) {
  const card = el('div', 'q-card');
  card.dataset.field = q.field;
  card.innerHTML = `
    <div class="q-head"><span class="q-idx">${i + 1}</span><span class="q-question">${esc(q.question)}</span></div>
    ${q.hint ? `<p class="q-hint">${esc(q.hint)}</p>` : ''}`;

  if (q.type === 'select') {
    const box = el('div', 'q-opts');
    for (const o of q.options) box.appendChild(makeOpt(o.label, o.value));
    bindSingle(box);
    card.appendChild(box);
  }

  if (q.type === 'multi') {
    const box = el('div', 'q-opts');
    for (const o of q.options) box.appendChild(makeOpt(o.label, o.value));
    // 必须有一个显式的"都不需要"。
    // 否则"用户跳过这题"和"用户明确说都不要"在数据上长得一模一样，
    // 而这两件事对 confidence 的影响完全不同（后者是已填写，前者是缺失）。
    const none = makeOpt('都不需要', '__none__');
    none.classList.add('none-opt');
    box.appendChild(none);
    box.addEventListener('click', (e) => {
      const t = e.target.closest('.opt');
      if (!t) return;
      if (t === none) {
        box.querySelectorAll('.opt').forEach((x) => x.classList.toggle('on', x === none));
      } else if (t.classList.contains('on')) {
        none.classList.remove('on');
        clearOpposite(box, t.dataset.value);
      }
    });
    card.appendChild(box);
  }

  if (q.type === 'number') {
    const input = el('input', 'q-num');
    input.type = 'number';
    input.min = '0';
    input.placeholder = `填个大概（${q.unit ?? ''}）`;
    card.appendChild(input);
  }

  if (q.type === 'skills') {
    // 语言 + 程度两行单选。
    // 不用滑块：滑块默认 0 会被当成"用户选了 0"，而"没动过"和"完全不会"必须区分开。
    const wrap = el('div', 'q-skill');
    const mkRow = (label, opts) => {
      const row = el('div', 'q-skill-row');
      row.appendChild(el('span', 'q-skill-label', label));
      const box = el('div', 'q-opts');
      box.style.marginLeft = '0';
      for (const o of opts) box.appendChild(makeOpt(o.label, o.value));
      bindSingle(box);
      row.appendChild(box);
      return row;
    };
    wrap.appendChild(mkRow('语言', q.langs ?? []));
    wrap.appendChild(mkRow('程度', q.levels ?? []));
    card.appendChild(wrap);
  }

  return card;
}

/**
 * 收集用户对追问的回答。
 * 没答的字段**不出现在 patch 里**——它会在 merge 时保持 null（= 没说）。
 */
function collectAnswers() {
  const patch = {};
  const data = state.intake;
  if (!data) return patch;

  for (const q of data.questions) {
    const card = document.querySelector(`.q-card[data-field="${q.field}"]`);
    if (!card) continue;

    if (q.type === 'select') {
      const on = card.querySelector('.opt.on');
      if (on) patch[q.field] = on.dataset.value;
    } else if (q.type === 'multi') {
      const on = [...card.querySelectorAll('.opt.on')].map((x) => x.dataset.value);
      if (on.includes('__none__')) patch[q.field] = [];
      else if (on.length) patch[q.field] = on;
    } else if (q.type === 'number') {
      const raw = card.querySelector('.q-num').value.trim();
      if (raw !== '') patch[q.field] = Number(raw);
    } else if (q.type === 'skills') {
      const rows = card.querySelectorAll('.q-skill-row');
      const lang = rows[0]?.querySelector('.opt.on')?.dataset.value;
      const level = rows[1]?.querySelector('.opt.on')?.dataset.value;
      if (!lang || !level) continue;
      if (lang === '*') {
        // 明确说"完全不会"→ 全部语言 0。这是事实的完整编码，不是猜。
        const all = {};
        for (const [k] of SKILL_KEYS) all[k] = 0;
        patch.skills = all;
      } else {
        patch.skills = { [lang]: q.levels.find((l) => l.value === level)?.score ?? 0 };
      }
    }
  }
  return patch;
}

/**
 * 解析结果 + 追问回答 → 一份完整的 ConstraintVector。
 *
 * 关键点：**所有 9 个字段都要出现**，没值的写 null。
 * 不能只把有值的塞进去——那样 `required_capabilities` 会变成 undefined，
 * 而 undefined 和 null 在下游虽然都算"缺失"，但把"缺失"这件事表达清楚
 * 比依赖下游的容错更可靠。null 是"用户没说"，[] 是"用户说不需要"，两者不能混。
 */
function mergeVector(parsed, patch) {
  const v = {};
  for (const key of Object.keys(FIELDS)) v[key] = null;
  for (const [k, val] of Object.entries(parsed ?? {})) v[k] = val;
  Object.assign(v, patch);
  return v;
}

function renderAskZone(data) {
  const zone = $('#askZone');
  zone.innerHTML = '';
  zone.appendChild(renderReadback(data));

  const actions = el('div', 'ask-actions');

  // 超出范围就别问了。问完三个问题再说"做不了"是最招人烦的一种产品行为。
  if (data.coverage_status === 'uncovered') {
    zone.appendChild(el('div', 'banner info',
      '<span class="ico">ⓘ</span><div>你要的这种形态不在我的模板范围内，所以下面不再追问——问了你也没法用上。</div>'));
    const btn = el('button', 'primary', '看看为什么做不了');
    btn.addEventListener('click', () => onGenerate(btn));
    actions.appendChild(btn);
    zone.appendChild(actions);
    return;
  }

  data.questions.forEach((q, i) => zone.appendChild(renderQuestion(q, i)));

  const btn = el('button', 'primary', data.questions.length ? '确认无误，生成方案' : '生成方案');
  btn.addEventListener('click', () => onGenerate(btn));
  actions.appendChild(btn);
  actions.appendChild(el('span', 'ask-note', data.questions.length
    ? `还有 ${data.missing.length} 项没说，只挑最关键的 ${data.questions.length} 个问你；不答也能出方案，但会带警告条。`
    : '信息已经够全，可以直接出方案。'));
  zone.appendChild(actions);

  // 占位文案此时已经过时（"上面用大白话写一句"），改成下一步提示，别让页面下方空着像坏了
  const empty = $('#empty');
  empty.style.display = '';
  empty.innerHTML = `<div class="empty-mark">◈</div><p>答完上面的问题（或直接跳过），点「生成方案」。</p>`;
}

// ── 执行 ─────────────────────────────────────────────────────
async function consume(res) {
  resetResult();
  showProgress('正在处理…');
  const t0 = Date.now();

  for await (const { event, data } of sseEvents(res)) {
    if (event === 'meta') {
      if (data.demo_vector) {
        applyVectorToForm(data.demo_vector);
        // 演示态里点"补上这些重新跑"要接得住，基线必须是这份冻结向量，不是预填值
        state.lastRequest = { raw_input: PREFILL.raw_input, vector: structuredClone(data.demo_vector) };
      }
      renderBanners(data);
      renderMeta(data);
      showProgress('正在生成说明文案…');
    } else if (event === 'progress') {
      showProgress(`正在生成说明文案… 已等 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } else if (event === 'module') {
      hideProgress();
      renderModule(data);
    } else if (event === 'blocked') {
      hideProgress();
      if (data.demo_vector) {
        applyVectorToForm(data.demo_vector);
        state.lastRequest = { raw_input: PREFILL.raw_input, vector: structuredClone(data.demo_vector) };
      }
      renderBlocked(data);
    } else if (event === 'done') {
      hideProgress();
      console.info('[SSE done]', data);
      const tail = el('div', 'progress-line');
      tail.style.color = '#9aa1ae';
      tail.textContent = `完成 · 来源 ${data.source} · ${data.latency_ms}ms` +
        (data.issues?.length ? ` · 过程中拦截 ${data.issues.length} 次` : '');
      $('#modules').appendChild(tail);
    } else if (event === 'error') {
      hideProgress();
      $('#modules').appendChild(el('div', 'banner warn', `<span class="ico">⚠</span><div>${esc(data.message)}</div>`));
    }
  }
}

async function runDemo(stateName, btn) {
  if (state.running) return;
  state.running = true;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  try {
    // 单路径模式下 demo 也只能走 POST（GET 的 query 同样会被网关吃掉）
    const res = EP.single
      ? await fetch(EP.demo, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'demo', state: stateName }),
        })
      : await fetch(`${EP.demo}?state=${encodeURIComponent(stateName)}`);
    await consume(res);
  } catch (e) {
    $('#modules').appendChild(el('div', 'banner warn', `<span class="ico">⚠</span><div>请求失败：${esc(e.message)}</div>`));
  } finally {
    state.running = false;
  }
}

async function runPlan(body, btn) {
  if (state.running) return;
  state.running = true;
  state.lastRequest = body;
  document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
  const runBtn = btn ?? $('#intakeBtn');
  const oldText = runBtn.textContent;
  runBtn.disabled = true;
  runBtn.textContent = '跑着呢…';
  try {
    const res = await fetch(EP.plan, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(EP.single ? { ...body, action: 'plan' } : body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    await consume(res);
  } catch (e) {
    resetResult();
    $('#modules').appendChild(el('div', 'banner warn', `<span class="ico">⚠</span><div>请求失败：${esc(e.message)}</div>`));
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = oldText;
    state.running = false;
  }
}

/**
 * 解析失败的正确降级：**不重试、不猜、直接把手动填表打开**。
 *
 * 这里最容易犯的错是"失败了就用默认值跑一遍"——那等于把"我没读懂"
 * 变成了"我读懂了，你就是要个网页"。用户根本不知道前提已经被换掉了。
 */
function onIntakeFailed(data, raw) {
  const detail = data?.failure?.detail ?? '解析失败';
  const stage = data?.failure?.stage ?? 'transport';
  const zone = $('#askZone');
  zone.innerHTML = '';
  zone.appendChild(el('div', 'banner warn',
    `<span class="ico">⚠</span><div><strong>没能把你的描述转成结构</strong><br>${esc(detail)}<br>
     <span style="color:#8b93a1">（${esc(stage)} 阶段）已经帮你展开手动填表，原文还在上面。</span></div>`));
  setManualOpen(true);
}

async function doIntake() {
  if (state.running) return;
  const raw = $('#rawInput').value.trim();
  if (raw.length < 4) {
    $('#askZone').innerHTML = '';
    $('#askZone').appendChild(el('div', 'banner warn', '<span class="ico">⚠</span><div>先写一句你想做的东西，比如「想做个记账的小程序」。</div>'));
    $('#rawInput').focus();
    return;
  }

  const btn = $('#intakeBtn');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在读懂你的需求…';
  $('#askZone').innerHTML = '';
  state.intake = null;

  try {
    const payload = { raw_input: raw };
    const res = await fetch(EP.intake, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(EP.single ? { ...payload, action: 'intake' } : payload),
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    if (!data.ok) { onIntakeFailed(data, raw); return; }
    state.intake = data;
    console.info('[intake]', data);
    renderAskZone(data);
  } catch (e) {
    onIntakeFailed({ failure: { stage: 'transport', detail: String(e.message ?? e) } }, raw);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

async function onGenerate(btn) {
  if (!state.intake) return;
  const patch = collectAnswers();
  const vector = mergeVector(state.intake.parsed, patch);
  console.info('[plan request]', { patch, vector });
  await runPlan({ raw_input: $('#rawInput').value.trim(), vector }, btn);
}

// ── 启动 ─────────────────────────────────────────────────────
buildForm();
setManualOpen(false);

$('#intakeBtn').addEventListener('click', doIntake);
$('#manualToggle').addEventListener('click', () => setManualOpen($('#manual').hidden));
$('#manualRunBtn').addEventListener('click', () => runPlan(readForm(), $('#manualRunBtn')));
$('#mockBtn').addEventListener('click', () => runPlan({ ...readForm(), provider: 'mock' }, $('#mockBtn')));

// Ctrl / ⌘ + Enter 直接提交
$('#rawInput').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doIntake();
});

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => runDemo(btn.dataset.state, btn));
});

document.querySelectorAll('.example').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('#rawInput').value = EXAMPLES[Number(btn.dataset.ex)] ?? '';
    doIntake();
  });
});

// 深链：/?demo=high 直接跑演示
const qs = new URLSearchParams(location.search).get('demo');
if (qs) {
  const btn = document.querySelector(`.tab[data-state="${qs}"]`);
  if (btn) runDemo(qs, btn);
}
