/**
 * dsh-audit-skills — DSH 插件体系审查（宿主半体）
 *
 * 主要功能：把插件页（内置 Plugins 页 / 侧边栏）的说明文字精炼为中文。
 * 命名约定（不可违反）：title 保留原包名，中文名以全角括号附加，否则无法识别原插件。
 *
 * 设计边界（见 docs/design-boundaries.md）
 * - 零第三方依赖；apply() 全量 try/catch，任何异常都不外抛（T1 自指崩溃防护）。
 * - 写 node_modules 内文件会被升级/重装覆盖（T2），因此每处写入都留 .dsh-locale.backup。
 * - 只做「精炼 + 汇总 + 报告」；更新检查 / 推荐 / 守护一律委托生态既有插件。
 * - 不注册 skill：本插件是插件形态，不是技能形态。
 *
 * 开关语义（T3）：bundle 启用 → apply() 应用精炼；停用 → dispose() 默认还原。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
      const entry = byPkg.get(pkg)
      const st = inspectPackage(profileDir, { pkg })
      out.push({
        profileDir,
        pkg,
        installed: true,
        enabled: manifest.bundles.includes(pkg),
        inCatalog: entry !== undefined,
        // 没有 catalog 文案、自身也没有 locale 文件 → 需要补文案
        needsText: entry === undefined && !st.localized,
        localized: st.localized,
        title: st.title,
        version: info.version,
        description: info.description,
      })
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
    return list.map((b) => {
      const st = inspectPackage(profileDir, { pkg: b.name })
      return {
        profileDir,
        pkg: b.name,
        installed: b.installed !== false,
        enabled: b.enabled === true,
        version: typeof b.version === 'string' ? b.version : null,
        description: typeof b.description === 'string' ? b.description : '',
        error: b.error ? String(b.error.code ?? b.error) : null,
        localized: st.localized,
        title: st.title,
        inCatalog: false,
        needsText: !st.localized,
      }
    })
  } catch (error) {
    return undefined
  }
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
export function startUpdate(ctx, profileDir, pkg) {
  const plan = resolveUpdateSpec(profileDir, pkg)
  if (plan.spec === null) return { ok: false, code: 'unsupported-spec', message: plan.reason }
  const pm = getPluginManager(ctx)
  if (pm === undefined) return { ok: false, code: 'manager-unavailable', message: '插件管理器服务未就绪（重启 DSH 后可用）' }
  if (typeof pm.installBundle !== 'function') return { ok: false, code: 'manager-unsupported', message: '插件管理器未提供 installBundle' }
  const token = pkg + ':' + Date.now().toString(36)
  const base = { pkg, spec: plan.spec, kind: plan.kind, startedAt: Date.now() }
  updateJobs.set(token, Object.assign({}, base, { stage: 'installing', message: '正在执行安装（pnpm，可能持续数十秒）…', done: false, ok: null }))
  Promise.resolve()
    .then(() => pm.installBundle(plan.spec, {}))
    .then((result) => {
      const job = updateJobs.get(token) ?? base
      updateJobs.set(token, Object.assign({}, job, { stage: 'done', message: '安装完成。新版本需刷新页面或重启 DSH 才会加载。', done: true, ok: true, result: result ?? null }))
    })
    .catch((error) => {
      const job = updateJobs.get(token) ?? base
      updateJobs.set(token, Object.assign({}, job, { stage: 'failed', message: String((error && error.message) || error), done: true, ok: false }))
    })
  return { ok: true, token, plan: { kind: plan.kind, spec: plan.spec, range: plan.range } }
}

/** 查询更新进度。 */
export function updateJobStatus(token) {
  const job = typeof token === 'string' ? updateJobs.get(token) : undefined
  if (job === undefined) return { ok: false, code: 'unknown-token', message: '任务不存在或已过期' }
  return { ok: true, job }
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
      reason: '该插件没有内置精炼文案。本插件不调用模型，自己无法生成中文。',
      remedy: '把包名发给 Agent，Agent 会把精炼文案写进覆盖层文件；写好后点「刷新状态」即可生效。',
      action: { kind: 'open-overlay', label: '打开覆盖层', path: overlayPath() },
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
          res.end(JSON.stringify(body))
        } catch {
          /* 响应已结束等情况忽略 */
        }
      }
      const routes = [
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/status',
          handler: async (req, res) => {
            try {
              // 优先用插件管理器（与插件页同源）；不可用时回落到自行扫描
              const viaService = collectStatusViaService(ctx, dirs)
              const rows = viaService ?? collectStatus(dirs)
              writeJson(res, 200, { ok: true, value: rows.map((row) => Object.assign({}, row, { issues: describeIssues(row) })) })
            } catch (error) {
              writeJson(res, 200, { ok: false, message: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: BRIDGE_PREFIX + '/apply',
          handler: async (req, res) => {
            try {
              writeJson(res, 200, { ok: true, value: applyLocale(dirs) })
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
              const rows = collectStatusViaService(ctx, dirs) ?? collectStatus(dirs)
              const out = []
              for (const row of rows) {
                if (row.version === null || row.version === undefined) {
                  out.push(Object.assign({}, row, { latest: null, hasUpdate: null, reason: 'no-version' }))
                  continue
                }
                const r = await fetchLatestVersion(row.pkg)
                if (r.status !== 'ok') {
                  out.push(Object.assign({}, row, { latest: null, hasUpdate: null, reason: r.reason ?? 'unavailable' }))
                  continue
                }
                out.push(Object.assign({}, row, { latest: r.latest, hasUpdate: r.latest !== row.version, reason: null }))
              }
              writeJson(res, 200, { ok: true, value: out.map((row) => Object.assign({}, row, { issues: describeIssues(row) })) })
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
              writeJson(res, 200, startUpdate(ctx, Array.isArray(dirs) ? dirs[0] : dirs, pkg))
            } catch (error) {
              writeJson(res, 200, { ok: false, code: 'update-failed', message: String(error?.message ?? error) })
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
