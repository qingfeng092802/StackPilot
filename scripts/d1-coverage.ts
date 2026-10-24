/**
 * D1 覆盖率与命中率诊断
 * ------------------------------------------------------------------
 *   Q1 闭集覆盖率：真实独立产品的交付形态，有多少落在组合模板能表达的范围内？
 *   Q2 选型命中率：真实项目最终选的栈，打分引擎的 Top1/Top2 能不能命中？
 *   Q3 置信度拦截：字段少的帖子，引擎有没有老实说"我在猜"？
 *
 * 【v0.4.3】新增 nearest_neighbor：结构性缺口时，报出"闭集里离真实答案最近的那套，
 * 以及差在哪"。只有"无法表达"这句话，看不出引擎到底差多远。
 *
 * 运行：node --experimental-strip-types scripts/d1-coverage.ts
 */
import { readFileSync } from 'node:fs';
import { rank, type ConstraintVector, type Combo } from '../src/lib/scoring.ts';

const combos: Combo[] = JSON.parse(readFileSync(new URL('../src/data/combos.json', import.meta.url), 'utf8')).combos;
const pool = JSON.parse(readFileSync(new URL('../tests/d1-candidates.json', import.meta.url), 'utf8'));
const holdout = JSON.parse(readFileSync(new URL('../tests/d1-holdout.json', import.meta.url), 'utf8'));

/**
 * 前端组件 ID → 框架家族。
 * 依据 combos.json 里组合的 fe 字段反推（C01/C02/C09/C11 都是 Next.js 且都是 FE-01，以此类推）。
 * 不从 combo.name 解析，因为 C10 名字以 NestJS 开头但前端是 FE-04，按名字切会错。
 */
const FE_FAMILY: Record<string, string> = {
  'FE-01': 'nextjs',
  'FE-02': 'nuxt',
  'FE-03': 'sveltekit',
  'FE-04': 'react-spa',
  'FE-05': 'miniprogram',
  'FE-06': 'uniapp',
};

const COVERED = new Set(['web', 'miniprogram', 'selfhost']);
const PARTIAL = new Set(['mobile']);

const feFamilyOf = (c: Combo) => FE_FAMILY[c.components.fe] ?? `?${c.components.fe}`;
const hasDb = (c: Combo) => Boolean(c.components.db);
const hasBackend = (c: Combo) => Boolean(c.components.be);

// ────────────────────────────────────────────────────────────
// Q1 闭集覆盖率
// ────────────────────────────────────────────────────────────
const products = pool.candidates.filter((c: any) => c.is_product);
const byForm = new Map<string, number>();
for (const c of products) byForm.set(c.delivery_form, (byForm.get(c.delivery_form) ?? 0) + 1);

const coveredCount = products.filter((c: any) => COVERED.has(c.delivery_form)).length;
const partialCount = products.filter((c: any) => PARTIAL.has(c.delivery_form)).length;
const uncovered = products.filter((c: any) => !COVERED.has(c.delivery_form) && !PARTIAL.has(c.delivery_form));

console.log('═'.repeat(80));
console.log(`Q1  闭集覆盖率（V2EX /go/create 第 1–3 页 60 条，产品类 ${products.length} 条）`);
console.log('═'.repeat(80));
console.log('交付形态            条数   占比    闭集能否表达');
console.log('-'.repeat(80));
for (const [form, n] of [...byForm.entries()].sort((a, b) => b[1] - a[1])) {
  const mark = COVERED.has(form) ? '✅ 覆盖' : PARTIAL.has(form) ? '△ 勉强（仅 C08）' : '❌ 无对应模板';
  console.log(`${form.padEnd(20)}${String(n).padStart(3)}   ${((n / products.length) * 100).toFixed(1).padStart(5)}%   ${mark}`);
}
console.log('-'.repeat(80));
console.log(`可覆盖 ${coveredCount}/${products.length} = ${((coveredCount / products.length) * 100).toFixed(1)}%` +
  ` ｜ 勉强 ${partialCount} ｜ 无法表达 ${uncovered.length} = ${((uncovered.length / products.length) * 100).toFixed(1)}%`);

const noDbCombos = combos.filter((c) => !hasDb(c));
const nonWebComponents = combos.filter((c) => Object.values(c.components).some((id) => /^(DS|MB)-/.test(String(id))));
console.log('\n── 结构性缺口 ──');
console.log(`  ${noDbCombos.length > 0 ? '✅' : '❌'} 零数据库组合：${noDbCombos.map((c) => c.id).join(', ') || '无'}`);
console.log(`  ${nonWebComponents.length === 0 ? '❌' : '✅'} 含桌面/原生移动组件：${nonWebComponents.length}/${combos.length}`);
console.log(`  ❌ 无模板的交付形态：${[...byForm.keys()].filter((f) => !COVERED.has(f) && !PARTIAL.has(f)).join(', ')}`);

// ────────────────────────────────────────────────────────────
// Q2/Q3 命中率 + 置信度拦截
// ────────────────────────────────────────────────────────────

/**
 * 最近邻：闭集里离「真实答案」最近的那套，排除已经被推荐为 Top1 的。
 *   +1 真实答案没有 DB，这套有 DB
 *   +1 真实答案没有独立后端，这套有独立后端
 */
function nearestNeighbor(gt: any, excludeId?: string): { combo_id: string | null; distance_note: string } {
  if (!gt.fe_family) return { combo_id: null, distance_note: '真实技术栈未披露，无法计算距离' };

  const distance = (c: Combo) => {
    let d = 0;
    if (hasDb(c) && gt.has_db === false) d += 1;
    if (!hasDb(c) && gt.has_db === true) d += 1;
    if (hasBackend(c) && gt.has_separate_backend === false) d += 1;
    return d;
  };

  /**
   * 【v0.4.3】如果引擎推荐的那套在分层上已经零距离，最近邻就该说"分层对上了，
   * 只差框架"，而不是绕一圈说"闭集里没有 X 的模板，最近的是 Y"——
   * 后者会让人误以为连架构都没对上。加入 C12 后 H02/H05/H08 就落在这种情况。
   */
  if (excludeId) {
    const rec = combos.find((c) => c.id === excludeId);
    if (rec && distance(rec) === 0) {
      const fwOk = feFamilyOf(rec) === gt.fe_family;
      return {
        combo_id: rec.id,
        distance_note: fwOk
          ? '框架与分层都对上了'
          : `分层完全对上（无独立后端、无数据库），差的只是框架：真实用 ${gt.fe_family}，闭集给的是 ${feFamilyOf(rec)}`,
      };
    }
  }
  const pickBest = (arr: Combo[]) =>
    [...arr].sort((a, b) => {
      const dd = distance(a) - distance(b);
      if (dd !== 0) return dd;
      return a.id.localeCompare(b.id);
    })[0];

  const same = combos.filter((c) => feFamilyOf(c) === gt.fe_family && c.id !== excludeId);
  const frameworkMatched = same.length > 0;
  const pick = frameworkMatched
    ? pickBest(same)
    : pickBest(combos.filter((c) => c.id !== excludeId));
  if (!pick) return { combo_id: null, distance_note: '闭集为空' };

  const dbName = (c: Combo) =>
    c.components.be === 'BE-06' ? 'Supabase 托管' : c.components.db === 'DB-02' ? 'SQLite' : '自建 Postgres';

  const extras: string[] = [];
  if (hasDb(pick) && gt.has_db === false) extras.push(`多了一层 ${dbName(pick)}（${pick.components.db}）`);
  if (hasBackend(pick) && gt.has_separate_backend === false) extras.push('多了一个独立后端服务层');

  if (gt.has_db === null) {
    return { combo_id: pick.id, distance_note: `真实栈未披露，只能确认框架同为 ${gt.fe_family}，分层是否一致无从判断` };
  }

  let head: string;
  if (!frameworkMatched) {
    head = excludeId
      ? `闭集里没有 ${gt.fe_family} 的模板；除已推荐的 ${excludeId} 外，最近的是 ${pick.id}`
      : `闭集里没有 ${gt.fe_family} 的模板，最近的是 ${pick.id}`;
  } else if (distance(pick) === 0) {
    head = '框架与分层都对上了';
  } else {
    head = `方向对（同为 ${gt.fe_family}）`;
  }

  const tail = extras.length > 0
    ? `，但${extras.join('，且')}`
    : frameworkMatched ? '，分层也一致' : '，框架层仍是引入了一整套';
  return { combo_id: pick.id, distance_note: head + tail };
}

const stats = { HIT: 0, PARTIAL_HIT: 0, MISS: 0, BLOCKED: 0 };
const confDist: Record<string, number> = { high: 0, medium: 0, low: 0 };
const lowInfo: Array<{ id: string; fields: number; conf: string; blocked: boolean; reason?: string }> = [];

console.log('\n' + '═'.repeat(80));
console.log(`Q2  选型命中率（${holdout.cases.length} 条真实项目，盲标约束向量 → 比对作者实际技术栈）`);
console.log('═'.repeat(80));

for (const cs of holdout.cases) {
  const v = cs.blind_constraint_vector as ConstraintVector;
  const gt = cs.ground_truth;
  const r = rank(combos, v, { raw_input: cs.raw_input });
  const nn = nearestNeighbor(gt, r.ok ? r.top1.id : undefined);

  confDist[r.confidence]++;
  if (cs.fields_non_null <= 7) {
    lowInfo.push({ id: cs.id, fields: cs.fields_non_null, conf: r.confidence, blocked: !r.ok, reason: r.ok ? undefined : r.reason });
  }

  console.log(`\n${cs.id}  字段 ${cs.fields_non_null}/9  coverage=${r.coverage_status}  confidence=${r.confidence}`);

  if (!r.ok) {
    stats.BLOCKED++;
    console.log(`     → 不出方案（${r.reason}）`);
    if (r.suggested_fields.length) console.log(`       建议补：${r.suggested_fields.join(', ')}`);
    console.log(`     真实：${gt.fe_detail}`);
    console.log(`     判定：BLOCKED（期望行为）`);
    continue;
  }

  const t1 = combos.find((x) => x.id === r.top1.id)!;
  const t2 = combos.find((x) => x.id === r.top2.id)!;

  let verdict: string;
  if (gt.has_db === null) {
    verdict = 'MISS';
  } else {
    const fw1 = feFamilyOf(t1) === gt.fe_family;
    const db1 = hasDb(t1) === gt.has_db;
    if (fw1 && db1) verdict = 'HIT';
    else if (fw1 || db1) verdict = 'PARTIAL_HIT';
    else verdict = 'MISS';
  }
  stats[verdict as 'HIT' | 'PARTIAL_HIT' | 'MISS']++;

  console.log(`     Top1 ${t1.id} ${t1.name}`);
  console.log(`     Top2 ${t2.id} ${t2.name}`);
  console.log(`     真实 ${gt.fe_detail}｜db=${gt.has_db}`);
  console.log(`     判定 ${verdict}（Top1=${feFamilyOf(t1)},db=${hasDb(t1)} vs 真实=${gt.fe_family},db=${gt.has_db}）`);
  console.log(`     最近邻 ${nn.combo_id ?? '无'} ${nn.distance_note}`);
}

const judged = stats.HIT + stats.PARTIAL_HIT + stats.MISS;
const weighted = stats.HIT + stats.PARTIAL_HIT * 0.5;

// ────────────────────────────────────────────────────────────
// Q4 分层判断（v0.4.3 新增）
//
// 产品定位是"帮你定架构形态，不替你选框架"（见 PRD v0.4.3 §2），
// 所以真正该看的指标是**分层对不对**，而不是框架家族对不对。
// 两个子维度分开报，因为难度完全不同：
//   · 要不要数据库     —— 决定数据放哪，选错要推倒数据层重来
//   · 要不要服务端层   —— 决定有没有部署与运维成本，选错白搭一层
// 框架选错只是换 UI 写法，代价远小于上面两条。
// ────────────────────────────────────────────────────────────
function layeringStats(pool: Combo[]) {
  let dbOk = 0;
  let serverOk = 0;
  let bothOk = 0;
  let n = 0;
  const bad: string[] = [];
  for (const cs of holdout.cases) {
    const gt = cs.ground_truth;
    if (gt.has_db === null) continue;
    const r = rank(pool, cs.blind_constraint_vector as ConstraintVector, { raw_input: cs.raw_input });
    if (!r.ok) continue;
    const t1 = pool.find((c) => c.id === r.top1.id)!;
    const dbMatch = hasDb(t1) === gt.has_db;
    const serverMatch = hasBackend(t1) === gt.has_separate_backend;
    n++;
    if (dbMatch) dbOk++;
    if (serverMatch) serverOk++;
    if (dbMatch && serverMatch) bothOk++;
    else bad.push(`${cs.id}（Top1=${t1.id}，服务端层${hasBackend(t1) ? '多' : '少'}了一层）`);
  }
  return { dbOk, serverOk, bothOk, n, bad };
}

const beforeC12 = layeringStats(combos.filter((c) => c.id !== 'C12'));
const afterC12 = layeringStats(combos);

console.log('\n' + '═'.repeat(80));
console.log('Q4  分层判断（产品定位：定架构形态，不替你选框架）');
console.log('═'.repeat(80));
console.log(`  可判定 ${afterC12.n} 条`);
console.log(`  要不要数据库      ${afterC12.dbOk}/${afterC12.n}   （加 C12 前 ${beforeC12.dbOk}/${beforeC12.n}）`);
console.log(`  要不要服务端层    ${afterC12.serverOk}/${afterC12.n}   （加 C12 前 ${beforeC12.serverOk}/${beforeC12.n}）`);
console.log(`  两者都对          ${afterC12.bothOk}/${afterC12.n}   （加 C12 前 ${beforeC12.bothOk}/${beforeC12.n}）`);
if (afterC12.bad.length) console.log(`  仍不匹配：${afterC12.bad.join('，')}`);
console.log('  注：H01 的口径边界——真实栈是 Next.js 单进程（无独立服务），');
console.log('      而 C11 的 BE-01 是 Next.js Route Handlers，同进程但确实多了一层服务端运行时。');
console.log('      这条不算推荐错误，是"服务端层"这个指标在 Next.js 场景下的固有模糊。');

console.log('\n' + '═'.repeat(80));
console.log('汇总');
console.log('═'.repeat(80));
console.log(`  入选 ${holdout.cases.length} 条：HIT ${stats.HIT} ｜ PARTIAL_HIT ${stats.PARTIAL_HIT} ｜ MISS ${stats.MISS} ｜ BLOCKED ${stats.BLOCKED}`);
console.log(`  可判定 ${judged} 条，严格命中率 ${((stats.HIT / judged) * 100).toFixed(0)}%，` +
  `含半分命中率 ${((weighted / judged) * 100).toFixed(0)}%（PARTIAL 计 0.5）`);
console.log(`  confidence 分布：high ${confDist.high} ｜ medium ${confDist.medium} ｜ low ${confDist.low}`);

console.log('\nQ3  置信度拦截（字段 6–7 的帖子）');
console.log('-'.repeat(80));
for (const x of lowInfo) {
  const mark = x.conf === 'low' ? 'BLOCKED' : x.conf === 'medium' ? '带警告输出' : '⚠️ 无警告输出';
  console.log(`  ${x.id}  字段 ${x.fields}/9  confidence=${x.conf.padEnd(6)} → ${mark}${x.reason ? `（${x.reason}）` : ''}`);
}
const silentlyHigh = lowInfo.filter((x) => x.conf === 'high');
console.log(`\n  字段不足却仍以 high 强推的：${silentlyHigh.length} 条` +
  (silentlyHigh.length ? ` —— ${silentlyHigh.map((x) => x.id).join(', ')}` : '（无）'));

console.log('\n结论口径：');
console.log(`  · 覆盖率 ${((coveredCount / products.length) * 100).toFixed(1)}% 是真实信号（n=${products.length}）；`);
console.log('  · 命中率样本量小，只作为 M1 的起点基线，不作为验收结论；');
console.log('  · BLOCKED 不计入命中率分母——没出方案就谈不上对错，但它是产品行为的一部分，单独计数。');
