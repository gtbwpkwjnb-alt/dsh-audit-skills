/**
 * dsh-audit-skills — DSH 插件体系审查（宿主半体）
 *
 * 主要功能：把插件页（内置 Plugins 页 / 侧边栏）的说明文字精炼为中文。
 * 命名约定（不可违反）：title 保留原包名，中文名以全角括号附加，否则无法识别原插件。
 *
 * 设计边界（见 docs/design-boundaries.md）
 * - 零第三方依赖；apply() 全量 try/catch，任何异常都不外抛（T1 自指崩溃防护）。
 * - 写 node_modules 内文件会被升级/重装覆盖（T2），因此每处写入都留 .dsh-locale.backup。
 * - 只做「精炼 + 汇总 + 报告」；插件更新交给第一方 pluginManager 执行，技能更新只做 git 快进。
 *   推荐 / 守护仍委托生态既有插件。
 * - 不注册 skill：本插件是插件形态，不是技能形态。
 *
 * 开关语义（T3）：bundle 启用 → apply() 应用精炼；停用 → dispose() 默认还原。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-audit-skills'

/** 无需外部服务即可工作；不注入任何阻塞型服务。 */
export const inject = []

export const Config = z.object({
  /** bundle 启用时自动应用精炼结果。 */
  autoApply: z.boolean().default(true),
  /**
   * 关闭本插件时是否还原精炼结果。
   *
   * 默认 false —— Cordis 的 dispose 在「停用插件」和「退出 DSH」两种情况下都会触发。
   * 若在退出时还原，会把已修好的 exports 与 locale 一并撤掉，下次启动时宿主在
   * 读完插件元数据之后（约 +1s）才等到本插件重新写入，导致插件页永远显示上一轮状态。
   * 需要还原请用设置页的「还原翻译」按钮（显式、可控）。
   */
  revertOnDisable: z.boolean().default(false),
  /** 目标 profile 目录；留空按 DSH_HOME 推断并默认 desktop profile。 */
  profileDir: z.string().default(''),
  /** 额外扫描的 profile 目录（多 profile 用户）。 */
  extraProfileDirs: z.array(z.string()).default([]),
})

const PACKAGE_ROOT = fileURLToPath(new URL('./', import.meta.url))

/**
 * 本插件自身版本。会随每个 bridge 响应回传，客户端据此判断**宿主半体是否过旧**——
 * 客户端半体有 HMR 会热更新，宿主半体只在进程启动时加载一次，两者可能版本不一致，
 * 表现就是「按钮是新的、接口是旧的」。
 */
export const OWN_REV = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()
const CATALOG_FILE = path.join(PACKAGE_ROOT, 'references', 'dsh-plugin-locale-catalog.json')
const BACKUP_SUFFIXES = ['.dsh-locale.backup', '.dsh-locale.bak']
const LOCALE_EXPORT_KEY = './locale/*.json'
const LOCALE_EXPORT_VALUE = './locale/*.json'
// 遗留写法：DSH 解析器要求 './locale/*.json'，'./locale/*' 不生效，需迁移
const LEGACY_LOCALE_EXPORT_KEY = './locale/*'
const BRIDGE_PREFIX = '/api/dsh-audit-skills'
const NPM_REGISTRY = 'https://registry.npmjs.org/'

/** 读取精炼目录；任何失败都返回空目录而不是抛错。 */
/** 用户/Agent 可写回的文案覆盖层（不在 node_modules 内，重装不会被覆盖）。 */
export function overlayPath() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-audit-skills', 'catalog.local.json')
}

function readEntries(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(raw.entries) ? raw.entries : []
  } catch {
    return []
  }
}

/**
 * 内置 catalog ∪ 用户覆盖层（overlay 优先）。
 *
 * overlay 是「新装插件」唯一的可补录通路：本插件不调用模型，自己变不出中文，
 * 必须有人把精炼文案写进去。写在 ~/.dsh 下而不是 node_modules，升级/重装都不会丢。
 */
export function readCatalog() {
  const merged = new Map()
  for (const entry of readEntries(CATALOG_FILE)) {
    if (entry && typeof entry.pkg === 'string') merged.set(entry.pkg, entry)
  }
  for (const entry of readEntries(overlayPath())) {
    if (entry && typeof entry.pkg === 'string') merged.set(entry.pkg, entry)
  }
  return Array.from(merged.values())
}

/** 推断 profile 目录：显式配置 > DSH_HOME > ~/.dsh，默认 desktop。 */
export function resolveProfileDirs(config = {}) {
  const dirs = []
  const push = (p) => {
    if (typeof p === 'string' && p !== '' && !dirs.includes(p)) dirs.push(p)
  }
  push(config.profileDir)
  if (Array.isArray(config.extraProfileDirs)) for (const p of config.extraProfileDirs) push(p)
  if (dirs.length === 0) {
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
    push(path.join(home, 'profiles', 'desktop'))
  }
  return dirs
}

/** 该 profile 里已安装的插件包名与启用态。 */
function readProfileManifest(profileDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    return {
      dependencies: Object.keys(pkg.dependencies ?? {}),
      bundles: Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [],
    }
  } catch {
    return undefined
  }
}

/** 该文件是否已有任一形式的备份。 */
function hasAnyBackup(file) {
  return BACKUP_SUFFIXES.some((suffix) => fs.existsSync(file + suffix))
}

function backupOnce(file) {
  const b = file + BACKUP_SUFFIXES[0]
  if (!fs.existsSync(b)) fs.copyFileSync(file, b)
  return b
}

function writeJson(file, value) {
  const next = JSON.stringify(value, null, 2) + '\n'
  try {
    // 内容已一致就不写：避免每次启动刷新 mtime，也避免与宿主读元数据抢时序
    if (fs.readFileSync(file, 'utf8') === next) return false
  } catch {
    /* 文件不存在/不可读 → 继续写 */
  }
  if (fs.existsSync(file)) backupOnce(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, next)
  return true
}

/** 单包状态：是否安装 / 启用 / 已有本插件精炼 / 当前中文标题。 */
export function inspectPackage(profileDir, entry) {
  const dir = path.join(profileDir, 'node_modules', ...entry.pkg.split('/'))
  const manifest = readProfileManifest(profileDir)
  const enabled = manifest ? manifest.bundles.includes(entry.pkg) : undefined
  const installed = fs.existsSync(path.join(dir, 'package.json'))
  let localized = false
  let title = null
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'locale', 'zh.json'), 'utf8'))
    title = j?.meta?.title ?? null
    localized = typeof title === 'string' && title.length > 0
  } catch {
    localized = false
  }
  return { pkg: entry.pkg, installed, enabled, localized, title }
}

/** 判断某个已装依赖是否为 DSH bundle（与插件页同判据）。 */
export function readBundleInfo(profileDir, pkg) {
  if (!isSafePackageName(pkg)) return undefined
  try {
    const dir = path.join(profileDir, 'node_modules', ...pkg.split('/'))
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    if (!manifest.dsh || !manifest.dsh.bundle || !manifest.dsh.bundle.patch) return undefined
    return {
      dir,
      name: manifest.name,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      description: String(manifest.description ?? ''),
    }
  } catch {
    return undefined
  }
}

/**
 * 汇总：只读。
 * 动态发现**已安装的 bundle**（与插件页口径一致），而不是只列 catalog 条目——
 * 这样用户新装插件后会立刻出现在表里并标为待补文案，也能避免把已卸载的插件列成“未安装”。
 */
/**
 * 行构造：全插件**唯一**的行形状来源。
 *
 * 两条取数路径（第一方 pluginManager / 自行扫描）都只能经此函数出行。
 * 此前它们各自拼行，needsText 语义不一致：
 * 服务路径用 !localized（忽略 inCatalog），于是「已有精选文案但尚未应用」的包
 * 被判为待优化 -> 白调一次模型，且模型文案会**覆盖**精选文案（覆盖层优先级更高）。
 *
 * 语义统一为：需要生成文案 ⟺ 既没有内置文案、也没自带 locale 文件。
 */
function buildRow(profileDir, pkg, fields) {
  const st = inspectPackage(profileDir, { pkg })
  const inCatalog = fields.inCatalog === true
  return {
    profileDir,
    pkg,
    installed: fields.installed !== false,
    enabled: fields.enabled === true,
    version: fields.version ?? null,
    error: fields.error ?? null,
    localized: st.localized,
    inCatalog,
    needsText: !inCatalog && !st.localized,
  }
}

export function collectStatus(profileDirs) {
  const entries = readCatalog()
  const byPkg = new Map(entries.map((e) => [e.pkg, e]))
  const dirs = Array.isArray(profileDirs) ? profileDirs : [profileDirs]
  const out = []
  for (const profileDir of dirs) {
    const manifest = readProfileManifest(profileDir)
    if (!manifest) continue
    for (const pkg of manifest.dependencies) {
      const info = readBundleInfo(profileDir, pkg)
      if (info === undefined) continue
      out.push(buildRow(profileDir, pkg, {
        installed: true,
        enabled: manifest.bundles.includes(pkg),
        inCatalog: byPkg.has(pkg),
        version: info.version,
      }))
    }
  }
  return out
}

/** 应用精炼：写入 locale/{en,zh}.json，必要时补 exports 的 ./locale/*。幂等，不抛错。 */
export function applyLocale(profileDirs, options = {}) {
  const entries = options.entries ?? readCatalog()
  const dirs = Array.isArray(profileDirs) ? profileDirs : [profileDirs]
  const results = []
  for (const profileDir of dirs) {
    for (const entry of entries) {
      try {
        const dir = path.join(profileDir, 'node_modules', ...entry.pkg.split('/'))
        const pkgFile = path.join(dir, 'package.json')
        if (!fs.existsSync(pkgFile)) {
          results.push({ pkg: entry.pkg, state: 'skipped-not-installed' })
          continue
        }
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
        let exportNote = 'no-exports-map'
        const hasExports = pkg.exports !== undefined && typeof pkg.exports === 'object' && pkg.exports !== null && !Array.isArray(pkg.exports)
        if (hasExports) {
          const hasModern = Object.hasOwn(pkg.exports, LOCALE_EXPORT_KEY)
          const hasLegacy = Object.hasOwn(pkg.exports, LEGACY_LOCALE_EXPORT_KEY)
          if (!hasModern || hasLegacy) {
            backupOnce(pkgFile)
            if (hasLegacy) delete pkg.exports[LEGACY_LOCALE_EXPORT_KEY]
            pkg.exports[LOCALE_EXPORT_KEY] = LOCALE_EXPORT_VALUE
            fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
            exportNote = hasLegacy ? 'migrated-legacy-locale-export' : 'added-locale-export'
          } else {
            exportNote = 'already-exported'
          }
        }
        writeJson(path.join(dir, 'locale', 'en.json'), { meta: entry.en })
        writeJson(path.join(dir, 'locale', 'zh.json'), { meta: entry.zh })
        results.push({ pkg: entry.pkg, state: 'applied', exportNote })
      } catch (error) {
        results.push({ pkg: entry.pkg, state: 'failed', message: String(error?.message ?? error) })
      }
    }
    // 已装但没有文案的 bundle：明确报出来，而不是静默跳过
    const known = new Set(entries.map((e) => e.pkg))
    const manifest = readProfileManifest(profileDir)
    for (const pkg of manifest ? manifest.dependencies : []) {
      if (known.has(pkg)) continue
      if (readBundleInfo(profileDir, pkg) === undefined) continue
      if (inspectPackage(profileDir, { pkg }).localized) continue
      results.push({ pkg, state: 'needs-catalog', message: '已安装但缺少精炼文案' })
    }
  }
  return results
}

/** 还原：从 .dsh-locale.backup 恢复。不抛错。 */
export function revertLocale(profileDirs, options = {}) {
  const entries = options.entries ?? readCatalog()
  const dirs = Array.isArray(profileDirs) ? profileDirs : [profileDirs]
  const results = []
  for (const profileDir of dirs) {
    for (const entry of entries) {
      try {
        const dir = path.join(profileDir, 'node_modules', ...entry.pkg.split('/'))
        let restored = 0
        let removed = 0
        // 1) 有备份的：恢复（package.json 与 locale 文件）
        const files = [
          path.join(dir, 'package.json'),
          path.join(dir, 'locale', 'en.json'),
          path.join(dir, 'locale', 'zh.json'),
        ]
        for (const file of files) {
          for (const suffix of BACKUP_SUFFIXES) {
            const b = file + suffix
            if (fs.existsSync(b)) {
              fs.copyFileSync(b, file)
              fs.unlinkSync(b)
              restored += 1
            }
          }
        }
        // 2) 没有备份的 locale 文件：这些包原本没有 locale 目录，是我们新建的。
        //    不删除的话「还原翻译」之后仍会显示中文 —— 必须按内容确认是自己写的再删。
        const owned = []
        if (entry.en !== undefined) owned.push([path.join(dir, 'locale', 'en.json'), JSON.stringify({ meta: entry.en }, null, 2) + '\n'])
        if (entry.zh !== undefined) owned.push([path.join(dir, 'locale', 'zh.json'), JSON.stringify({ meta: entry.zh }, null, 2) + '\n'])
        for (const pair of owned) {
          const file = pair[0]
          const wanted = pair[1]
          if (hasAnyBackup(file)) continue
          try {
            if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === wanted) {
              fs.unlinkSync(file)
              removed += 1
            }
          } catch {
            /* 单个文件失败不影响其他 */
          }
        }
        try {
          const localeDir = path.join(dir, 'locale')
          if (fs.existsSync(localeDir) && fs.readdirSync(localeDir).length === 0) fs.rmdirSync(localeDir)
        } catch {
          /* 目录非空或其他原因，忽略 */
        }
        const state = restored > 0 || removed > 0 ? 'restored' : 'no-backup'
        results.push({ pkg: entry.pkg, state, restored, removed })
      } catch (error) {
        results.push({ pkg: entry.pkg, state: 'failed', message: String(error?.message ?? error) })
      }
    }
  }
  return results
}

/**
 * 复用第一方插件管理器服务。
 * 它的 `listBundles()` 就是插件页用的那份数据 —— 同一个数据源才能保证两端一致，
 * 也能天然覆盖「新装插件」。
 */
export function getPluginManager(ctx) {
  try {
    const pm = ctx.get('pluginManager')
    return pm && typeof pm.listBundles === 'function' ? pm : undefined
  } catch {
    return undefined
  }
}

/** 用插件管理器的数据构造状态表（与插件页同源）；服务不可用时返回 undefined。 */
export function collectStatusViaService(ctx, dirs) {
  const pm = getPluginManager(ctx)
  if (pm === undefined) return undefined
  const profileDir = Array.isArray(dirs) ? dirs[0] : dirs
  try {
    const list = pm.listBundles()
    if (!Array.isArray(list)) return undefined
    const catalogPkgs = new Set(readCatalog().map((e) => e.pkg))
    return list.map((b) => buildRow(profileDir, b.name, {
      installed: b.installed !== false,
      enabled: b.enabled === true,
      version: typeof b.version === 'string' ? b.version : null,
      error: b.error ? String(b.error.code ?? b.error) : null,
      inCatalog: catalogPkgs.has(b.name),
    }))
  } catch (error) {
    return undefined
  }
}

/**
 * 最新版本缓存。
 *
 * 「刷新」现在一次拿全（状态 + 版本比对），所以必须避免每次都打 N 次 npm。
 * 成功缓存 5 分钟，失败只缓存 30 秒（便于快速重试）。
 */
const LATEST_TTL_OK_MS = 5 * 60 * 1000
const LATEST_TTL_FAIL_MS = 30 * 1000
const latestCache = new Map()

/** 清空版本缓存（force 刷新时用）。 */
export function clearLatestCache() {
  latestCache.clear()
}

/** 取某包的最新版本，带 TTL 缓存。 */
export async function latestVersionCached(pkg, force) {
  const hit = latestCache.get(pkg)
  if (force !== true && hit !== undefined) {
    const ttl = hit.latest === null ? LATEST_TTL_FAIL_MS : LATEST_TTL_OK_MS
    if (Date.now() - hit.at < ttl) return hit
  }
  const r = await fetchLatestVersion(pkg)
  const entry = r.status === 'ok'
    ? { latest: r.latest, reason: null, at: Date.now() }
    : { latest: null, reason: r.reason ?? 'unavailable', at: Date.now() }
  latestCache.set(pkg, entry)
  return entry
}

/** 查 npm 上的最新版本；git 安装或非 npm 包返回 unavailable（不猜）。 */
export async function fetchLatestVersion(name) {
  try {
    const res = await fetch(NPM_REGISTRY + name.split('/').map(encodeURIComponent).join('/'), {
      signal: AbortSignal.timeout(15000),
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!res.ok) return { status: 'unavailable', reason: 'HTTP ' + res.status }
    const doc = await res.json()
    const latest = doc && doc['dist-tags'] && doc['dist-tags'].latest
    return typeof latest === 'string' ? { status: 'ok', latest } : { status: 'unavailable', reason: 'no dist-tags' }
  } catch (error) {
    return { status: 'unavailable', reason: String((error && error.message) || error) }
  }
}

/** 进行中的更新任务：token → 阶段状态。仅内存，重启即清空。 */
const updateJobs = new Map()
/** 只保留最近若干条已完成任务，避免长时间运行后无限增长。 */
const UPDATE_JOB_KEEP = 20
function pruneUpdateJobs() {
  if (updateJobs.size <= UPDATE_JOB_KEEP) return
  const finished = []
  for (const [key, job] of updateJobs) if (job && job.done === true) finished.push(key)
  while (updateJobs.size > UPDATE_JOB_KEEP && finished.length > 0) updateJobs.delete(finished.shift())
}

/** 读取 profile 原始清单（需要依赖范围，不只依赖名）。 */
export function readProfileManifestRaw(profileDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 解析更新该包应当使用的 spec。
 *
 * 关键：GitHub 直装的包**不能**加 @latest —— npm 上根本不存在它（我们实测返回 404），
 * 加了只会落到同一个 git 解析、版本不变。必须原样回传 git spec。
 */
export function resolveUpdateSpec(profileDir, pkg) {
  const raw = readProfileManifestRaw(profileDir)
  const range = raw && raw.dependencies ? raw.dependencies[pkg] : undefined
  if (typeof range !== 'string' || range === '') {
    return { kind: 'unknown', spec: null, range: null, reason: '该包不在 profile 依赖里（可能是内置 bundle），无法更新' }
  }
  if (range.startsWith('github:') || range.startsWith('git+') || range.includes('github.com/')) {
    return { kind: 'git', spec: range, range, reason: null }
  }
  if (range.startsWith('file:') || range.startsWith('link:') || range.startsWith('workspace:')) {
    return { kind: 'local', spec: null, range, reason: '本地路径依赖，请手动更新' }
  }
  return { kind: 'registry', spec: pkg + '@latest', range, reason: null }
}

/** 启动一次更新：立即返回 token，真实进度用 updateJobStatus 轮询（避免长请求卡死界面）。 */
/**
 * 更新后的统一收尾：补回被 pnpm 洗掉的优化结果 + 取变化提示。
 * **单包与批量共用**，避免两条路径行为分叉（这正是之前多处不一致的来源）。
 */
export async function finishAfterUpdate(profileDir, pkg, from, to) {
  let refined = false
  const entry = readCatalog().filter((e) => e.pkg === pkg)
  if (entry.length > 0) {
    try {
      applyLocale([profileDir], { entries: entry })
      refined = inspectPackage(profileDir, { pkg }).localized === true
    } catch {
      /* 补回失败不影响更新本身 */
    }
  }
  let delta = null
  if (typeof from === 'string' && typeof to === 'string' && from !== to) {
    try {
      delta = await describeUpdateDelta(profileDir, pkg, from, to)
    } catch {
      /* 变化提示失败不影响更新本身 */
    }
  }
  return { refined, delta }
}

export function startUpdate(ctx, profileDir, pkg) {
  const plan = resolveUpdateSpec(profileDir, pkg)
  if (plan.spec === null) return { ok: false, code: 'unsupported-spec', message: plan.reason }
  const pm = getPluginManager(ctx)
  if (pm === undefined) return { ok: false, code: 'manager-unavailable', message: '插件管理器服务未就绪（重启 DSH 后可用）' }
  if (typeof pm.installBundle !== 'function') return { ok: false, code: 'manager-unsupported', message: '插件管理器未提供 installBundle' }
  const token = pkg + ':' + Date.now().toString(36)
  const base = { pkg, spec: plan.spec, kind: plan.kind, startedAt: Date.now() }
  updateJobs.set(token, Object.assign({}, base, { stage: 'installing', message: '正在执行安装（pnpm，可能持续数十秒）…', done: false, ok: null }))
  installAndWait(ctx, profileDir, pkg)
    .then(async (result) => {
      const job = updateJobs.get(token) ?? base
      const finished = await finishAfterUpdate(profileDir, pkg, result.from, result.to)
      const suffix = (finished.refined === true ? ' 优化已保持。' : '') + (finished.delta !== null ? ' ' + describeDeltaText(finished.delta) : '')
      pruneUpdateJobs()
      updateJobs.set(token, Object.assign({}, job, {
        stage: result.ok === true ? 'done' : 'failed',
        message: result.ok === true
          ? '安装执行完成。' + suffix
          : String(result.message || '更新失败'),
        done: true,
        ok: result.ok === true,
        from: result.from ?? null,
        to: result.to ?? null,
        refined: finished.refined,
        delta: finished.delta,
      }))
    })
    .catch((error) => {
      const job = updateJobs.get(token) ?? base
      pruneUpdateJobs()
      updateJobs.set(token, Object.assign({}, job, { stage: 'failed', message: String((error && error.message) || error), done: true, ok: false }))
    })
  return { ok: true, token, plan: { kind: plan.kind, spec: plan.spec, range: plan.range } }
}

/** 从 CHANGELOG 文本里抽取某个版本号所在的小节。 */
function extractVersionSection(text, version) {
  const lines = String(text).split(/\r?\n/)
  const start = lines.findIndex((line) => /^#{1,3}\s/.test(line) && line.includes(version))
  if (start < 0) return undefined
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,3}\s/.test(lines[i])) break
    out.push(lines[i])
  }
  const body = out.join('\n').trim()
  return body === '' ? undefined : body.slice(0, 600)
}

/** 读包内自带的变更日志（最权威的来源）。 */
export function readLocalChangelog(profileDir, pkg, version) {
  if (!isSafePackageName(pkg)) return undefined
  const dir = path.join(profileDir, 'node_modules', ...pkg.split('/'))
  for (const name of ['CHANGELOG.md', 'CHANGELOG', 'CHANGELOG.markdown', 'CHANGES.md', 'HISTORY.md']) {
    try {
      const section = extractVersionSection(fs.readFileSync(path.join(dir, name), 'utf8'), version)
      if (section !== undefined) return section
    } catch {
      /* 试下一个文件名 */
    }
  }
  return undefined
}

/**
 * 从 registry 元数据里做**结构性差异**。
 *
 * 本机实测：这些插件**都不随包提供 CHANGELOG**，所以"是修 bug 还是加功能"无法直接得知。
 * 能做的是给出客观结构信号（说明文字/依赖/发布时间），并明确标注这是**推断**而非事实，
 * 同时把仓库地址交出去让用户自己看 release notes。
 */
export async function fetchVersionDelta(pkg, from, to) {
  try {
    const res = await fetch(NPM_REGISTRY + pkg.split('/').map(encodeURIComponent).join('/'), {
      signal: AbortSignal.timeout(15000),
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!res.ok) return { status: 'unavailable', reason: 'HTTP ' + res.status }
    const doc = await res.json()
    const a = doc.versions ? doc.versions[from] : undefined
    const b = doc.versions ? doc.versions[to] : undefined
    if (a === undefined || b === undefined) return { status: 'unavailable', reason: '缺少版本元数据' }
    const details = []
    if (String(a.description ?? '') !== String(b.description ?? '')) details.push('说明文字已变更（用途可能变化）')
    const da = Object.keys(a.dependencies ?? {})
    const db = Object.keys(b.dependencies ?? {})
    const added = db.filter((x) => !da.includes(x))
    const removed = da.filter((x) => !db.includes(x))
    if (added.length > 0) details.push('新增依赖 ' + added.slice(0, 5).join('、'))
    if (removed.length > 0) details.push('移除依赖 ' + removed.slice(0, 5).join('、'))
    const rawRepo = b.repository === undefined ? b.homepage : (typeof b.repository === 'string' ? b.repository : b.repository.url)
    return {
      status: 'ok',
      details,
      published: doc.time === undefined ? null : (doc.time[to] ?? null),
      repoUrl: typeof rawRepo === 'string' ? rawRepo.replace(/^git\+/, '').replace(/\.git$/, '') : null,
    }
  } catch (error) {
    return { status: 'unavailable', reason: String((error && error.message) || error) }
  }
}

/**
 * 汇总一次更新的"变化提示"。
 * 优先级：包内 CHANGELOG（事实）> registry 结构性差异（推断）> 无法判定。
 */
/** 把变化提示转成一句人话（明确区分"事实"与"推断"）。 */
export function describeDeltaText(delta) {
  if (delta === undefined || delta === null) return ''
  if (delta.source === 'changelog') return '变更日志：' + String(delta.text).replace(/\s+/g, ' ').slice(0, 200)
  if (delta.source === 'structure') {
    const head = (Array.isArray(delta.details) && delta.details.length > 0)
      ? '检出结构性变化（推断，非作者说明）：' + delta.details.join('；')
      : '未检出结构性变化（依赖与说明均未变）'
    return head + '。该包未随包提供变更日志，无法判定是修复还是新增功能。' + (delta.repoUrl ? ' 仓库：' + delta.repoUrl : '')
  }
  return '无法获取变更信息' + (delta.reason ? '（' + delta.reason + '）' : '') + '。'
}

/** 从 registry spec（pkg@x.y.z）里取出目标版本。 */
function latestVersionFromSpec(spec) {
  const m = /@([^@/]+)$/.exec(String(spec ?? ''))
  return m === null ? undefined : m[1]
}

export async function describeUpdateDelta(profileDir, pkg, from, to) {
  const changelog = readLocalChangelog(profileDir, pkg, to)
  if (changelog !== undefined) return { source: 'changelog', text: changelog, details: [], repoUrl: null }
  const delta = await fetchVersionDelta(pkg, from, to)
  if (delta.status !== 'ok') return { source: 'unavailable', text: '', details: [], repoUrl: null, reason: delta.reason }
  return { source: 'structure', text: '', details: delta.details, repoUrl: delta.repoUrl, published: delta.published }
}

// ───────────────────────── 审查规则引擎 ─────────────────────────
//
// 设计约束（与用户确认过）：
//  · 只报告，不动作 —— 绝不自动停用/修改任何插件
//  · 没有证据的条目不进列表 —— 误报代价远大于漏报
//  · 每条发现必须标 confidence：fact（机械可验证）或 inferred（推断）
//  · 不评分 —— 伪精确的数字我们无法负责
//  · 绝不在 apply() 里跑扫描；懒加载 + TTL 缓存；单项失败只跳过该项

const AUDIT_TTL_MS = 10 * 60 * 1000
let auditCache = null

/** 「忽略此条」的持久化位置（本功能唯一的写入点）。 */
function ignoredPath() {
  return path.join(path.dirname(overlayPath()), 'ignored.json')
}

/** 读忽略列表。 */
export function readIgnored() {
  try {
    const doc = JSON.parse(fs.readFileSync(ignoredPath(), 'utf8'))
    return Array.isArray(doc.ids) ? doc.ids.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 忽略一条发现（幂等）。 */
export function ignoreFinding(id) {
  if (typeof id !== 'string' || id === '') return { ok: false, message: '缺少 id' }
  try {
    const ids = readIgnored()
    if (!ids.includes(id)) ids.push(id)
    const file = ignoredPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ note: '被用户忽略的审查条目 id。', ids }, null, 2) + '\n')
    return { ok: true, total: ids.length }
  } catch (error) {
    return { ok: false, message: String((error && error.message) || error) }
  }
}

/** 清空审查缓存。 */
export function clearAuditCache() {
  auditCache = null
}

/** 读已安装包的原始 manifest。 */
function readInstalledManifest(profileDir, pkg) {
  if (!isSafePackageName(pkg)) return undefined
  try {
    return JSON.parse(fs.readFileSync(path.join(profileDir, 'node_modules', ...pkg.split('/'), 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 解析一份 cordis 补丁，区分「新增行」与「覆盖行」。
 *
 * 实测结构：`insert:` 下带 `name:` 的子条目是**新增行**；
 * 顶层只有 `id:` + `config:` 的是**覆盖已有行**——这个区分必须准确，
 * 否则会把"自己新挂一行"误报成"覆盖了别人的行"。
 */
export function parsePatchTargets(text) {
  const inserts = []
  const overrides = []
  let insertIndent = -1
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const indent = /^(\s*)/.exec(line)[1].length
    if (insertIndent >= 0 && indent <= insertIndent) insertIndent = -1
    if (/insert:\s*$/.test(line)) {
      insertIndent = indent
      continue
    }
    const m = /-\s*id:\s*(\S+)/.exec(line)
    if (m === null) continue
    const id = m[1].replace(/['"]/g, '')
    if (insertIndent >= 0 && indent > insertIndent) inserts.push(id)
    else overrides.push(id)
  }
  return { inserts, overrides }
}

/** 读某个已装 bundle 的补丁目标。 */
function readPatchTargets(profileDir, pkg) {
  const manifest = readInstalledManifest(profileDir, pkg)
  const rel = manifest && manifest.dsh && manifest.dsh.bundle ? manifest.dsh.bundle.patch : undefined
  if (typeof rel !== 'string' || rel === '') return undefined
  const file = path.join(profileDir, 'node_modules', ...pkg.split('/'), rel.replace(/^\.\//, ''))
  try {
    return Object.assign({ file: rel }, parsePatchTargets(fs.readFileSync(file, 'utf8')))
  } catch {
    return undefined
  }
}

/** 随 DSH 本体提供的包名集合（只走 asar 头部，不展开全部文件）。 */
function dshAppPackages() {
  const override = process.env.DSH_APP_ASAR
  const resources = process.resourcesPath
  const asar = typeof override === 'string' && override !== ''
    ? override
    : (typeof resources === 'string' && resources !== '' ? path.join(resources, 'app.asar') : undefined)
  if (asar === undefined) return undefined
  try {
    const fd = fs.openSync(asar, 'r')
    try {
      const head = Buffer.alloc(16)
      fs.readSync(fd, head, 0, 16, 0)
      const size = head.readUInt32LE(4)
      const raw = Buffer.alloc(size)
      fs.readSync(fd, raw, 0, size, 8)
      const text = raw.toString('utf8')
      const start = text.indexOf('{')
      let depth = 0
      let inStr = false
      let esc = false
      let end = -1
      for (let i = start; i < text.length; i += 1) {
        const ch = text[i]
        if (inStr) {
          if (esc) esc = false
          else if (ch === '\\') esc = true
          else if (ch === '"') inStr = false
          continue
        }
        if (ch === '"') inStr = true
        else if (ch === '{') depth += 1
        else if (ch === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
      }
      const names = new Set()
      const header = JSON.parse(text.slice(start, end))
      for (const [name, val] of Object.entries(header.files || {})) {
        const nm = val.files && val.files.node_modules
        if (nm === undefined || nm.files === undefined) continue
        for (const [pkgName, pkgVal] of Object.entries(nm.files)) {
          if (pkgName.startsWith('@')) {
            for (const sub of Object.keys(pkgVal.files || {})) names.add(pkgName + '/' + sub)
          } else names.add(pkgName)
        }
      }
      return names
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}

/** 读 profile 用户补丁层关心的行 id。 */
function readUserPatchIds(profileDir) {
  try {
    return parsePatchTargets(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')).overrides
  } catch {
    return []
  }
}

/**
 * 审查全部已装插件，返回 { generatedAt, findings, byPkg, counts }。
 * findings 为全局列表；byPkg 便于表格行内展示。
 */
export function auditPackages(ctx, profileDir) {
  if (auditCache !== null && Date.now() - auditCache.at < AUDIT_TTL_MS) return auditCache.result
  const findings = []
  const add = (f) => { findings.push(Object.assign({ id: f.kind + ':' + f.key }, f)) }
  try {
    const list = collectStatusViaService(ctx, [profileDir]) ?? collectStatus([profileDir])
    const pkgs = list.map((r) => r.pkg)
    const patchByPkg = new Map()
    const ownInsertIds = new Set()
    for (const pkg of pkgs) {
      const t = readPatchTargets(profileDir, pkg)
      if (t !== undefined) {
        patchByPkg.set(pkg, t)
        for (const id of t.inserts) ownInsertIds.add(id)
      }
    }
    const appPkgs = dshAppPackages()
    const userIds = new Set(readUserPatchIds(profileDir))
    // R1 dsh.client.inject 模块可满足性（正是让 DSH 起不来的那一类）
    for (const pkg of pkgs) {
      const manifest = readInstalledManifest(profileDir, pkg)
      const inject = manifest && manifest.dsh && manifest.dsh.client ? manifest.dsh.client.inject : undefined
      if (!Array.isArray(inject)) continue
      for (const mod of inject) {
        if (typeof mod !== 'string' || mod === '') continue
        const inProfile = fs.existsSync(path.join(profileDir, 'node_modules', ...mod.split('/'), 'package.json'))
        if (inProfile) continue
        if (appPkgs === undefined) {
          add({ kind: 'conflict', key: 'inject-' + pkg + '-' + mod, pkg, peers: [], severity: 'low', confidence: 'inferred',
            title: '客户端依赖 ' + mod + ' 无法确认是否可满足',
            evidence: 'dsh.client.inject 声明了 ' + mod + '，既不在 profile 中，也无法读取 DSH 本体清单',
            remedy: '若该模块缺失，客户端半体会激活失败并导致界面无法启动；可在插件页确认其是否正常加载。' })
          continue
        }
        if (!appPkgs.has(mod)) {
          // 事实只是"该依赖不存在"；**后果未经验证** ——
          // 实机有一个插件（dsh-sidebar-qa）带着同样的缺失却运行正常，
          // 所以不能断言它会致命。宁可把话说到能证明的程度。
          add({ kind: 'conflict', key: 'inject-' + pkg + '-' + mod, pkg, peers: [], severity: 'medium', confidence: 'fact',
            title: '客户端依赖 ' + mod + ' 在任何位置都不存在',
            evidence: 'dsh.client.inject 声明 ' + mod + '；profile 与 DSH 本体（app.asar 的 284 个 @deepseek-ai 包）中均未找到',
            remedy: '依赖声明可能写错了。DSH 对缺失注入项的严格程度我未验证（本机上另一插件有同类缺失却工作正常），所以不判定它致命；若该插件加载正常可忽略此条。' })
        }
      }
    }
    // R2 覆盖了**非自身**的 loader 行
    for (const [pkg, t] of patchByPkg) {
      for (const id of Array.from(new Set(t.overrides))) {
        if (ownInsertIds.has(id) || id === pkg) continue
        add({ kind: 'conflict', key: 'override-' + pkg + '-' + id, pkg, peers: [], severity: 'medium', confidence: 'fact',
          title: '覆盖了非自身的 loader 行 ' + id,
          evidence: t.file + ' → id: ' + id + '（未声明 name，属覆盖已有行）',
          remedy: '该行由平台或其他插件提供，覆盖会改变它们的行为。请确认这是你的本意。' })
      }
    }
    // R3 两个及以上插件覆盖同一行
    const byTarget = new Map()
    for (const [pkg, t] of patchByPkg) {
      for (const id of Array.from(new Set(t.overrides))) {
        if (!byTarget.has(id)) byTarget.set(id, [])
        byTarget.get(id).push(pkg)
      }
    }
    for (const [id, who] of byTarget) {
      if (who.length < 2) continue
      add({ kind: 'conflict', key: 'dup-' + id, pkg: who[0], peers: who.slice(1), severity: 'high', confidence: 'fact',
        title: '多个插件覆盖同一行 ' + id,
        evidence: who.join('、') + ' 都覆盖了 ' + id + '，后者会覆盖前者的配置',
        remedy: '后安装者胜出。若需要两者共存，请把它们对该行的 config 合并到 profile 的 patch 层。' })
    }
    // R4 用户 patch 层与插件自身 patch 撞名（推断）
    for (const [pkg, t] of patchByPkg) {
      const touched = Array.from(new Set(t.overrides.concat(t.inserts)))
      const hit = touched.filter((id) => userIds.has(id))
      for (const id of hit) {
        add({ kind: 'interaction', key: 'userpatch-' + pkg + '-' + id, pkg, peers: [], severity: 'low', confidence: 'inferred',
          title: '与用户补丁层同样涉及 ' + id,
          evidence: 'profile 的 cordis.patch.yml 与 ' + t.file + ' 都涉及 ' + id,
          remedy: '通常属正常覆盖关系，仅供知悉：两层配置会按加载顺序合并。' })
      }
    }
    // R6 两个插件共享同一个客户端模块（推断）
    const injectByPkg = new Map()
    for (const pkg of pkgs) {
      const manifest = readInstalledManifest(profileDir, pkg)
      const inject = manifest && manifest.dsh && manifest.dsh.client ? manifest.dsh.client.inject : undefined
      if (Array.isArray(inject)) injectByPkg.set(pkg, inject.filter((x) => typeof x === 'string'))
    }
    const pkgList = Array.from(injectByPkg.keys())
    for (let i = 0; i < pkgList.length; i += 1) {
      for (let j = i + 1; j < pkgList.length; j += 1) {
        const a = injectByPkg.get(pkgList[i])
        const b = injectByPkg.get(pkgList[j])
        // 只关注**非平台**模块的共享：@deepseek-ai/* 是人人都会用的基础模块，
        // 把它们算作"关联"会产出大量无意义条目（实测 16 条全是噪音）。
        const shared = a.filter((x) => b.includes(x) && !x.startsWith('@deepseek-ai/'))
        if (shared.length === 0) continue
        // 一对只出一条（此前两个方向各出一条，重复）
        add({ kind: 'interaction', key: 'sharedinject-' + pkgList[i] + '-' + pkgList[j], pkg: pkgList[i],
          peers: [pkgList[j]], severity: 'low', confidence: 'inferred',
          title: '与 ' + pkgList[j] + ' 共用非平台客户端模块',
          evidence: '共享 ' + shared.join('、'),
          remedy: '两者依赖同一个第三方客户端模块，可能同时出现在界面上；不代表会冲突。' })
      }
    }
    // R5 未声明 DSH 兼容性（汇总，不逐行）
    const noCompat = []
    for (const pkg of pkgs) {
      const manifest = readInstalledManifest(profileDir, pkg)
      if (manifest === undefined) continue
      const dsh = manifest.dsh || {}
      const hasEngines = dsh.engines && typeof dsh.engines.dsh === 'string' && dsh.engines.dsh !== ''
      const hasCompat = dsh.compatibility && dsh.compatibility.dshReleases && Object.keys(dsh.compatibility.dshReleases).length > 0
      if (!hasEngines && !hasCompat) noCompat.push(pkg)
    }
    const byPkg = new Map()
    for (const f of findings) {
      if (!byPkg.has(f.pkg)) byPkg.set(f.pkg, [])
      byPkg.get(f.pkg).push(f)
    }
    const result = {
      generatedAt: Date.now(),
      findings,
      byPkg,
      counts: {
        high: findings.filter((f) => f.severity === 'high').length,
        medium: findings.filter((f) => f.severity === 'medium').length,
        low: findings.filter((f) => f.severity === 'low').length,
        fact: findings.filter((f) => f.confidence === 'fact').length,
        inferred: findings.filter((f) => f.confidence === 'inferred').length,
      },
      noCompat,
    }
    auditCache = { at: Date.now(), result }
    return result
  } catch {
    // 审查整体失败时返回空结果，绝不影响主流程
    return { generatedAt: Date.now(), findings: [], byPkg: new Map(), counts: { high: 0, medium: 0, low: 0, fact: 0, inferred: 0 }, noCompat: [] }
  }
}

// ───────────────────────── 技能（skills）─────────────────────────
//
// 与插件侧**同构**：一个数据源、一套行形状、一组审查规则。
// 但三点本质不同，必须区别对待（照搬会出错）：
//   1. 技能不是 npm 包 —— 没有 registry 可比版本；只有 git 来源的目录能比对远端
//   2. 技能的 description 是**给模型看的**（技能选择依据），不是纯展示
//      → 改写它是**行为变更**：必须由用户显式点击，且写前留 .dsh-skill.backup 备份、可逐字节还原
//   3. 发现规则是"仅顶层 <name>/SKILL.md 或 <name>.md"，嵌套的不会被发现

// ───────────────────────── git：技能的「更新」─────────────────────────
//
// 技能不是 npm 包，没有 registry 可比版本；只有 **git 仓库形态**的技能才有更新可言。
// 这里只用 git 自身的语义，不发明版本号：
//   ls-remote      → 远端分支此刻指向哪个提交（只读，不动本地任何东西）
//   pull --ff-only → 只做快进；本地分叉就如实失败，绝不产生合并提交或冲突标记
//   工作区         → 有未提交修改时由 git 自己拒绝，我们把它的原话转述出来，不代你 stash
//
// 所有 git 调用都带 GIT_TERMINAL_PROMPT=0：宁可立刻失败，也不能让宿主的 HTTP 请求
// 卡在凭据提示上（那会让整个设置页看起来死掉）。
const GIT_BIN = process.env.DSH_GIT_BIN ?? 'git'
const GIT_TIMEOUT_MS = 20000
const PULL_TIMEOUT_MS = 60000
const GIT_ENV = Object.assign({}, process.env, {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  GCM_INTERACTIVE: 'Never',
})

/** 运行 git（异步，带限时）；永不抛错，失败也是一份可读结果。 */
function gitRun(args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => { if (settled !== true) { settled = true; resolve(value) } }
    try {
      execFile(GIT_BIN, args, {
        cwd,
        timeout: timeoutMs ?? GIT_TIMEOUT_MS,
        env: GIT_ENV,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        const failed = error !== null && error !== undefined
        finish({
          ok: failed !== true,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: failed === true && (error.killed === true || (error.signal !== undefined && error.signal !== null)),
        })
      })
    } catch (error) {
      finish({ ok: false, stdout: '', stderr: String((error && error.message) || error), timedOut: false })
    }
  })
}

/** 同步版：只用于**本地**查询（不联网），免得为每个技能都开一圈 Promise。 */
function gitSync(args, cwd, timeoutMs) {
  try {
    const out = execFileSync(GIT_BIN, args, {
      cwd,
      timeout: timeoutMs ?? GIT_TIMEOUT_MS,
      env: GIT_ENV,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return { ok: true, stdout: String(out ?? '') }
  } catch {
    return { ok: false, stdout: '' }
  }
}

/** 路径比较：Windows 上分隔符与大小写都不敏感。 */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  return norm(a) === norm(b)
}

/** 短提交号（对外展示用）。 */
export function shortSha(sha) {
  return typeof sha === 'string' && sha.length >= 8 ? sha.slice(0, 8) : (typeof sha === 'string' ? sha : '')
}

/**
 * 一个技能目录的 git 事实（只读、本地、不问网络）。
 * @param dir - 技能目录（不是 SKILL.md）
 * @returns isGit 为 false 时只有这一个字段；否则给出仓库根、分支、HEAD、远端、未提交文件数
 */
export function skillRepoInfo(dir) {
  const top = gitSync(['rev-parse', '--show-toplevel'], dir)
  if (top.ok !== true) return { isGit: false }
  const repoRoot = top.stdout.trim()
  const branch = gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], dir).stdout.trim()
  const status = gitSync(['status', '--porcelain'], dir)
  return {
    isGit: true,
    repoRoot,
    /** 仓库根就是这个技能目录吗？否则一次 pull 会连带改掉同仓库里的其他技能。 */
    owned: samePath(repoRoot, dir),
    branch: branch === 'HEAD' ? '' : branch,
    head: gitSync(['rev-parse', 'HEAD'], dir).stdout.trim(),
    url: gitSync(['remote', 'get-url', 'origin'], dir).stdout.trim(),
    upstream: gitSync(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], dir).stdout.trim(),
    dirty: status.ok === true ? status.stdout.split('\n').filter((line) => line.trim() !== '').length : 0,
  }
}

const REMOTE_TTL_OK_MS = 5 * 60 * 1000
const REMOTE_TTL_FAIL_MS = 30 * 1000
const remoteShaCache = new Map()

/**
 * 远端分支现在指向哪个提交；带 TTL 缓存，失败不猜（sha 为 null 时 reason 说明为什么）。
 * @param row - 含 repoRoot/branch/url 的技能行
 * @param force - true 时绕过缓存（「刷新状态」走这条）
 */
export async function remoteShaFor(row, force) {
  const key = String(row.repoRoot) + '|' + String(row.branch)
  const hit = remoteShaCache.get(key)
  if (force !== true && hit !== undefined) {
    const ttl = hit.sha === null ? REMOTE_TTL_FAIL_MS : REMOTE_TTL_OK_MS
    if (Date.now() - hit.at < ttl) return hit
  }
  let entry
  if (row.url === '') {
    entry = { sha: null, reason: '未配置 origin 远端', at: Date.now() }
  } else if (row.branch === '') {
    entry = { sha: null, reason: '处于游离 HEAD，未知分支', at: Date.now() }
  } else {
    const r = await gitRun(['ls-remote', '--heads', 'origin', 'refs/heads/' + row.branch], row.repoRoot)
    const first = r.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')[0] ?? ''
    const sha = first.split(/\s+/)[0] ?? ''
    if (r.ok === true && /^[0-9a-f]{7,40}$/.test(sha)) {
      entry = { sha, reason: null, at: Date.now() }
    } else {
      const firstErr = r.stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '')[0] ?? '未知原因'
      entry = { sha: null, reason: r.timedOut === true ? '远端查询超时' : ('远端不可达：' + firstErr), at: Date.now() }
    }
  }
  remoteShaCache.set(key, entry)
  return entry
}

/**
 * 给技能行补上「远端是否已变化」。只对 git 行联网，其余原样返回。
 * @param rows - collectSkills 的结果
 * @param force - 绕过远端缓存
 */
export async function enrichSkillUpdates(rows, force) {
  return Promise.all(rows.map(async (row) => {
    if (row.isGit !== true) return Object.assign({}, row, { hasUpdate: null, remoteSha: null })
    const info = await remoteShaFor(row, force)
    const hasUpdate = info.sha === null ? null : (row.localSha !== '' && info.sha !== row.localSha)
    return Object.assign({}, row, { remoteSha: info.sha, hasUpdate, reason: info.reason })
  }))
}

/** git 的失败原话 → 人话；永远保留原话，不编造结论。 */
export function describeGitFailure(result) {
  const text = (String(result.stderr) + '\n' + String(result.stdout)).trim()
  const first = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')[0] ?? ''
  if (result.timedOut === true) return '超时：git 未在限时内返回（可能仍在后台执行）'
  if (/not possible to fast-forward|divergent branches|non-fast-forward/i.test(text)) return '本地与远端已分叉，不能快进 —— 需要你手动处理（本插件不会自动合并）'
  if (/local changes|would be overwritten/i.test(text)) return '本地有未提交修改，快进会覆盖它们，git 已中止 —— 请先提交或暂存（本插件不动你的工作区）'
  if (/could not resolve host|unable to access|connection|network|authentication/i.test(text)) return '远端不可达（网络或凭据）：' + first
  return first === '' ? 'git 失败（无输出）' : first
}

/** 单个技能的更新：只做快进；每一种「不能更新」都给得出理由。 */
async function updateOneSkill(row, pkg) {
  if (row === undefined) return { pkg, state: 'failed', message: '技能不存在（可能已被移除）' }
  if (row.isGit !== true) return { pkg, state: 'failed', message: '不是 git 仓库：本地目录无远端可比，需要你手动维护' }
  if (row.repoOwned !== true) return { pkg, state: 'failed', message: '所在仓库是 ' + row.repoRoot + '（含多个技能）：请在仓库根更新，本插件不代你动整个仓库' }
  if (row.url === '') return { pkg, state: 'failed', message: '没有 origin 远端' }
  const before = row.localSha
  const args = ['pull', '--ff-only']
  if (row.upstream === '') args.push('origin', row.branch)
  const pull = await gitRun(args, row.repoRoot, PULL_TIMEOUT_MS)
  const after = gitSync(['rev-parse', 'HEAD'], row.repoRoot).stdout.trim()
  if (pull.ok === true) {
    if (after !== '' && before !== '' && after !== before) {
      return { pkg, state: 'updated', message: shortSha(before) + ' → ' + shortSha(after), from: before, to: after }
    }
    return { pkg, state: 'unchanged', message: '已是最新（' + shortSha(before) + '）', from: before, to: after === '' ? before : after }
  }
  return { pkg, state: 'failed', message: describeGitFailure(pull), from: before, to: after }
}

/**
 * 更新 git 形态的技能。只快进，不合并，不动工作区。
 * @param pkgs - 技能名列表（行里的 pkg）
 * @returns 每个技能一项 {pkg, state: updated|unchanged|failed, message, from, to}
 */
export async function updateSkillRepos(pkgs) {
  const wanted = []
  for (const raw of Array.isArray(pkgs) ? pkgs : []) {
    const name = skillBaseName(String(raw))
    if (name !== '' && !wanted.includes(name)) wanted.push(name)
  }
  // collectSkills 只用第一方服务的可见性来补「随 DSH 提供」的行；更新路径不需要它。
  const rows = collectSkills({ get: () => undefined })
  const results = []
  for (const pkg of wanted) {
    results.push(await updateOneSkill(rows.find((r) => r.pkg === pkg), pkg))
  }
  return results
}

/** DSH 的技能根目录（按优先级）。rank 越小优先级越高。 */
function skillRoots() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  // DSH_AGENTS_HOME 是同 DSH_APP_ASAR 性质的测试口：让回归测试能把
  // rank-500 根指向沙箱，否则测试会写进真实用户目录。
  const agentsHome = process.env.DSH_AGENTS_HOME ?? path.join(os.homedir(), '.agents')
  return [
    { rank: 400, root: path.join(home, 'skills') },
    { rank: 500, root: path.join(agentsHome, 'skills') },
  ]
}

/** 解析 SKILL.md 的 frontmatter（容忍块标量）。 */
export function parseSkillFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text))
  if (m === null) return { present: false, fields: {} }
  const fields = {}
  let key = null
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (kv !== null) {
      key = kv[1]
      fields[key] = kv[2]
      continue
    }
    if (key !== null && /^\s+\S/.test(line)) fields[key] = String(fields[key]).trim() + ' ' + line.trim()
  }
  for (const k of Object.keys(fields)) fields[k] = String(fields[k]).trim()
  return { present: true, fields }
}

/** 扫描技能根目录，返回全部候选（含被遮蔽的）。 */
export function scanSkillCandidates() {
  const out = []
  for (const { rank, root } of skillRoots()) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      try {
        let dir
        let file
        if (e.isDirectory()) {
          dir = path.join(root, e.name)
          file = path.join(dir, 'SKILL.md')
          if (!fs.existsSync(file)) continue
        } else if (e.isFile() && e.name.endsWith('.md')) {
          dir = root
          file = path.join(root, e.name)
        } else continue
        const text = fs.readFileSync(file, 'utf8')
        const fm = parseSkillFrontmatter(text)
        const name = typeof fm.fields.name === 'string' && fm.fields.name !== '' ? fm.fields.name : e.name.replace(/\.md$/, '')
        let nested = 0
        if (e.isDirectory()) {
          try {
            nested = countNestedSkillFiles(dir)
          } catch {
            nested = 0
          }
        }
        out.push({
          name,
          dirName: e.name.replace(/\.md$/, ''),
          kind: e.isDirectory() ? 'dir' : 'file',
          rank,
          root,
          path: file,
          dir,
          bytes: text.length,
          frontmatter: fm.present,
          description: typeof fm.fields.description === 'string' ? fm.fields.description : '',
          version: typeof fm.fields.version === 'string' && fm.fields.version !== ''
            ? fm.fields.version
            : (function () {
                // 版本也可能写在 metadata.version 下（实测 agent-reach 就是）
                const nested = /^\s+version:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(text.slice(0, text.indexOf('---', 3)))
                return nested === null ? null : nested[1].trim()
              })(),
          nestedSkillFiles: nested,
          isGit: fs.existsSync(path.join(dir, '.git')),
        })
      } catch {
        /* 单个技能失败只跳过它 */
      }
    }
  }
  return out
}

/** 统计目录下**嵌套**的 SKILL.md（这些不会被 DSH 发现）。 */
function countNestedSkillFiles(dir, depth = 0) {
  if (depth > 3) return 0
  let n = 0
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name === 'node_modules' || e.name === '.git') continue
    const sub = path.join(dir, e.name)
    if (fs.existsSync(path.join(sub, 'SKILL.md'))) n += 1
    n += countNestedSkillFiles(sub, depth + 1)
  }
  return n
}

/** 取 DSH 认定的可见技能名集合（第一方数据源）。 */
export function visibleSkillNames(ctx) {
  try {
    const svc = ctx.get('skills')
    if (svc === undefined) return undefined
    const raw = typeof svc.list === 'function' ? svc.list() : (typeof svc.snapshot === 'function' ? svc.snapshot() : undefined)
    const arr = raw instanceof Map ? Array.from(raw.values()) : (Array.isArray(raw) ? raw : (raw && raw.entries instanceof Map ? Array.from(raw.entries.values()) : (raw && Array.isArray(raw.entries) ? raw.entries : undefined)))
    if (arr === undefined) return undefined
    const names = arr.map((x) => (x && x.candidate ? x.candidate.name : (x && x.name))).filter((x) => typeof x === 'string')
    return new Set(names)
  } catch {
    return undefined
  }
}

/** 稳定标识：去掉本插件附加的「（中文名）」后的原名。 */
export function skillBaseName(name) {
  const m = /^(.+?)（[^（）]*）$/.exec(String(name ?? ''))
  return m === null ? String(name ?? '') : m[1]
}

/** 判定描述语言：中文 / 英文 / 混合 / 空。 */
export function descriptionLanguage(text) {
  const s = String(text ?? '')
  if (s.trim() === '') return '空'
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const latin = (s.match(/[A-Za-z]/g) || []).length
  if (cjk === 0) return '英文'
  if (latin === 0) return '中文'
  return cjk >= latin / 3 ? '中文为主' : '英文为主'
}

/** 技能文案覆盖层（与插件侧同构：内置 catalog ∪ 用户覆盖层）。 */
export function skillOverlayPath() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-audit-skills', 'skill-catalog.local.json')
}

const SKILL_CATALOG_FILE = path.join(PACKAGE_ROOT, 'references', 'dsh-skill-locale-catalog.json')

/** 内置技能文案 ∪ 覆盖层（覆盖层优先）。 */
export function readSkillCatalog() {
  const merged = new Map()
  for (const file of [SKILL_CATALOG_FILE, skillOverlayPath()]) {
    for (const entry of readEntries(file)) {
      if (entry && typeof entry.pkg === 'string') merged.set(entry.pkg, entry)
    }
  }
  return Array.from(merged.values())
}

/** YAML 安全输出：统一用双引号标量，避免出现会破坏严格解析的 ": "。 */
function yamlQuote(value) {
  return JSON.stringify(String(value ?? ''))
}

/**
 * 改写 SKILL.md 的 frontmatter：只动 name 与 description，**其余字段逐字保留**。
 *
 * 真实文件里 description 有单行、块标量（| / >）、以及"键后换行"三种形态，
 * 必须都能正确吃掉原文，否则会把 description 的残行留在文件里造成 YAML 损坏。
 */
export function rewriteSkillFrontmatter(text, opts) {
  const src = String(text ?? '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  if (m === null) return undefined
  const body = src.slice(m[0].length)
  const lines = m[1].split(/\r?\n/)
  const out = []
  let sawName = false
  let sawDesc = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^name:\s*/.test(line)) {
      out.push('name: ' + String(opts.name))
      sawName = true
      i += 1
      continue
    }
    if (/^description:\s*/.test(line)) {
      sawDesc = true
      i += 1
      // 吃掉原值：块标量（后续缩进行）或折叠的续行
      while (i < lines.length && /^\s+\S/.test(lines[i])) i += 1
      out.push('description: ' + yamlQuote(opts.description))
      continue
    }
    out.push(line)
    i += 1
  }
  if (!sawName) out.unshift('name: ' + String(opts.name))
  if (!sawDesc) out.push('description: ' + yamlQuote(opts.description))
  return '---\n' + out.join('\n') + '\n---' + body
}

/** 应用技能文案：改写 name 与 description，写前留一次备份。 */
export function applySkillLocale(_dirs, options = {}) {
  const entries = options.entries ?? readSkillCatalog()
  const results = []
  const cands = scanSkillCandidates()
  const byName = new Map()
  for (const c of cands) {
    const key = skillBaseName(c.name)
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key).push(c)
  }
  for (const entry of entries) {
    try {
      const list = byName.get(entry.pkg)
      if (list === undefined) {
        results.push({ pkg: entry.pkg, state: 'skipped-not-installed' })
        continue
      }
      list.sort((a, b) => a.rank - b.rank)
      const target = list[0]
      const text = fs.readFileSync(target.path, 'utf8')
      const next = rewriteSkillFrontmatter(text, {
        name: entry.zh && entry.zh.name ? entry.zh.name : entry.pkg,
        description: entry.zh && entry.zh.description ? entry.zh.description : '',
      })
      if (next === undefined) {
        results.push({ pkg: entry.pkg, state: 'failed', message: '缺少 frontmatter，已跳过（不会破坏文件）' })
        continue
      }
      if (next === text) {
        results.push({ pkg: entry.pkg, state: 'applied', note: 'unchanged' })
        continue
      }
      if (!hasAnyBackup(target.path)) backupOnce(target.path)
      fs.writeFileSync(target.path, next)
      results.push({ pkg: entry.pkg, state: 'applied', path: target.path })
    } catch (error) {
      results.push({ pkg: entry.pkg, state: 'failed', message: String((error && error.message) || error) })
    }
  }
  return results
}

/** 还原技能文案：有备份才还原（技能文件无法凭生成内容反推原文）。 */
export function revertSkillLocale(_dirs, options = {}) {
  const entries = options.entries ?? readSkillCatalog()
  const results = []
  for (const entry of entries) {
    try {
      const list = scanSkillCandidates().filter((c) => skillBaseName(c.name) === entry.pkg)
      if (list.length === 0) {
        results.push({ pkg: entry.pkg, state: 'skipped-not-installed' })
        continue
      }
      list.sort((a, b) => a.rank - b.rank)
      const path0 = list[0].path
      let restored = 0
      for (const suffix of BACKUP_SUFFIXES) {
        const b = path0 + suffix
        if (fs.existsSync(b)) {
          fs.copyFileSync(b, path0)
          fs.unlinkSync(b)
          restored += 1
        }
      }
      results.push({ pkg: entry.pkg, state: restored > 0 ? 'restored' : 'no-backup', restored })
    } catch (error) {
      results.push({ pkg: entry.pkg, state: 'failed', message: String((error && error.message) || error) })
    }
  }
  return results
}

/** 让模型为技能生成中文名与中文说明（格式：主要触发词 → 精炼说明）。 */
export async function generateSkillRefinement(ctx, name, originalDescription) {
  if (!ctx.llm || typeof ctx.llm.stream !== 'function') {
    return { ok: false, code: 'llm-unavailable', message: 'LLM 服务不可用' }
  }
  const selection = await resolveGenerationModel(ctx)
  if (selection === undefined) return { ok: false, code: 'no-model', message: '找不到可用的默认模型' }
  try {
    const prompt = [
      '你在为 DSH 的技能库做中文化精炼。下面是某个技能的英文/中英混合说明。',
      '',
      '技能标识：' + name,
      '原始说明：',
      '"""',
      String(originalDescription || '').slice(0, 2000),
      '"""',
      '',
      '要求：',
      '1. 只输出严格 JSON，不要 markdown 代码块，不要多余文字。',
      '2. 结构：{"zhName":"...","description":"..."}',
      '3. zhName：必须是「' + name + '（中文名）」的形态，中文名 2~8 个字，概括这个技能做什么。',
      '4. description：只写一行，格式为「主要触发词 → 精炼说明」。',
      '   · 触发词必须**保留原文里的触发关键词**（含英文词），用、分隔，让人一眼知道什么时候会用到它',
      '   · 精炼说明用中文，说清「做什么 + 边界（不做什么）」，40~90 字',
      '5. 不要使用半角冒号加空格（: ），避免破坏 YAML；需要时用全角：',
      '6. 只依据原文，不要编造原文未提及的能力。',
      '',
      '只输出 JSON。',
    ].join('\n')
    let raw = ctx.llm.stream({ provider: selection.provider, model: selection.model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] })
    if (raw && typeof raw.then === 'function') raw = await raw
    const stream = raw && raw.stream !== undefined ? raw.stream : raw
    const text = await collectStreamText(stream)
    const parsed = parseGeneratedSkill(typeof text === 'string' ? text : '')
    if (parsed === undefined) return { ok: false, code: 'bad-output', message: '模型返回无法解析为约定 JSON', raw: String(text).slice(0, 400) }
    // 强制命名约定：与原包名一致的做法——原名开头，中文名以（）附加
    parsed.zhName = enforceSkillName(name, parsed.zhName)
    parsed.description = String(parsed.description).replace(/:\s/g, '：')
    return { ok: true, entry: { pkg: name, zh: { name: parsed.zhName, description: parsed.description } }, selection }
  } catch (error) {
    return { ok: false, code: 'generate-failed', message: String((error && error.message) || error) }
  }
}

/** 强制「原名（中文名）」形态，不依赖模型自觉。 */
export function enforceSkillName(name, candidate) {
  const t = String(candidate ?? '').trim()
  if (t === '' || t === name) return name
  if (t.startsWith(name)) return t
  const inner = t.replace(/^[^（(]*[（(]?/, '').replace(/[）)]\s*$/, '').trim()
  return inner === '' || inner === t ? name + '（' + t + '）' : name + '（' + inner + '）'
}

/** 解析技能生成结果。 */
export function parseGeneratedSkill(text) {
  if (typeof text !== 'string') return undefined
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '')
  const a = cleaned.indexOf('{')
  const b = cleaned.lastIndexOf('}')
  if (a < 0 || b <= a) return undefined
  try {
    const doc = JSON.parse(cleaned.slice(a, b + 1))
    if (!doc || typeof doc.zhName !== 'string' || typeof doc.description !== 'string') return undefined
    if (doc.zhName.trim() === '' || doc.description.trim() === '') return undefined
    return { zhName: doc.zhName.trim(), description: doc.description.trim() }
  } catch {
    return undefined
  }
}

/** 收集技能行（与插件行同构）。 */
export function collectSkills(ctx) {
  const cands = scanSkillCandidates()
  const visible = visibleSkillNames(ctx)
  const byName = new Map()
  for (const c of cands) {
    // 按**稳定标识**分组：应用后 frontmatter 的 name 会变成「原名（中文名）」，
    // 若仍按原样分组，二次应用与还原都会找不到目标。
    const key = skillBaseName(c.name)
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key).push(c)
  }
  const catalog = new Map(readSkillCatalog().map((e) => [e.pkg, e]))
  const rows = []
  for (const [name, list] of byName) {
    const entry = catalog.get(name)
    list.sort((a, b) => a.rank - b.rank)
    const top = list[0]
    const shadowed = list.slice(1)
    // DSH 可见性：以第一方服务为准；服务不可用时按优先级推断
    const isVisible = visible === undefined ? true : visible.has(name)
    rows.push({
      pkg: name,
      kind: 'skill',
      installed: true,
      enabled: isVisible,
      version: top.version,
      // 优化状态 = 该技能的 name 已被本插件改写为「原名（中文名）」
      localized: entry !== undefined && top.name === (entry.zh && entry.zh.name ? entry.zh.name : ''),
      needsText: entry === undefined,
      displayName: top.name,
      source: 'rank ' + top.rank + ' · ' + top.root,
      skillPath: top.path,
      bytes: top.bytes,
      descriptionLang: descriptionLanguage(top.description),
      frontmatter: top.frontmatter,
      dirMismatch: top.name !== top.dirName,
      nestedSkillFiles: top.nestedSkillFiles,
      // git 事实：技能不是 npm 包，「更新」只对 git 形态有意义
      ...(() => {
        const repo = top.isGit === true ? skillRepoInfo(path.dirname(top.path)) : { isGit: false }
        return {
          isGit: repo.isGit === true,
          repoRoot: repo.isGit === true ? repo.repoRoot : null,
          repoOwned: repo.isGit === true ? repo.owned === true : false,
          repoUrl: repo.isGit === true ? repo.url : '',
          branch: repo.isGit === true ? repo.branch : '',
          upstream: repo.isGit === true ? repo.upstream : '',
          localSha: repo.isGit === true ? repo.head : '',
          dirty: repo.isGit === true ? repo.dirty : 0,
          // 远端比对由 enrichSkillUpdates 补齐（要联网）；这里先如实置空
          remoteSha: null,
          hasUpdate: null,
        }
      })(),
      shadowed: shadowed.map((s) => 'rank ' + s.rank + ' · ' + s.path),
    })
  }
  // 补齐「随 DSH 提供」的技能：它们不在用户的技能根目录里，
  // 但 DSH 认定可见。若不补，本页会比真实技能数少（实测少 3 个）。
  if (visible !== undefined) {
    for (const name of visible) {
      if (byName.has(name)) continue
      rows.push({
        pkg: name,
        kind: 'skill',
        installed: true,
        enabled: true,
        version: null,
        localized: false,
        needsText: false,
        displayName: name,
        source: '随 DSH 提供',
        skillPath: null,
        bytes: 0,
        descriptionLang: '未知（随 DSH 提供）',
        frontmatter: true,
        dirMismatch: false,
        nestedSkillFiles: 0,
        isGit: false,
        shadowed: [],
        bundled: true,
      })
    }
  }
  rows.sort((a, b) => a.pkg.localeCompare(b.pkg))
  return rows
}

/**
 * 技能审查规则。
 * 与插件审查同约定：只报告、有证据、标 confidence、不评分。
 */
export function auditSkills(rows) {
  const findings = []
  const add = (f) => findings.push(Object.assign({ id: f.kind + ':' + f.key }, f))
  for (const r of rows) {
    if (r.frontmatter !== true) {
      add({ kind: 'conflict', key: 'fm-' + r.pkg, pkg: r.pkg, peers: [], severity: 'high', confidence: 'fact',
        title: 'SKILL.md 缺少 frontmatter',
        evidence: r.skillPath + ' 未以 --- 包裹的 frontmatter 开头',
        remedy: 'DSH 依赖 frontmatter 的 name/description 来选择技能；缺失会导致该技能不可被正确识别。' })
    }
    if (r.dirMismatch === true) {
      add({ kind: 'conflict', key: 'name-' + r.pkg, pkg: r.pkg, peers: [], severity: 'medium', confidence: 'fact',
        title: 'frontmatter 的 name 与目录名不一致',
        evidence: 'name=' + r.pkg + ' 但目录/文件名不同',
        remedy: '两者不一致时，引用该技能容易出现歧义。建议改为一致。' })
    }
    // 注意：这里必须判「描述真的为空」，不能用 needsText ——
    // skills 的 needsText 语义是「没有文案条目」，与描述是否为空是两回事。
    if (r.descriptionLang === '空') {
      add({ kind: 'conflict', key: 'nodesc-' + r.pkg, pkg: r.pkg, peers: [], severity: 'high', confidence: 'fact',
        title: 'description 为空',
        evidence: r.skillPath,
        remedy: '模型靠 description 决定是否启用该技能；为空等于它几乎不会被选中。' })
    } else if (r.bytes > 0 && r.descriptionLang === '英文') {
      add({ kind: 'interaction', key: 'lang-' + r.pkg, pkg: r.pkg, peers: [], severity: 'low', confidence: 'fact',
        title: '描述为英文（中文用户的可读性较低）',
        evidence: 'description 语言判定：英文',
        remedy: '仅影响你阅读时的直观度。注意：description 是**模型选择技能的依据**，改它属于行为变更——「翻译优化」会真实写入 SKILL.md（写前留 .dsh-skill.backup 备份，「还原翻译」可逐字节恢复），请自行确认生成内容。' })
    }
    if (r.nestedSkillFiles > 0) {
      add({ kind: 'interaction', key: 'nested-' + r.pkg, pkg: r.pkg, peers: [], severity: 'low', confidence: 'fact',
        title: '目录下有 ' + r.nestedSkillFiles + ' 个嵌套 SKILL.md 不会被发现',
        evidence: r.skillPath + ' 所在目录的更深层存在 SKILL.md',
        remedy: 'DSH 只发现顶层 <name>/SKILL.md 或 <name>.md。这些嵌套技能实际不生效（若非有意，可上移或删除）。' })
    }
    if (Array.isArray(r.shadowed) && r.shadowed.length > 0) {
      add({ kind: 'conflict', key: 'shadow-' + r.pkg, pkg: r.pkg, peers: [], severity: 'high', confidence: 'fact',
        title: '存在 ' + r.shadowed.length + ' 份被遮蔽的同名技能',
        evidence: r.shadowed.join('；') + ' —— 优先级低于当前生效的那份',
        remedy: '被遮蔽的那份不会生效（DSH 会记录 "ignored because a higher-priority skill already exists"）。建议删除或改名，避免你以为在用的是另一份。' })
    }
  }
  return findings
}

/** 读某包当前已装版本。 */
export function installedVersion(profileDir, pkg) {
  if (!isSafePackageName(pkg)) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(profileDir, 'node_modules', ...pkg.split('/'), 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * 批量更新状态**落盘**。
 *
 * 为什么必须落盘：更新一个插件会触发 DSH 重新组合插件图，从而 dispose/re-apply 本插件。
 * 之前批量更新是由**客户端状态驱动的循环**——客户端一重挂载，循环就当场死掉，
 * 所以「一键更新 3 个」实际只跑完第一个（实机证据：3 次期望只产生 1 次安装操作）。
 * 放到宿主侧还不够（宿主模块也可能被重新求值），所以状态写文件。
 */
function batchFile() {
  return path.join(path.dirname(overlayPath()), 'update-batch.json')
}

function readBatch() {
  try {
    return JSON.parse(fs.readFileSync(batchFile(), 'utf8'))
  } catch {
    return null
  }
}

function writeBatch(value) {
  try {
    fs.mkdirSync(path.dirname(batchFile()), { recursive: true })
    fs.writeFileSync(batchFile(), JSON.stringify(value, null, 2) + '\n')
  } catch {
    /* 状态落盘失败不影响更新本身 */
  }
}

const BATCH_STALE_MS = 10 * 60 * 1000

/** 当前批量更新状态；过期的 running 视为已结束（避免卡死后续批量）。 */
export function updateAllStatus() {
  const batch = readBatch()
  if (batch && batch.running === true && typeof batch.startedAt === 'number' && Date.now() - batch.startedAt > BATCH_STALE_MS) {
    batch.running = false
    batch.message = '上次批量更新已中断（超过 10 分钟无进展）'
    writeBatch(batch)
  }
  return batch
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 单个包最多等多久（毫秒）。超时不代表失败，只代表我们不再等。 */
const UPDATE_WAIT_MS = 120000

/**
 * 安装并**有界**等待完成。
 *
 * 为什么不 await installBundle：安装会触发 DSH 重新组合插件图，而那个 Promise
 * 可能在重组合过程中**永不 settle** —— 实机表现就是「批量更新一直卡在 1/3」。
 * 因此改为：把安装发出去，然后轮询已装版本的变化，到点就如实汇报，
 * 绝不把整个批量的推进权交给一个可能不返回的 Promise。
 */
export async function installAndWait(ctx, profileDir, pkg, waitMs = UPDATE_WAIT_MS) {
  const plan = resolveUpdateSpec(profileDir, pkg)
  if (plan.spec === null) return { ok: false, message: plan.reason }
  const pm = getPluginManager(ctx)
  if (pm === undefined) return { ok: false, message: '插件管理器服务未就绪' }
  if (typeof pm.installBundle !== 'function') return { ok: false, message: '插件管理器未提供 installBundle' }
  const from = installedVersion(profileDir, pkg)
  let failure = null
  let settled = false
  Promise.resolve()
    .then(() => pm.installBundle(plan.spec, {}))
    .then(() => { settled = true })
    .catch((error) => { failure = String((error && error.message) || error); settled = true })
  const deadline = Date.now() + waitMs
  for (;;) {
    if (failure !== null) return { ok: false, message: failure, from }
    // Promise 已 settle 就立刻判断，不先白等一个轮询周期
    if (settled === true) {
      const now = installedVersion(profileDir, pkg)
      if (now !== null && now !== from) return { ok: true, message: '', from, to: now }
      // 让出一小段时间，避免 pnpm 写盘与我们的读取竞争
      await sleep(300)
      const again = installedVersion(profileDir, pkg)
      return { ok: true, message: '', from, to: again, unchanged: again === from }
    }
    if (Date.now() >= deadline) break
    await sleep(250)
  }
  return { ok: false, message: '等待超时（安装可能仍在后台执行，可稍后刷新查看）', from, timedOut: true }
}

/**
 * 启动批量更新：**在宿主侧串行执行**，进度落盘，客户端只负责轮询显示。
 * 已在进行中时幂等返回当前状态，不重复启动。
 */
export function startUpdateAll(ctx, profileDir, pkgs) {
  const current = updateAllStatus()
  if (current && current.running === true) return { ok: true, alreadyRunning: true, batch: current }
  const items = (Array.isArray(pkgs) ? pkgs : []).filter(isSafePackageName).map((pkg) => ({
    pkg,
    state: 'pending',
    message: '',
    from: installedVersion(profileDir, pkg),
    to: null,
  }))
  if (items.length === 0) return { ok: false, code: 'no-target', message: '没有可更新的插件' }
  const batch = { running: true, index: 0, total: items.length, items, message: '准备中…', startedAt: Date.now(), finishedAt: null }
  writeBatch(batch)
  ;(async () => {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      const live = readBatch() ?? batch
      live.index = i
      live.message = '正在更新 ' + (i + 1) + '/' + items.length + '：' + item.pkg
      item.state = 'running'
      live.items = items
      writeBatch(live)
      const result = await installAndWait(ctx, profileDir, item.pkg)
      item.to = installedVersion(profileDir, item.pkg)
      if (result.ok === true) {
        // 与单包路径共用收尾：补回被 pnpm 洗掉的优化结果 + 变化提示
        const finished = await finishAfterUpdate(profileDir, item.pkg, item.from, item.to)
        item.refined = finished.refined
        item.delta = finished.delta
      }
      if (result.ok !== true) {
        item.state = 'failed'
        item.message = result.message
      } else if (item.to !== null && item.from !== null && item.to !== item.from) {
        item.state = 'updated'
        item.message = item.from + ' → ' + item.to
      } else {
        // 安装确实执行了，但版本没变 —— 必须如实说明，不能假装成功
        item.state = 'unchanged'
        item.message = '安装已执行，但版本未变（仍为 ' + String(item.to) + '）'
      }
      const after = readBatch() ?? batch
      after.items = items
      writeBatch(after)
    }
    const done = readBatch() ?? batch
    done.running = false
    done.index = items.length
    done.finishedAt = Date.now()
    const updated = items.filter((x) => x.state === 'updated').length
    const unchanged = items.filter((x) => x.state === 'unchanged').length
    const failed = items.filter((x) => x.state === 'failed').length
    done.message = '完成：成功 ' + updated + ' 个，未变化 ' + unchanged + ' 个，失败 ' + failed + ' 个'
    writeBatch(done)
  })().catch(() => {
    const fallback = readBatch() ?? batch
    fallback.running = false
    fallback.finishedAt = Date.now()
    fallback.message = '批量更新异常中止'
    writeBatch(fallback)
  })
  return { ok: true, batch }
}

/** 查询单包更新进度。 */
export function updateJobStatus(token) {
  const job = typeof token === 'string' ? updateJobs.get(token) : undefined
  if (job === undefined) return { ok: false, code: 'unknown-token', message: '任务不存在或已过期' }
  return { ok: true, job }
}

/**
 * 包名白名单。
 *
 * /generate 与 /update 的 pkg 来自 HTTP 请求体；此前只校验了 typeof === 'string'，
 * 于是 pkg='../../evil' 会被 path.join 展开并逃出 node_modules（实测可读到树外
 * package.json 的 description，并把它喂进 LLM 提示词）。
 * 只允许 npm 合法包名形态，并显式拒绝 '..'。
 */
export function isSafePackageName(pkg) {
  if (typeof pkg !== 'string' || pkg.length === 0 || pkg.length > 214) return false
  if (pkg.includes('..')) return false
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(pkg)
}

/** 版本号数字段解析；非标准版本返回 undefined。 */
function parseVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''))
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * latest 是否**真的比** current 新。
 *
 * 此前用 latest !== current，于是「已装 2.0.0 / npm 最新 1.5.0」也会被判为有更新，
 * 点下去等于降级。非标准版本号（如 prerelease 标签）退回不等比较。
 */
export function isNewerVersion(latest, current) {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (a === undefined || b === undefined) return latest !== current
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** 生成提示词：只依据原文，禁止编造；title 必须保留原包名。 */
function buildPrompt(pkg, original) {
  return [
    '你是 DSH 插件文案精炼器。为下面的 DSH 插件写精炼说明。',
    '',
    '插件包名：' + pkg,
    '插件原始说明：',
    '"""',
    String(original || '').slice(0, 2000),
    '"""',
    '',
    '要求：',
    '1. 只输出严格 JSON，不要 markdown 代码块，不要任何多余文字。',
    '2. 结构：{"en":{"title":"...","description":"..."},"zh":{"title":"...","description":"..."}}',
    '3. title 规则（不可违反）：zh.title 必须以原包名开头，中文名用全角括号附加在包名之后，例如 dsh-free-search（免费搜索）；en.title 就是原包名本身。',
    '4. description：一到两句。先说「做什么」，再说「边界」——不做什么、依赖什么、会不会改数据。中文 40~110 字，英文 1~2 句。不要营销词，不要罗列全部细节。',
    '5. 只依据给出的原文，绝不编造原文未提及的能力。',
    '',
    '只输出 JSON。',
  ].join('\n')
}

/**
 * 强制命名约定：zh.title 必须以原包名开头。
 *
 * 提示词里"要求"了，但模型可能不遵守（实测返回过与原包完全无关的标题）。
 * 一旦不遵守，用户就无法从标题认出原插件——这是用户立下的不可违反约定，
 * 所以不靠模型自觉，写入前直接补前缀。
 */
export function enforceTitle(pkg, title) {
  const t = String(title ?? '').trim()
  if (t === '') return pkg
  if (t.startsWith(pkg)) return t
  const inner = t.replace(/^[^（(]*[（(]?/, '').replace(/[）)]\s*$/, '').trim()
  return inner === '' || inner === t ? pkg + '（' + t + '）' : pkg + '（' + inner + '）'
}

/** 解析模型返回的 JSON：容忍代码块包裹与前后杂讯。 */
export function parseGenerated(text) {
  if (typeof text !== 'string') return undefined
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '')
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first < 0 || last <= first) return undefined
  try {
    const doc = JSON.parse(cleaned.slice(first, last + 1))
    if (!doc || typeof doc !== 'object') return undefined
    const ok = (side) => side && typeof side.title === 'string' && typeof side.description === 'string'
    if (!ok(doc.en) || !ok(doc.zh)) return undefined
    return {
      en: { title: doc.en.title.trim(), description: doc.en.description.trim() },
      zh: { title: doc.zh.title.trim(), description: doc.zh.description.trim() },
    }
    // 命名约定由 enforceTitle 在写入前强制，不依赖模型自觉
  } catch {
    return undefined
  }
}

/** 解析生成用的 provider/model：优先 settings 里的默认模型，其次 llm 提供商枚举。 */
export async function resolveGenerationModel(ctx) {
  try {
    const settings = ctx.get('settings')
    if (settings) {
      for (const ns of ['agent-default-model', 'agentDefaultModel']) {
        let value
        try {
          value = typeof settings.read === 'function' ? await settings.read(ns) : undefined
        } catch {
          value = undefined
        }
        if (value === undefined && typeof settings.get === 'function') value = settings.get(ns)
        const provider = value && value.provider
        const model = value && value.model
        if (typeof provider === 'string' && typeof model === 'string') {
          return { provider, model, source: 'settings:' + ns }
        }
      }
    }
  } catch {
    /* 继续回落 */
  }
  try {
    const providers = await ctx.llm.listProviders()
    for (const provider of Array.isArray(providers) ? providers : []) {
      const id = typeof provider === 'string' ? provider : provider && provider.id
      if (typeof id !== 'string') continue
      const models = await ctx.llm.listModels(id)
      for (const model of Array.isArray(models) ? models : []) {
        const modelId = typeof model === 'string' ? model : model && (model.id ?? model.model)
        if (typeof modelId === 'string' && modelId !== '') return { provider: id, model: modelId, source: 'llm:' + id }
      }
    }
  } catch {
    /* 无可用模型 */
  }
  return undefined
}

/** 把流里的可见文本收集出来（同时兼容同步/异步可迭代与多种记录形状）。 */
export function collectStreamText(records) {
  let text = ''
  const take = (record) => {
    if (!record || typeof record !== 'object') return
    if (record.type === 'text-chunks' && Array.isArray(record.texts)) {
      text += record.texts.join('')
      return
    }
    if (record.type === 'text-delta' && typeof record.text === 'string') {
      text += record.text
      return
    }
    const chunk = record.chunk
    if (chunk && typeof chunk === 'object' && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
    }
  }
  if (records && typeof records[Symbol.asyncIterator] === 'function') {
    return (async () => {
      for await (const record of records) take(record)
      return text
    })()
  }
  if (records && typeof records[Symbol.iterator] === 'function') {
    for (const record of records) take(record)
  }
  return text
}

/** 让模型生成一条精炼文案；任何不确定都转成可读的失败原因。 */
export async function generateRefinement(ctx, pkg, original) {
  if (!ctx.llm || typeof ctx.llm.stream !== 'function') {
    return { ok: false, code: 'llm-unavailable', message: 'LLM 服务不可用（未注入或未注册 llm 服务）' }
  }
  const selection = await resolveGenerationModel(ctx)
  if (selection === undefined) {
    return { ok: false, code: 'no-model', message: '找不到可用的默认模型；请先在设置中选定默认模型' }
  }
  try {
    const prompt = buildPrompt(pkg, original)
    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    let raw = ctx.llm.stream({ provider: selection.provider, model: selection.model, messages })
    if (raw && typeof raw.then === 'function') raw = await raw
    const stream = raw && raw.stream !== undefined ? raw.stream : raw
    const text = await collectStreamText(stream)
    const parsed = parseGenerated(typeof text === 'string' ? text : '')
    if (parsed === undefined) {
      return { ok: false, code: 'bad-output', message: '模型返回无法解析为约定 JSON', raw: String(text).slice(0, 400) }
    }
    // 强制命名约定（不依赖模型自觉）
    parsed.zh.title = enforceTitle(pkg, parsed.zh.title)
    return { ok: true, entry: parsed, selection }
  } catch (error) {
    return { ok: false, code: 'generate-failed', message: String((error && error.message) || error) }
  }
}

/** 把一条生成结果写入覆盖层（覆盖层优先，等于永久生效）。 */
export function upsertOverlay(pkg, entry) {
  try {
    const file = overlayPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let doc = { schema_version: 1, note: '本文件由用户或 Agent 维护，优先级高于包内内置 catalog。', entries: [] }
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw && Array.isArray(raw.entries)) doc = raw
    } catch {
      /* 首次创建 */
    }
    const next = doc.entries.filter((e) => !(e && e.pkg === pkg))
    next.push({ pkg, en: entry.en, zh: entry.zh })
    doc.entries = next
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
    return { ok: true, path: file, total: next.length }
  } catch (error) {
    return { ok: false, code: 'overlay-write-failed', message: String((error && error.message) || error) }
  }
}

/** 把一条技能生成结果写入技能覆盖层。 */
export function upsertSkillOverlay(pkg, entry) {
  try {
    const file = skillOverlayPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let doc = { schema_version: 1, note: '技能中文名与中文说明。', entries: [] }
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw && Array.isArray(raw.entries)) doc = raw
    } catch { /* 首次创建 */ }
    // 宽容入参：既接受 {zh:{name,description}}（与插件侧 upsertOverlay 对齐），
    // 也接受直接给 {name,description}
    const zh = entry && entry.zh !== undefined ? entry.zh : entry
    doc.entries = doc.entries.filter((e) => !(e && e.pkg === pkg)).concat([{ pkg: pkg, zh: zh }])
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
    return { ok: true, path: file, total: doc.entries.length }
  } catch (error) {
    return { ok: false, message: String((error && error.message) || error) }
  }
}

/**
 * 为一行数据生成「问题 → 原因 → 解决办法 → 可执行动作」。
 * 界面不应只丢一个 HTTP 404 给用户。
 */
export function describeIssues(row) {
  const issues = []
  const latest = row.latest === undefined ? null : row.latest
  if (row.needsText === true) {
    issues.push({
      code: 'needs-text',
      reason: '该插件没有内置精炼文案，需要生成一条中文说明。',
      remedy: '点「翻译优化」会自动让模型写一条并存入覆盖层，无需单独操作；也可把包名发给 Agent 手动补录。',
      action: { kind: 'hint', label: '由「翻译优化」自动处理' },
    })
  }
  if (row.version && latest === null && typeof row.reason === 'string' && row.reason !== '') {
    if (row.reason.includes('404')) {
      issues.push({
        code: 'not-on-npm',
        reason: 'npm registry 上找不到这个包（它可能是从 GitHub 直接安装的），所以无法比对版本。',
        remedy: 'GitHub 直装的包要用 git spec 更新；若要简化以后升级，可改从 npm 安装。',
        action: { kind: 'hint', label: 'GitHub 直装，跳过 npm 比对' },
      })
    } else {
      issues.push({
        code: 'registry-unavailable',
        reason: '查询 npm 版本失败：' + row.reason,
        remedy: '检查网络或代理后点「检查更新」重试。',
        action: { kind: 'retry', label: '重试检查' },
      })
    }
  }
  if (row.error) {
    issues.push({
      code: 'bundle-error',
      reason: '插件管理器报告该 bundle 状态异常：' + row.error,
      remedy: '在插件页停用再启用该插件；若仍异常，重启 DSH。',
      action: { kind: 'hint', label: '前往插件页处理' },
    })
  }
  return issues
}

/** 客户端 ↔ 宿主 bridge：注册只读/幂等的动作。任何失败都不外抛。 */
export function registerBridge(ctx, dirs) {
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      /** 读取 JSON 请求体；失败返回 undefined，绝不抛错。 */
      const readJsonBody = (req) =>
        new Promise((resolve) => {
          try {
            let data = ''
            req.on('data', (chunk) => {
              data += chunk
              if (data.length > 65536) data = data.slice(0, 65536)
            })
            req.on('end', () => {
              try {
                resolve(data === '' ? {} : JSON.parse(data))
              } catch {
                resolve(undefined)
              }
            })
            req.on('error', () => resolve(undefined))
          } catch {
            resolve(undefined)
          }
        })
      const writeJson = (res, status, body) => {
        try {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          // 每个响应都带上本插件版本，供客户端检测宿主半体是否过旧
          res.end(JSON.stringify(Object.assign({ rev: OWN_REV }, body)))
        } catch {
          /* 响应已结束等情况忽略 */
        }
      }
      const routes = [
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/apply',
          handler: async (req, res) => {
            try {
              // 传 pkgs 时只处理这些包 —— 让「翻译优化」能跳过已优化的插件
              const body = await readJsonBody(req)
              const pkgs = body !== undefined && Array.isArray(body.pkgs) ? body.pkgs.filter(isSafePackageName) : null
              const options = pkgs === null ? {} : { entries: readCatalog().filter((e) => pkgs.includes(e.pkg)) }
              writeJson(res, 200, { ok: true, value: applyLocale(dirs, options) })
            } catch (error) {
              writeJson(res, 200, { ok: false, message: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/updates',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req)
              const force = body && body.force === true
              const ownerDirs = Array.isArray(dirs) ? dirs : [dirs]
              const rows = collectStatusViaService(ctx, dirs) ?? collectStatus(dirs)
              // 审查结果与状态走**同一次响应**（单一快照原则），不新增按钮
              let audit = { generatedAt: null, counts: { high: 0, medium: 0, low: 0, fact: 0, inferred: 0 }, noCompat: [] }
              const byPkg = new Map()
              try {
                const raw = auditPackages(ctx, ownerDirs[0])
                const ignored = new Set(readIgnored())
                const visible = raw.findings.filter((f) => !ignored.has(f.id))
                for (const f of visible) {
                  for (const owner of [f.pkg].concat(Array.isArray(f.peers) ? f.peers : [])) {
                    if (!byPkg.has(owner)) byPkg.set(owner, [])
                    if (!byPkg.get(owner).includes(f)) byPkg.get(owner).push(f)
                  }
                }
                audit = {
                  generatedAt: raw.generatedAt,
                  counts: {
                    high: visible.filter((f) => f.severity === 'high').length,
                    medium: visible.filter((f) => f.severity === 'medium').length,
                    low: visible.filter((f) => f.severity === 'low').length,
                    fact: visible.filter((f) => f.confidence === 'fact').length,
                    inferred: visible.filter((f) => f.confidence === 'inferred').length,
                  },
                  noCompat: raw.noCompat,
                }
              } catch {
                /* 审查失败绝不影响状态刷新 */
              }
              const out = []
              for (const row of rows) {
                if (row.version === null || row.version === undefined) {
                  out.push(Object.assign({}, row, { latest: null, hasUpdate: null, reason: 'no-version' }))
                  continue
                }
                const r = await latestVersionCached(row.pkg, force)
                if (r.latest === null) {
                  out.push(Object.assign({}, row, { latest: null, hasUpdate: null, reason: r.reason ?? 'unavailable' }))
                  continue
                }
                // 必须用版本序比较：用 !== 会把「已装版本更高」的降级也判成有更新
                out.push(Object.assign({}, row, { latest: r.latest, hasUpdate: isNewerVersion(r.latest, row.version) ? true : (isNewerVersion(row.version, r.latest) ? false : null), reason: null }))
              }
              writeJson(res, 200, {
                ok: true,
                audit: audit,
                value: out.map((row) => Object.assign({}, row, { issues: describeIssues(row), findings: byPkg.get(row.pkg) ?? [] })),
              })
            } catch (error) {
              writeJson(res, 200, { ok: false, message: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/update',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req)
              const pkg = body && typeof body.pkg === 'string' ? body.pkg : ''
              if (pkg === '') {
                writeJson(res, 200, { ok: false, code: 'missing-pkg', message: '缺少 pkg 参数' })
                return
              }
              if (!isSafePackageName(pkg)) {
                writeJson(res, 200, { ok: false, code: 'invalid-pkg', message: '包名非法，已拒绝（防路径穿越）' })
                return
              }
              writeJson(res, 200, startUpdate(ctx, Array.isArray(dirs) ? dirs[0] : dirs, pkg))
            } catch (error) {
              writeJson(res, 200, { ok: false, code: 'update-failed', message: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/skills',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req)
              // force（「刷新状态」）绕过远端比对缓存；只有 git 形态的技能需要联网
              const rows = await enrichSkillUpdates(collectSkills(ctx), body !== undefined && body.force === true)
              const ignored = new Set(readIgnored())
              const visible = auditSkills(rows).filter((f) => !ignored.has(f.id))
              const byPkg = new Map()
              for (const f of visible) {
                for (const owner of [f.pkg].concat(Array.isArray(f.peers) ? f.peers : [])) {
                  if (!byPkg.has(owner)) byPkg.set(owner, [])
                  if (!byPkg.get(owner).includes(f)) byPkg.get(owner).push(f)
                }
              }
              writeJson(res, 200, {
                ok: true,
                audit: {
                  generatedAt: Date.now(),
                  counts: {
                    high: visible.filter((f) => f.severity === 'high').length,
                    medium: visible.filter((f) => f.severity === 'medium').length,
                    low: visible.filter((f) => f.severity === 'low').length,
                    fact: visible.filter((f) => f.confidence === 'fact').length,
                    inferred: visible.filter((f) => f.confidence === 'inferred').length,
                  },
                  noCompat: [],
                },
                value: rows.map((r) => Object.assign({}, r, { issues: [], findings: byPkg.get(r.pkg) ?? [] })),
              })
            } catch (error) {
              writeJson(res, 200, { ok: false, message: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/update-skills',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req)
              const pkgs = body !== undefined && Array.isArray(body.pkgs) ? body.pkgs.filter(isSafePackageName) : null
              if (pkgs === null || pkgs.length === 0) {
                writeJson(res, 200, { ok: false, code: 'bad-request', message: '需要非空的 pkgs 列表（技能名）' })
                return
              }
              // 只做 git 快进（pull --ff-only）：等真实结果再回，客户端据此把按钮按结果暗下去
              writeJson(res, 200, { ok: true, value: await updateSkillRepos(pkgs) })
            } catch (error) {
              writeJson(res, 200, { ok: false, message: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/apply-skills',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req)
              const pkgs = body !== undefined && Array.isArray(body.pkgs) ? body.pkgs.filter(isSafePackageName) : null
              const options = pkgs === null ? {} : { entries: readSkillCatalog().filter((e) => pkgs.includes(e.pkg)) }
              writeJson(res, 200, { ok: true, value: applySkillLocale(dirs, options) })
            } catch (error) {
              writeJson(res, 200, { ok: false, message: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/revert-skills',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req)
              const pkgs = body !== undefined && Array.isArray(body.pkgs) ? body.pkgs.filter(isSafePackageName) : null
              const options = pkgs === null ? {} : { entries: readSkillCatalog().filter((e) => pkgs.includes(e.pkg)) }
              writeJson(res, 200, { ok: true, value: revertSkillLocale(dirs, options) })
            } catch (error) {
              writeJson(res, 200, { ok: false, message: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/generate-skill',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req)
              const pkg = body && typeof body.pkg === 'string' ? body.pkg : ''
              if (pkg === '' || !isSafePackageName(pkg)) {
                writeJson(res, 200, { ok: false, code: 'invalid-pkg', message: '技能标识非法' })
                return
              }
              const cand = scanSkillCandidates().filter((c) => skillBaseName(c.name) === pkg).sort((a, b) => a.rank - b.rank)[0]
              if (cand === undefined) {
                writeJson(res, 200, { ok: false, code: 'not-found', message: '未找到该技能' })
                return
              }
              const generated = await generateSkillRefinement(ctx, pkg, cand.description)
              if (generated.ok !== true) { writeJson(res, 200, generated); return }
              const saved = upsertSkillOverlay(pkg, generated.entry)
              writeJson(res, 200, Object.assign({ ok: saved.ok === true, pkg: pkg, entry: generated.entry, selection: generated.selection }, saved))
            } catch (error) {
              writeJson(res, 200, { ok: false, code: 'generate-failed', message: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/ignore',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req)
              const result = ignoreFinding(body && body.id)
              clearAuditCache()
              writeJson(res, 200, result)
            } catch (error) {
              writeJson(res, 200, { ok: false, message: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/generate',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req)
              const pkg = body && typeof body.pkg === 'string' ? body.pkg : ''
              if (pkg === '') {
                writeJson(res, 200, { ok: false, code: 'missing-pkg', message: '缺少 pkg 参数' })
                return
              }
              if (!isSafePackageName(pkg)) {
                writeJson(res, 200, { ok: false, code: 'invalid-pkg', message: '包名非法，已拒绝（防路径穿越）' })
                return
              }
              const profileDir = Array.isArray(dirs) ? dirs[0] : dirs
              const info = readBundleInfo(profileDir, pkg)
              if (info === undefined) {
                writeJson(res, 200, { ok: false, code: 'not-installed', message: '该包未安装或不是 DSH bundle' })
                return
              }
              const generated = await generateRefinement(ctx, pkg, info.description)
              if (generated.ok !== true) {
                writeJson(res, 200, generated)
                return
              }
              const saved = upsertOverlay(pkg, generated.entry)
              writeJson(res, 200, Object.assign({ ok: saved.ok === true, pkg: pkg, entry: generated.entry, selection: generated.selection }, saved))
            } catch (error) {
              writeJson(res, 200, { ok: false, code: 'generate-failed', message: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/update-all',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req)
              const pkgs = body && Array.isArray(body.pkgs) ? body.pkgs : []
              writeJson(res, 200, startUpdateAll(ctx, Array.isArray(dirs) ? dirs[0] : dirs, pkgs))
            } catch (error) {
              writeJson(res, 200, { ok: false, code: 'batch-failed', message: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/update-all-status',
          handler: async (req, res) => {
            try {
              writeJson(res, 200, { ok: true, batch: updateAllStatus() })
            } catch (error) {
              writeJson(res, 200, { ok: false, code: 'status-failed', message: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/update-status',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req)
              writeJson(res, 200, updateJobStatus(body && body.token))
            } catch (error) {
              writeJson(res, 200, { ok: false, code: 'status-failed', message: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/revert',
          handler: async (req, res) => {
            try {
              writeJson(res, 200, { ok: true, value: revertLocale(dirs) })
            } catch (error) {
              writeJson(res, 200, { ok: false, message: String(error?.message ?? error) })
            }
          },
        },
      ]
      const disposers = []
      for (const route of routes) {
        try {
          disposers.push(sctx.webServer.register(route))
        } catch (error) {
          ctx.logger?.warn?.('dsh-audit-skills: bridge route failed: ' + String(error?.message ?? error))
        }
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }
    }, 'dsh-audit-skills: settings bridge')
  })
}

/** 宿主半体入口：按配置应用，绝不抛错。 */
export function apply(ctx, config = {}) {
  const dirs = resolveProfileDirs(config)
  try {
    registerBridge(ctx, dirs)
  } catch (error) {
    ctx.logger?.warn?.('dsh-audit-skills: bridge registration failed: ' + String(error?.message ?? error))
  }
  ctx.effect(() => {
    try {
      if (config.autoApply !== false) {
        const results = applyLocale(dirs)
        const applied = results.filter((r) => r.state === 'applied').length
        ctx.logger?.info?.('dsh-audit-skills: applied plugin description localization, wrote ' + applied + ' item(s)')
      }
    } catch (error) {
      ctx.logger?.warn?.('dsh-audit-skills: apply failed, degraded to read-only: ' + String(error?.message ?? error))
    }
    return () => {
      try {
        if (config.revertOnDisable !== false) revertLocale(dirs)
      } catch (error) {
        ctx.logger?.warn?.('dsh-audit-skills: revert failed: ' + String(error?.message ?? error))
      }
    }
  }, 'dsh-audit-skills: plugin description localization')
}