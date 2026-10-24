/**
 * 事实层（Fact Layer）
 * ------------------------------------------------------------------
 * 设计要点（对应 PRD v0.4 §6.5 / 附录 C）：
 *
 * 1. **不在请求链路里跑。** 候选池是固定闭集（23 条），没有理由让用户在
 *    等待的 60 秒里去查 npm。本模块只由 `scripts/build-facts.ts` 在
 *    构建期 / 每日 Cron 调用一次，产物是静态 `facts-snapshot.json`。
 *
 * 2. **绝不跨生态合并版本号。** LangGraph 的 npm 包（1.5.2）和 PyPI 包
 *    （1.2.16）是两个独立发布物，版本号本来就不该相等。跨生态合并是
 *    v0.3 附录 C 的真 bug，本版已修：每条 FactRecord 以
 *    (entryId, ecosystem, packageName) 为唯一键。
 *
 * 3. **同一生态内的多数据源才做交叉验证。** 例如 Maven 同时查
 *    search.maven.org 与 maven-metadata.xml，两者不一致才判 conflict。
 *
 * 4. **版本比较必须数值化。** 禁止 `min(["10.0.0","2.0.0"])`——那是
 *    字典序，会得出 "10.0.0"。见 compareSemver / compareMaven。
 *
 * 5. **失败必须记录原因。** 数据源不可达时写 fail_reason，不静默留空。
 */

export type Ecosystem = 'npm' | 'pypi' | 'maven' | 'dateBuild' | 'manual';

export interface SourceResult {
  source: string;
  version: string | null;
  fail_reason: string | null;
}

export interface FactRecord {
  entry_id: string;
  ecosystem: Ecosystem;
  package: string;
  /** 该生态下的最新稳定版；无法确定时为 null */
  version: string | null;
  /** registry 的 latest 是否指向预发布版（值得在 UI 提示） */
  prerelease_latest: boolean;
  /** 同一生态内多源结果 */
  sources: SourceResult[];
  /** 同一生态内多源版本不一致 */
  conflict: boolean;
  /** 版本号是否适用 semver（uni-app 这类日期构建号不适用） */
  semver_applicable: boolean;
  fail_reason: string | null;
  verified_at: string;
}

export interface GithubFact {
  repo: string;
  stars: number | null;
  pushed_at: string | null;
  activity: 'OK' | 'WARN' | 'EXCLUDE' | 'UNKNOWN';
  fail_reason: string | null;
  verified_at: string;
}

export interface FactsSnapshot {
  generated_at: string;
  /** 生成时使用的 KB 版本，便于发现快照与 KB 不同步 */
  kb_version: string;
  records: FactRecord[];
  github: GithubFact[];
  stats: { total: number; ok: number; failed: number; conflicts: number };
}

/* ------------------------------------------------------------------ */
/* 版本比较：数值化，禁止字符串比较                                      */
/* ------------------------------------------------------------------ */

/** 拆出 [数字段数组, 预发布标识数组] */
function parseSemver(v: string): { nums: number[]; pre: string[] } {
  const [core, pre] = v.split('-', 2);
  const nums = core.split('.').map((s) => {
    const n = parseInt(s.replace(/\D.*$/, ''), 10);
    return Number.isFinite(n) ? n : 0;
  });
  return { nums, pre: pre ? pre.split('.') : [] };
}

/**
 * semver 比较。返回负数表示 a < b。
 * 修复 v0.3 的 bug：`min(["10.0.0","2.0.0"])` 会返回 "10.0.0"。
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x - y;
  }
  // 有预发布标识的版本更低：1.0.0-rc.1 < 1.0.0
  if (pa.pre.length === 0 && pb.pre.length > 0) return 1;
  if (pa.pre.length > 0 && pb.pre.length === 0) return -1;
  const plen = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < plen; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = parseInt(x, 10);
    const ny = parseInt(y, 10);
    const bothNum = Number.isFinite(nx) && Number.isFinite(ny);
    if (bothNum && nx !== ny) return nx - ny;
    if (!bothNum && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Maven 版本比较：数字段优先，限定符按已知顺序 */
const MAVEN_QUALIFIER_ORDER = ['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp'];

export function compareMaven(a: string, b: string): number {
  const split = (v: string) => v.split(/[.\-_]/);
  const sa = split(a);
  const sb = split(b);
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const x = sa[i] ?? '0';
    const y = sb[i] ?? '0';
    const nx = parseInt(x, 10);
    const ny = parseInt(y, 10);
    const bothNum = Number.isFinite(nx) && Number.isFinite(ny);
    if (bothNum) {
      if (nx !== ny) return nx - ny;
      continue;
    }
    const qx = MAVEN_QUALIFIER_ORDER.indexOf(x.toLowerCase());
    const qy = MAVEN_QUALIFIER_ORDER.indexOf(y.toLowerCase());
    const vx = qx === -1 ? 99 : qx;
    const vy = qy === -1 ? 99 : qy;
    if (vx !== vy) return vx - vy;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const PRERELEASE_RE = /-(rc|beta|alpha|dev|canary|next|integration|m\d+|preview|snapshot)/i;

export function isPrerelease(v: string): boolean {
  return PRERELEASE_RE.test(v);
}

/* ------------------------------------------------------------------ */
/* Adapter：每个生态一个，不做通用 getLatest()                           */
/* ------------------------------------------------------------------ */

const UA = { 'User-Agent': 'stackpilot-facts/1.0', Accept: 'application/json' };

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** npm：latest 可能是 RC（实测 prisma → 8.0.0-rc.27），需回退最高稳定版 */
export async function resolveNpm(entryId: string, pkg: string): Promise<FactRecord> {
  const base = baseRecord(entryId, 'npm', pkg);
  try {
    const meta = await fetchJson(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`);
    const tags = meta['dist-tags'] ?? {};
    const latestTag: string | undefined = tags.latest;
    const all: string[] = Object.keys(meta.versions ?? {});
    const stable = all.filter((v) => !isPrerelease(v));
    const chosen = stable.length > 0 ? stable.sort(compareSemver)[stable.length - 1] : latestTag ?? null;
    return {
      ...base,
      version: chosen,
      prerelease_latest: latestTag ? isPrerelease(latestTag) : false,
      sources: [{ source: 'npm:dist-tags', version: chosen, fail_reason: null }],
      fail_reason: chosen ? null : 'no_versions_found',
    };
  } catch (e: any) {
    return { ...base, fail_reason: `npm_unreachable: ${e.message}` };
  }
}

/** PyPI：info.version 通常稳定，但需检查 yanked */
export async function resolvePyPI(entryId: string, pkg: string): Promise<FactRecord> {
  const base = baseRecord(entryId, 'pypi', pkg);
  try {
    const d = await fetchJson(`https://pypi.org/pypi/${pkg}/json`);
    const version: string = d.info?.version ?? '';
    const yanked = (d.urls ?? []).some((u: any) => u.yanked);
    return {
      ...base,
      version: version || null,
      prerelease_latest: version ? isPrerelease(version) : false,
      sources: [{ source: 'pypi:info.version', version: version || null, fail_reason: null }],
      fail_reason: yanked ? 'version_yanked' : null,
    };
  } catch (e: any) {
    return { ...base, fail_reason: `pypi_unreachable: ${e.message}` };
  }
}

/**
 * Maven：坑最多。实测（2026-10-23）Spring Boot 两个官方源互相矛盾：
 *   - search.maven.org 的 latestVersion → 3.5.3（严重过期）
 *   - maven-metadata.xml 的 <release>  → 4.2.0-RC1（是 RC）
 *   - 实际稳定版 → 4.1.2
 * 结论：两个源都不能直接信，必须遍历 versions 自己算。
 */
export async function resolveMaven(entryId: string, group: string, artifact: string): Promise<FactRecord> {
  const base = baseRecord(entryId, 'maven', `${group}:${artifact}`);
  const sources: SourceResult[] = [];
  let chosen: string | null = null;

  try {
    const url = `https://repo1.maven.org/maven2/${group.replace(/\./g, '/')}/${artifact}/maven-metadata.xml`;
    const xml = await fetchText(url);
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
    const stable = versions.filter((v) => !isPrerelease(v));
    chosen = stable.length > 0 ? stable.sort(compareMaven)[stable.length - 1] : null;
    sources.push({ source: 'maven-metadata:versions', version: chosen, fail_reason: null });

    // 交叉验证：search.maven.org（已知会过期，仅作参考，不作为判定依据）
    try {
      const q = encodeURIComponent(`g:"${group}" AND a:"${artifact}"`);
      const s = await fetchJson(
        `https://search.maven.org/solrsearch/select?q=${q}&rows=1&wt=json`
      );
      const stale: string | undefined = s.response?.docs?.[0]?.latestVersion;
      if (stale) sources.push({ source: 'search.maven.org:latestVersion', version: stale, fail_reason: null });
    } catch (e: any) {
      sources.push({ source: 'search.maven.org:latestVersion', version: null, fail_reason: e.message });
    }
  } catch (e: any) {
    return { ...base, sources, fail_reason: `maven_unreachable: ${e.message}` };
  }

  const conflict = hasConflict(sources, compareMaven);
  return {
    ...base,
    version: chosen,
    sources,
    conflict,
    fail_reason: chosen ? null : 'no_stable_version',
  };
}

/**
 * 日期构建号版本（如 uni-app: 2.0.2-5020620260917001）。
 * semver 解析会把它当成预发布，从而被错误排除。
 */
export async function resolveDateBuild(entryId: string, pkg: string): Promise<FactRecord> {
  const base = baseRecord(entryId, 'dateBuild', pkg);
  try {
    const meta = await fetchJson(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`);
    const latest = meta['dist-tags']?.latest ?? null;
    return {
      ...base,
      version: latest,
      semver_applicable: false,
      prerelease_latest: false, // 构建号后缀不是预发布语义，不能当 RC 处理
      sources: [{ source: 'npm:dist-tags', version: latest, fail_reason: null }],
    };
  } catch (e: any) {
    return { ...base, fail_reason: `npm_unreachable: ${e.message}` };
  }
}

/* ------------------------------------------------------------------ */
/* 同一生态内多源交叉验证（不跨生态！）                                  */
/* ------------------------------------------------------------------ */

function hasConflict(sources: SourceResult[], cmp: (a: string, b: string) => number): boolean {
  const versions = sources.map((s) => s.version).filter((v): v is string => !!v);
  if (versions.length < 2) return false;
  const sorted = [...versions].sort(cmp);
  // 语义上"不同版本"即冲突；但要排除 patch 级差异被误报，这里保守全报
  return sorted[0] !== sorted[sorted.length - 1];
}

function baseRecord(entryId: string, ecosystem: Ecosystem, pkg: string): FactRecord {
  return {
    entry_id: entryId,
    ecosystem,
    package: pkg,
    version: null,
    prerelease_latest: false,
    sources: [],
    conflict: false,
    semver_applicable: true,
    fail_reason: null,
    verified_at: new Date().toISOString().slice(0, 10),
  };
}

/* ------------------------------------------------------------------ */
/* GitHub 活跃度（额度敏感，快照化后每周更新一次即可）                    */
/* ------------------------------------------------------------------ */

export function activityFlag(pushedAt: string | null): GithubFact['activity'] {
  if (!pushedAt) return 'UNKNOWN';
  const days = (Date.now() - new Date(pushedAt).getTime()) / 86400000;
  if (days > 730) return 'EXCLUDE';
  if (days > 365) return 'WARN';
  return 'OK';
}

export async function resolveGithub(repo: string, token?: string): Promise<GithubFact> {
  const headers: Record<string, string> = { ...UA };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    if (res.status === 403 || res.status === 429) {
      return {
        repo, stars: null, pushed_at: null, activity: 'UNKNOWN',
        fail_reason: `rate_limited (reset=${res.headers.get('X-RateLimit-Reset')})`,
        verified_at: new Date().toISOString().slice(0, 10),
      };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d: any = await res.json();
    const pushed = d.pushed_at ?? null;
    return {
      repo,
      stars: d.stargazers_count ?? null,
      pushed_at: pushed,
      activity: activityFlag(pushed),
      fail_reason: null,
      verified_at: new Date().toISOString().slice(0, 10),
    };
  } catch (e: any) {
    return {
      repo, stars: null, pushed_at: null, activity: 'UNKNOWN',
      fail_reason: `github_unreachable: ${e.message}`,
      verified_at: new Date().toISOString().slice(0, 10),
    };
  }
}

/* ------------------------------------------------------------------ */
/* 运行时读取（零网络调用）                                             */
/* ------------------------------------------------------------------ */

export interface SnapshotIndex {
  byEntry: Map<string, FactRecord[]>;
  github: Map<string, GithubFact>;
  generatedAt: string;
  /** 快照是否过期（> 7 天），过期时 UI 应提示"数据为 X 天前" */
  stale: boolean;
}

export function indexSnapshot(snapshot: FactsSnapshot): SnapshotIndex {
  const byEntry = new Map<string, FactRecord[]>();
  for (const r of snapshot.records) {
    const list = byEntry.get(r.entry_id) ?? [];
    list.push(r);
    byEntry.set(r.entry_id, list);
  }
  const github = new Map(snapshot.github.map((g) => [g.repo, g]));
  const ageDays = (Date.now() - new Date(snapshot.generated_at).getTime()) / 86400000;
  return { byEntry, github, generatedAt: snapshot.generated_at, stale: ageDays > 7 };
}

/** 给某个组件取"该生态"的版本，绝不做跨生态比较 */
export function versionOf(idx: SnapshotIndex, entryId: string, eco: Ecosystem): string | null {
  const recs = idx.byEntry.get(entryId) ?? [];
  return recs.find((r) => r.ecosystem === eco)?.version ?? null;
}
