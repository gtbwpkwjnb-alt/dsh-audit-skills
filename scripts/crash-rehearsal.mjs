#!/usr/bin/env node
/**
 * crash-rehearsal.mjs — 重启前的崩溃演练（专治「重启后起不来」）
 *
 * 背景：本插件曾因 client.js 用裸 ESM 导致 DSH 无法启动（web boot: 1 entry did not activate）。
 * 宿主半体失败只是 warning，**客户端半体失败是致命的** —— 所以本脚本重点复现 web boot 的那条路径。
 *
 * 覆盖：
 *   1 类脚本解析（复现渲染器解析路径）
 *   2 ESM-only 语法扫描
 *   3 factory() 返回契约
 *   4 apply(ctx) 不抛
 *   5 调用每个已注册渲染回调（含两种 slotProps 形态）
 *   6 递归校验元素树（类型合法、无 undefined 组件）
 *   7 宿主半体 import + apply + 全部 bridge 路由
 *   8 bundle 补丁结构
 *   9 与真实 profile 的一致性
 *
 * 用法：node scripts/crash-rehearsal.mjs [profileDir]
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import http from 'node:http'

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')))
const PROFILE = process.argv[2] || 'C:/Users/Administrator/.dsh/profiles/desktop'
let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')) }
}

const clientPath = path.join(REPO, 'client.js')
const clientSrc = fs.readFileSync(clientPath, 'utf8')

// ── 1 类脚本解析：DSH 以传统 <script> 加载，解析失败 = 起不来 ──
console.log(String.fromCharCode(10) + '1 客户端半体：解析路径')
let parseErr = null
try { new vm.Script(clientSrc, { filename: 'client.js' }) } catch (error) { parseErr = error }
check('classic script 解析通过（失败即 web boot 崩溃）', parseErr === null, parseErr && parseErr.message)

// ── 2 ESM-only 语法扫描 ──
const esmPatterns = [
  [/^\s*import\s[^(]/m, '顶层 import 语句'],
  [/^\s*export\s/m, '顶层 export 语句'],
  [/import\.meta/, 'import.meta'],
  [/^\s*await\s/m, '顶层 await'],
]
for (const [re, label] of esmPatterns) check('无 ' + label, !re.test(clientSrc))
check('使用 __ModuleLoader__.load 注册', clientSrc.includes('__ModuleLoader__.load'))

// ── 3/4/5/6 用忠实的 React 桩执行真实渲染路径 ──
console.log(String.fromCharCode(10) + '2 客户端半体：注册与渲染')
const noop = () => {}
const reactStub = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    return { $$element: true, type, props: props || {}, children }
  },
  useState(init) { return [typeof init === 'function' ? init() : init, noop] },
  useCallback(fn) { return fn },
  useEffect() {},
  useRef(init) { return { current: typeof init === 'function' ? init() : init } },
  Component: class { constructor(props) { this.props = props || {}; this.state = {} } setState() {} },
}
const registered = []
const slotsStub = {
  inject(name, cb) { try { cb() } catch (error) { check('slots.inject(' + name + ') 回调不抛错', false, error.message) } },
  register(desc, component) { registered.push({ desc, component }); return noop },
}
const ctxStub = {
  slots: slotsStub,
  inject(services, cb) { cb({ slots: slotsStub, get: () => ({ registerTab: () => noop }), effect: (fn) => { fn(); return noop } }) },
}
let loaderEntry = null
const sandbox = { window: { __ModuleLoader__: { load(entry) { loaderEntry = entry } } }, console: { warn: noop, error: noop, log: noop } }
sandbox.globalThis = sandbox
vm.createContext(sandbox)
try { new vm.Script(clientSrc, { filename: 'client.js' }).runInContext(sandbox) } catch (error) { parseErr = error }
check('client.js 在隔离沙箱中执行无异常', parseErr === null, parseErr && parseErr.message)
check('恰好调用一次 __ModuleLoader__.load', loaderEntry !== null && loaderEntry.id === 'dsh-audit-skills', loaderEntry && loaderEntry.id)
let factoryOut = null
try { factoryOut = loaderEntry.factory((spec) => { if (spec === 'react') return reactStub; throw new Error('factory 只应 require react，却请求了 ' + spec) }) } catch (error) { factoryOut = { error } }
check('factory 仅 require react 且不抛错', factoryOut && !factoryOut.error, factoryOut && String(factoryOut.error))
check('factory 返回 name/inject/apply', factoryOut && factoryOut.name === 'dsh-audit-skills' && Array.isArray(factoryOut.inject) && typeof factoryOut.apply === 'function')
let applyErr = null
try { factoryOut.apply(ctxStub) } catch (error) { applyErr = error }
check('apply(ctx) 不抛错', applyErr === null, applyErr && applyErr.message)
check('注册了 settings.section 与 plugins.row.config', registered.length >= 2, 'got ' + registered.length + ': ' + registered.map((r) => r.desc.name).join(','))

// 递归校验元素树：类型必须合法，函数组件必须可调用
const seenTypes = new Set()
function walk(node, depth, label) {
  if (depth > 40) return
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) { for (const child of node) walk(child, depth + 1, label); return }
  if (typeof node === 'function') { seenTypes.add('fn:' + (node.name || 'anonymous')); walk(node({}), depth + 1, label); return }
  if (typeof node === 'object' && node.$$element) {
    const t = node.type
    if (t === undefined || t === null) { check(label + ' 元素类型不是 undefined', false, JSON.stringify(Object.keys(node))); return }
    if (typeof t === 'string') seenTypes.add('tag:' + t)
    else if (typeof t === 'function') {
      seenTypes.add('comp:' + (t.name || 'anonymous'))
      if (t.prototype && typeof t.prototype.render === 'function') {
        const inst = new t(node.props)
        walk(inst.render(), depth + 1, label)
      } else {
        walk(t(node.props), depth + 1, label)
      }
    } else { check(label + ' 元素类型合法', false, typeof t); return }
    if (node.props && node.props.children !== undefined) walk(node.props.children, depth + 1, label)
  }
}
for (const reg of registered) {
  const label = reg.desc.name
  const propsVariants = reg.desc.name === 'plugins.row.config'
    ? [{ view: 'summary' }, { view: 'full' }, {}, undefined]
    : [{}]
  for (const props of propsVariants) {
    let thrown = null
    let tree = null
    try { tree = reg.component(props) } catch (error) { thrown = error }
    check(label + ' 渲染回调不抛错' + (props && props.view ? '(' + props.view + ')' : ''), thrown === null, thrown && thrown.message)
    if (tree !== null) {
      let walkErr = null
      try { walk(tree, 0, label) } catch (error) { walkErr = error }
      check(label + ' 元素树遍历不抛错', walkErr === null, walkErr && walkErr.message)
    }
  }
}
check('元素树中未出现 undefined 组件', !Array.from(seenTypes).some((t) => t.includes('undefined')))

// ── 7 宿主半体 ──
console.log(String.fromCharCode(10) + '3 宿主半体：加载与 bridge')
fs.mkdirSync(path.join(REPO, 'node_modules', '@deepseek-ai'), { recursive: true })
const link = path.join(REPO, 'node_modules', '@deepseek-ai', 'schemastery')
const target = path.join(PROFILE, 'node_modules', '@deepseek-ai', 'schemastery')
let madeLink = false
try { if (!fs.existsSync(link)) { fs.symlinkSync(target, link, 'junction'); madeLink = true } } catch { /* ignore */ }
let host = null
try { host = await import('../index.js') } catch (error) { host = null; check('宿主半体可 import', false, error.message) }
if (host) {
  check('宿主半体可 import', true)
  check('导出契约完整', typeof host.apply === 'function' && typeof host.collectStatus === 'function' && typeof host.applyLocale === 'function' && typeof host.OWN_REV === 'string')
  const routes = []
  const services = { webServer: { register: (r) => { routes.push(r); return noop } } }
  const hostCtx = { logger: { info: noop, warn: noop }, effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } }, get: (n) => services[n], inject: (ns, cb) => { if (ns.every((n) => services[n] !== undefined)) cb({ get: hostCtx.get, effect: hostCtx.effect, webServer: services.webServer }) } }
  let hostApplyErr = null
  try { host.apply(hostCtx, { autoApply: false, revertOnDisable: false, profileDir: PROFILE }) } catch (error) { hostApplyErr = error }
  check('宿主 apply() 不抛错', hostApplyErr === null, hostApplyErr && hostApplyErr.message)
  check('bridge 路由数量正确', routes.length === 8, 'got ' + routes.length)
}

// ── 8 bundle 补丁 ──
console.log(String.fromCharCode(10) + '4 bundle 接线')
const patchPath = path.join(REPO, 'cordis.patch.yml')
const patchSrc = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : ''
check('cordis.patch.yml 存在', patchSrc.length > 0)
check('补丁含 insert: 与正确 id', /insert:/.test(patchSrc) && /id:\s*dsh-audit-skills/.test(patchSrc))
check('补丁不含 disable / 危险指令', !/disable|remove:/i.test(patchSrc))
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
check('package.json 声明 dsh.bundle.patch', pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml')
check('exports 暴露 ./locale/*.json 与 ./client', pkg.exports && pkg.exports['./locale/*.json'] !== undefined && pkg.exports['./client'] !== undefined)

// ── 9 与真实 profile 一致 ──
console.log(String.fromCharCode(10) + '5 真实 profile 一致性')
try {
  const profPkg = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'))
  check('本插件在 bundles 启用列表内', Array.isArray(profPkg.dsh.profile.bundles) && profPkg.dsh.profile.bundles.includes('dsh-audit-skills'))
  const spec = profPkg.dependencies['dsh-audit-skills']
  check('依赖已钉到 tag（防 pnpm 回退到会崩的旧提交）', typeof spec === 'string' && /#v\d+\.\d+\.\d+$/.test(spec), String(spec))
  const installedPath = path.join(PROFILE, 'node_modules', 'dsh-audit-skills')
  const installed = JSON.parse(fs.readFileSync(path.join(installedPath, 'package.json'), 'utf8'))
  check('已装版本与仓库版本一致', installed.version === pkg.version, installed.version + ' vs ' + pkg.version)
  const installedClient = fs.readFileSync(path.join(installedPath, 'client.js'), 'utf8')
  check('已装 client.js 与仓库逐字节一致', installedClient === clientSrc)
  check('已装 client.js 无顶层 import', !/^\s*import\s[^(]/m.test(installedClient))
  let installedParseErr = null
  try { new vm.Script(installedClient, { filename: 'installed-client.js' }) } catch (error) { installedParseErr = error }
  check('已装 client.js 可被类脚本解析', installedParseErr === null, installedParseErr && installedParseErr.message)
} catch (error) {
  check('真实 profile 可读', false, error.message)
}

// ── 6 client.inject 可满足性（缺一个即 web boot 激活失败，属致命类） ──
console.log(String.fromCharCode(10) + '6 client.inject 可满足性')
const clientMeta = (pkg.dsh && pkg.dsh.client) || {}
check('dsh.client.platform 为 web', clientMeta.platform === 'web', String(clientMeta.platform))
const injectList = Array.isArray(clientMeta.inject) ? clientMeta.inject : []
const profilePkgs = new Set()
try {
  const nmDir = path.join(PROFILE, 'node_modules')
  for (const name of fs.readdirSync(nmDir)) {
    if (name.startsWith('@')) { for (const sub of fs.readdirSync(path.join(nmDir, name))) profilePkgs.add(name + '/' + sub) }
    else profilePkgs.add(name)
  }
} catch { /* ignore */ }
const appPkgs = new Set()
try {
  const ASAR = process.env.DSH_APP_ASAR || 'D:/DSH/DeepSeekHarness/resources/app.asar'
  const fd = fs.openSync(ASAR, 'r')
  const headBuf = Buffer.alloc(16); fs.readSync(fd, headBuf, 0, 16, 0)
  const hdrSize = headBuf.readUInt32LE(4)
  const raw = Buffer.alloc(hdrSize); fs.readSync(fd, raw, 0, hdrSize, 8)
  const text = raw.toString('utf8')
  const s0 = text.indexOf('{')
  let depth = 0, inStr = false, esc = false, e0 = -1
  for (let i = s0; i < text.length; i++) {
    const c = text[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { e0 = i + 1; break } }
  }
  const header = JSON.parse(text.slice(s0, e0))
  const walkAsar = (node, prefix) => {
    for (const [name, val] of Object.entries(node.files || {})) {
      const full = prefix + '/' + name
      if (val.files) walkAsar(val, full)
      else { const m = full.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)\/package\.json$/); if (m) appPkgs.add(m[1]) }
    }
  }
  walkAsar(header, '')
  fs.closeSync(fd)
} catch (error) { console.log('  (asar 读取失败，跳过 app 侧判定: ' + error.message + ')') }
for (const mod of injectList) {
  const inProfile = profilePkgs.has(mod)
  const inApp = appPkgs.has(mod)
  check('client.inject 可满足：' + mod, inProfile || inApp, inProfile ? 'profile' : (inApp ? 'app' : '两处都没有 → 会导致 web boot 激活失败（致命）'))
}

// ── 7 故障注入：确保任何子服务异常都不会外抛（外抛 = 可能拖垮 web boot） ──
console.log(String.fromCharCode(10) + '7 故障注入（异常不得外抛）')
function loadAndApply(makeCtx) {
  let entry = null
  const sb = { window: { __ModuleLoader__: { load: (e) => { entry = e } } }, console: { warn: noop, error: noop, log: noop } }
  sb.globalThis = sb
  vm.createContext(sb)
  try { new vm.Script(clientSrc, { filename: 'client.js' }).runInContext(sb) } catch (error) { return error }
  let out = null
  try { out = entry.factory((s) => { if (s === 'react') return reactStub; throw new Error('unexpected require: ' + s) }) } catch (error) { return error }
  try { out.apply(makeCtx()) } catch (error) { return error }
  return null
}
// A slots.register 直接抛错
const errA = loadAndApply(() => {
  const badSlots = { inject: (name, cb) => cb(), register: () => { throw new Error('slot register rejected') } }
  return { slots: badSlots, inject: (services, cb) => cb({ slots: badSlots, get: () => undefined, effect: (fn) => { fn(); return noop } }) }
})
check('slots.register 抛错时 apply 不外抛', errA === null, errA && errA.message)
// B betterSidebar.registerTab 抛错（本机 better-sidebar 配置里本插件 tab 为 false，很可能走这条）
const errB = loadAndApply(() => ({
  slots: slotsStub,
  inject: (services, cb) => cb({ slots: slotsStub, get: () => ({ registerTab: () => { throw new Error('tab disabled by config') } }), effect: (fn) => { fn(); return noop } }),
}))
check('registerTab 抛错时 apply 不外抛', errB === null, errB && errB.message)
// C slots 服务完全缺失（ctx.slots undefined）
const errC = loadAndApply(() => ({ inject: () => noop }))
check('slots 服务缺失时 apply 不外抛', errC === null, errC && errC.message)
// D betterSidebar 服务缺失
const errD = loadAndApply(() => ({ slots: slotsStub, inject: (services, cb) => { if (services.indexOf('slots') >= 0) cb({ slots: slotsStub, get: () => undefined, effect: (fn) => { fn(); return noop } }) } }))
check('betterSidebar 服务缺失时 apply 不外抛', errD === null, errD && errD.message)
// E effects 为空对象（无 ctx.effect）
const errE = loadAndApply(() => ({ slots: slotsStub, inject: (services, cb) => { try { cb({ slots: slotsStub, get: () => ({ registerTab: () => noop }) }) } catch (error) { throw error } } }))
check('ctx.effect 缺失时 apply 不外抛', errE === null, errE && errE.message)

// 收尾
if (madeLink) { try { fs.rmSync(path.join(REPO, 'node_modules'), { recursive: true, force: true }) } catch { /* ignore */ } }
console.log(String.fromCharCode(10) + 'CRASH REHEARSAL  pass=' + pass + '  fail=' + fail)
console.log(fail === 0 ? '结论：未发现崩溃风险，可安全重启。' : '结论：存在风险，先修复再重启。')
process.exitCode = fail === 0 ? 0 : 1