#!/usr/bin/env node
/**
 * render-smoke.mjs — 客户端半体的**真渲染**冒烟测试（v2.8.0 新增，常驻）
 *
 * 为什么必须有：crash-rehearsal 只验到「apply() 不抛错 + 顶层组件返回元素」——
 * 它的 walk() 读 node.children，而 React 语义里子节点在 props.children，
 * 于是 Merged 之后（Panel、表格、KPI、本轮结果、详情卡）**从来没有被真正渲染过**。
 * 那等于「客户端 UI 无人验证」：一个 TypeError 只有用户打开设置页才会发现。
 *
 * 本脚本用一个等价于 React 的迷你运行时（createElement / Component / useState /
 * useCallback / useEffect / key 语义）把组件真的跑起来：mock fetch 喂进**实测抓取的
 * 快照形状**，跑完 effect、触发重渲染，再对渲染结果做断言。
 *
 * 重点回归用户报告的矛盾：批量记录说「已完成」、行里却还有「更新」——
 * 现在必须由页面自己解释「记录已超出锁定保鲜期，不再约束下表」。
 *
 * 用法：node scripts/render-smoke.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLIENT = path.join(REPO, 'client.js')
const clientSrc = fs.readFileSync(CLIENT, 'utf8')

let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')) }
}

// ───────────────────────── 迷你 React 运行时 ─────────────────────────
function createRuntime() {
  const instances = new Map()
  const errors = []
  let current = null
  let dirty = false

  const api = {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      const merged = Object.assign({}, props || {})
      if (children.length > 0 && merged.children === undefined) {
        merged.children = children.length === 1 ? children[0] : children
      }
      return { $$element: true, type, props: merged }
    },
    Component: class {
      constructor(props) { this.props = props || {}; this.state = {} }
      setState(patch) {
        this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch)
        dirty = true
      }
      static getDerivedStateFromError(error) { return { error } }
    },
    useState(init) {
      api.__inject.stateCalls += 1
      if (api.__inject.throwOnStateCall === api.__inject.stateCalls) {
        api.__inject.throwOnStateCall = 0
        throw new Error('注入的渲染期异常（演练 Boundary 隔离）')
      }
      const slot = api.__slot()
      if (slot.ready !== true) { slot.v = typeof init === 'function' ? init() : init; slot.ready = true }
      return [slot.v, (next) => { slot.v = typeof next === 'function' ? next(slot.v) : next; dirty = true }]
    },
    /* 与 React 一致：deps 变了就换新函数。
       此前忽略 deps → refresh（deps 含 done）在 harness 里永远是首次那个闭包，
       于是新写的「已释放上一轮 N 个行锁」文案零覆盖、且与真机行为不一致。 */
    useCallback(fn, deps) {
      const slot = api.__slot()
      const prev = slot.cbDeps
      const changed = prev === undefined || deps === undefined || deps.length !== prev.length || deps.some((d, i) => d !== prev[i])
      if (changed) { slot.v = fn; slot.cbDeps = deps ? deps.slice() : undefined }
      return slot.v
    },
    /* 故障注入开关：让第 N 次 useState 抛错，用来演练 Boundary（否则错误边界从未被执行过）。 */
    __inject: { throwOnStateCall: 0, stateCalls: 0 },
    useEffect(fn, deps) {
      const slot = api.__slot()
      const prev = slot.deps
      const changed = prev === undefined || deps === undefined || deps.length !== prev.length || deps.some((d, i) => d !== prev[i])
      if (changed) { slot.deps = deps ? deps.slice() : undefined; slot.pending = fn }
    },
    __slot() {
      const inst = instances.get(current)
      const i = inst.cursor++
      if (inst.hooks[i] === undefined) inst.hooks[i] = {}
      return inst.hooks[i]
    },
    __enter(key, props) {
      if (!instances.has(key)) instances.set(key, { hooks: [], cursor: 0 })
      const inst = instances.get(key)
      inst.cursor = 0
      inst.props = props
      current = key
      return inst
    },
    __leave() { current = null },
    __instances: instances,
  }

  function renderNode(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
    if (Array.isArray(node)) return node.map(renderNode).filter(Boolean)
    if (!node.$$element) return { text: String(node) }
    const type = node.type
    if (typeof type === 'string') {
      return { tag: type, props: node.props, kids: renderNode(node.props.children) }
    }
    if (typeof type !== 'function') throw new Error('非法元素类型：' + String(type))
    const name = type.name || 'anon'
    /* key 语义：本插件用 key={mode} 让插件/技能两视图各自挂载（切走即卸载），必须复刻。 */
    const key = name + (node.props && node.props.key !== undefined ? '#' + String(node.props.key) : '')
    const inst = api.__enter(key, node.props)
    try {
      if (type.prototype && typeof type.prototype.render === 'function') {
        if (inst.instance === undefined) inst.instance = new type(node.props)
        else inst.instance.props = node.props
        try {
          return renderNode(inst.instance.render())
        } catch (error) {
          /* 复刻 error boundary：类组件声明了 getDerivedStateFromError 就由它兜住。 */
          if (typeof type.getDerivedStateFromError === 'function') {
            if (process.env.DAS_SMOKE_TRACE) console.error('BOUNDARY ' + (error && error.stack))
            inst.instance.state = Object.assign({}, inst.instance.state, type.getDerivedStateFromError(error))
            return renderNode(inst.instance.render())
          }
          throw error
        }
      }
      return renderNode(type(node.props))
    } finally {
      api.__leave()
    }
  }

  function takePending() {
    const out = []
    for (const inst of instances.values()) {
      for (const slot of inst.hooks) {
        if (typeof slot.pending === 'function') { out.push(slot.pending); slot.pending = undefined }
      }
    }
    return out
  }

  return { api, renderNode, takePending, errors, isDirty: () => dirty, clearDirty: () => { dirty = false } }
}

// ───────────────────────── 渲染结果查询工具 ─────────────────────────
function elementsOf(tree, pred) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.tag) { if (pred(node)) out.push(node); walk(node.kids) }
  }
  walk(tree)
  return out
}
function textOf(tree) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    /* 跳过 style：内联 CSS 不该混进文本断言 */
    if (node.tag === 'style' || node.tag === 'script') return
    if (node.text !== undefined) { out.push(node.text); return }
    if (node.kids !== undefined) walk(node.kids)
  }
  walk(tree)
  return out.join(' ')
}
function titlesOf(tree) {
  return elementsOf(tree, (n) => typeof n.props.title === 'string' || typeof n.props['aria-label'] === 'string')
    .map((n) => typeof n.props.title === 'string' ? n.props.title : n.props['aria-label']).join(' | ')
}
function buttonByText(tree, needle) {
  return elementsOf(tree, (n) => n.tag === 'button' && textOf(n).includes(needle))[0]
}
/** 精确匹配按钮文字：'更新' 必须命中行内按钮，而不是「一键更新（4）」。 */
function buttonByExactText(tree, label) {
  return elementsOf(tree, (n) => n.tag === 'button' && textOf(n).trim() === label)[0]
}

// ───────────────────────── 实测抓取的快照形状 ─────────────────────────
const REV = '2.10.5'

const pluginRow = (o) => Object.assign({ kind: 'plugin', installed: true, enabled: true, issues: [], findings: [], source: 'profile' }, o)

const PLUGIN_ROWS = [
  pluginRow({ pkg: '@deepseek-ai/dsh-base', version: '2.4.0', latest: null, hasUpdate: null, reason: '内置运行时', localized: false, needsText: true, bundled: true, translationEligible: false, readOnlyReason: 'unaddressable' }),
  pluginRow({ pkg: '@changfenhuang/dsh-annotation', version: '1.4.10', latest: '1.4.10', hasUpdate: false, localized: true, needsText: false, displayName: '@changfenhuang/dsh-annotation（划词批注）', localizedDescription: '选中助手回复中的文字即可批注，回车随消息一起发送' }),
  pluginRow({ pkg: '@furongjun1999/dsh-memory', version: '0.5.0', latest: '0.5.1', hasUpdate: true, localized: true, needsText: false }),
  pluginRow({ pkg: '@wxg-prc-cpg/browser-skill-dsh-plugin', version: '0.3.1', latest: '0.3.1', hasUpdate: false, localized: false, needsText: true, inCatalog: true }),
  pluginRow({
    pkg: 'dsh-audit-skills', version: '2.10.5', latest: null, hasUpdate: null, reason: 'HTTP 404', localized: true, needsText: false,
    issues: [{ code: 'not-on-npm', reason: 'npm registry 上没有这个包（HTTP 404）', remedy: 'GitHub 直装，跳过 npm 比对', action: { kind: 'hint', label: 'GitHub 直装，跳过 npm 比对' } }],
    findings: [
      { id: 'interaction:sharedinject:x', kind: 'interaction', pkg: 'dsh-audit-skills', peers: [], severity: 'low', confidence: 'fact', title: '与另一个插件共享非平台模块', evidence: '两者都 inject third-party-shared', remedy: '若两者版本不兼容会一起坏，建议锁定版本。' },
      { id: 'interaction:userpatch:y', kind: 'interaction', pkg: 'dsh-audit-skills', peers: [], severity: 'low', confidence: 'inferred', title: '用户补丁层与插件新增行撞名', evidence: 'cordis.patch.yml 与插件 insert 同名', remedy: '确认以哪一层为准。' },
    ],
  }),
  pluginRow({ pkg: 'dsh-better-sidebar', version: '0.21.1', latest: '0.21.1', hasUpdate: false, localized: true, needsText: false }),
  pluginRow({ pkg: 'dsh-compact-button', version: '1.1.0', latest: '0.5.0', hasUpdate: false, localized: true, needsText: false }),
  pluginRow({ pkg: 'dsh-computer-use-win', version: '0.1.2', latest: '0.2.2', hasUpdate: true, localized: true, needsText: false }),
  pluginRow({ pkg: 'dsh-context', version: '0.56.2', latest: '0.56.2', hasUpdate: false, localized: true, needsText: false, displayName: 'dsh-context（上下文面板）', localizedDescription: '中文说明：给模型提供上下文面板' }),
  /* 第 4 个「可更新」的插件，且**不在** batchItems() 里 —— 有了它，
     「未锁的行不受影响」「锁有效时不必再贴记录」这两条才不是恒真的空断言。 */
  pluginRow({ pkg: 'dsh-context-doctor', version: '0.1.0', latest: '0.2.0', hasUpdate: true, localized: true, needsText: false }),
  pluginRow({ pkg: 'dsh-find-plugins', version: '0.2.7', latest: '0.2.7', hasUpdate: false, localized: true, needsText: false }),
  pluginRow({ pkg: 'dsh-free-search', version: '0.4.39', latest: '0.4.39', hasUpdate: false, localized: true, needsText: false }),
  pluginRow({ pkg: 'dsh-sidebar-qa', version: '1.0.2', latest: '1.0.2', hasUpdate: false, localized: true, needsText: false }),
  pluginRow({ pkg: 'dsh-whale-widget', version: '0.3.15', latest: '0.3.16', hasUpdate: true, localized: true, needsText: false }),
]

const SKILL_ROOT = 'rank 500 · C:\\Users\\Administrator\\.agents\\skills'
const skillRow = (o) => Object.assign({
  kind: 'skill', installed: true, enabled: true, source: SKILL_ROOT, sourceLabel: '本地技能，无远端仓库', sourceUrl: '', purpose: '触发词 → 用于验证技能作用说明。', descriptionLang: '中文为主',
  isGit: false, localSha: '', remoteSha: null, dirty: 0, hasUpdate: null, bundled: false,
  skillPath: '', bytes: 100, frontmatter: true, dirMismatch: false, nestedSkillFiles: 0,
  shadowed: [], repoUrl: '', branch: '', upstream: '', repoOwned: false, issues: [], findings: [],
}, o)

/* 与实测 POST /skills 一致：10 个技能里 5 个未声明 version，两个是 git 仓库且有本地改动。 */
const SKILL_ROWS = [
  skillRow({ pkg: 'agent-reach', version: '1.6.0', localized: false, needsText: true, descriptionLang: '英文' }),
  skillRow({ pkg: 'cangjie-skill', version: '0.2.0', localized: false, needsText: true }),
  skillRow({ pkg: 'gpt-tasteskill', version: '1.0.0', localized: false, needsText: true }),
  skillRow({ pkg: 'learn', version: null, localized: false, needsText: true, isGit: true, repoOwned: true, repoUrl: 'https://github.com/x/learn', sourceLabel: 'GitHub 原作者仓库', sourceUrl: 'https://github.com/x/learn', branch: 'main', localSha: 'b1c7007f02c32c18bf83c4ea6df8a62aab2b5953', remoteSha: 'b1c7007f02c32c18bf83c4ea6df8a62aab2b5953', hasUpdate: false, dirty: 3, displayName: 'learn（学习一个视频）', purpose: '把长视频与播客蒸馏成可执行方法论', localizedDescription: '中文说明：学习一个视频并生成闪卡' }),
  skillRow({ pkg: 'luopan', version: null, localized: false, needsText: true, descriptionLang: '中文' }),
  skillRow({ pkg: 'ponytail', version: null, localized: false, needsText: true }),
  skillRow({ pkg: 'ruofeng-adversarial-review', version: '0.1.0', localized: false, needsText: true }),
  skillRow({ pkg: 'session-summarize', version: null, localized: false, needsText: true, isGit: true, repoOwned: true, repoUrl: 'https://github.com/x/ss', sourceLabel: 'GitHub 原作者仓库', sourceUrl: 'https://github.com/x/ss', branch: 'main', localSha: '36acead2edf22c2d3680611fef61697d2c7d6dbf', remoteSha: '36acead2edf22c2d3680611fef61697d2c7d6dbf', hasUpdate: false, dirty: 2 }),
  skillRow({ pkg: 'skillopt', version: '0.2.0', localized: false, needsText: true }),
  skillRow({ pkg: 'skills-summarize-audit', version: null, localized: false, needsText: true }),
]

const AUDIT = { generatedAt: Date.now(), counts: { high: 0, medium: 0, low: 1, fact: 0, inferred: 1 }, noCompat: [] }

/** 实测 POST /update-all-status：三项都「安装已执行，但版本未变」。 */
function batchItems() {
  return [
    { pkg: '@furongjun1999/dsh-memory', state: 'unchanged', message: '安装已执行，但版本未变（仍为 0.5.0）', from: '0.5.0', to: '0.5.0' },
    { pkg: 'dsh-computer-use-win', state: 'unchanged', message: '安装已执行，但版本未变（仍为 0.1.2）', from: '0.1.2', to: '0.1.2' },
    { pkg: 'dsh-whale-widget', state: 'unchanged', message: '安装已执行，但版本未变（仍为 0.3.15）', from: '0.3.15', to: '0.3.15' },
  ]
}
function makeBatch(ageMs, interrupted) {
  if (interrupted === true) {
    /* 宿主判为「超过 10 分钟无进展」而中断的那一批：running=false 且没有 finishedAt。 */
    return {
      running: false, index: 1, total: 3, items: [batchItems()[0]],
      message: '上次批量更新已中断（超过 10 分钟无进展）', startedAt: Date.now() - 90 * 60 * 1000, finishedAt: null,
    }
  }
  return {
    running: false, index: 3, total: 3, items: batchItems(),
    message: '完成：成功 0 个，未变化 3 个，失败 0 个',
    startedAt: Date.now() - ageMs - 60000,
    finishedAt: Date.now() - ageMs,
  }
}

/** 上次翻译优化的落盘记录（宿主 /updates 的 translate 字段）：一项失败、一项成功。 */
function translateRecord() {
  return {
    action: 'optimize',
    finishedAt: Date.now() - 90 * 60 * 1000,
    total: 2, generated: 0, applied: 1, failed: 1, skipped: 0,
    message: '翻译优化完成：应用 1 项，失败 1 个',
    items: [
      { pkg: '@wxg-prc-cpg/browser-skill-dsh-plugin', state: 'failed', message: '找不到默认模型，请先在设置里选定默认模型' },
      { pkg: 'dsh-context', state: 'applied', message: '已写入 locale/zh.json' },
    ],
  }
}

/* 可按用例切换的 generate / apply 返回值（默认 null = 与历史行为一致，零影响） */
let mockGenerate = null
let mockApplyValue = null
/* /skills 读取失败的可切换返回值（默认 null = 正常返回 SKILL_ROWS）。 */
let mockSnapshotFailure = null

function fetchImpl(state) {
  const json = (payload) => ({ ok: true, status: 200, json: async () => payload })
  return async (url, init) => {
    /* 在调用时取，而不是构造时 —— scenario() 是在 loadClient() 之后才设 state.hostRev 的。 */
    const hostRev = state.hostRev || REV
    const action = String(url).split('/').pop()
    state.calls.push(action)
    if (init && typeof init.body === 'string') {
      /* url 段单独留一份：请求体自己带 action 时（/translate-run 的 body 是 {action:'optimize',…}）
         会盖住 action 字段，测试里按 url 找才不会被误导。 */
      try { state.posted.push(Object.assign({ url: action }, JSON.parse(init.body))) } catch { state.posted.push({ url: action, action: action }) }
    }
    /* 插件视图与技能视图共用同一条「读取失败」提示路径，夹具对 updates/skills 同时生效。 */
    if ((action === 'updates' || action === 'skills') && mockSnapshotFailure !== null) {
      return json(Object.assign({ rev: hostRev }, mockSnapshotFailure))
    }
    if (action === 'updates') return json({ rev: hostRev, ok: true, audit: AUDIT, translate: translateRecord(), value: PLUGIN_ROWS })
    if (action === 'skills') return json({ rev: hostRev, ok: true, translate: translateRecord(), audit: { generatedAt: Date.now(), counts: { high: 1, medium: 0, low: 0, fact: 1, inferred: 0 }, noCompat: [] }, value: SKILL_ROWS })
    /* generate / apply 的返回值可按用例切换（默认保持原行为：generate 走 404 兜底、apply 报 applied） */
    if (action === 'generate') {
      return mockGenerate === null
        ? json({ rev: hostRev, ok: false, code: 'http-404', message: 'HTTP 404（接口 generate 不存在？）' })
        : json(Object.assign({ rev: hostRev }, mockGenerate))
    }
    if (action === 'apply') {
      return json({
        rev: hostRev,
        ok: true,
        value: mockApplyValue === null
          ? [{ pkg: '@wxg-prc-cpg/browser-skill-dsh-plugin', state: 'applied', exportNote: 'added-locale-export' }]
          : mockApplyValue,
      })
    }
    if (action === 'translate-run') return json({ rev: hostRev, ok: true, value: { action: 'auto-apply', items: [], total: 0 } })
    if (action === 'update-all-status') return json({ rev: hostRev, ok: true, batch: makeBatch(state.batchAgeMs, state.interrupted) })
    if (action === 'update-status') return json({ rev: hostRev, ok: false, code: 'unknown-token', message: '任务不存在或已过期' })
    return json({ rev: hostRev, ok: false, code: 'http-404', message: 'HTTP 404（接口 ' + action + ' 不存在？）' })
  }
}

// ───────────────────────── 场景驱动 ─────────────────────────
function loadClient(fetchFn) {
  const rt = createRuntime()
  const state = { calls: [], posted: [] }
  const timers = { n: 0 }
  const sb = {
    window: { __ModuleLoader__: { load: () => {} }, innerWidth: 1024, innerHeight: 768 },
    console: { warn: () => {}, error: () => {}, log: () => {} },
    fetch: fetchFn(state),
    setTimeout: (fn, ms) => { if (timers.n > 200) return 0; timers.n += 1; return setTimeout(fn, Math.min(Number(ms) || 0, 5)) },
    clearTimeout,
    Date, JSON, Object, Array, Math, Number, String, Boolean, RegExp, Promise, isNaN, parseInt, setImmediate,
  }
  sb.globalThis = sb
  vm.createContext(sb)
  let entry = null
  sb.window.__ModuleLoader__.load = (x) => { entry = x }
  let loadError = null
  try { new vm.Script(clientSrc, { filename: 'client.js' }).runInContext(sb) } catch (e) { loadError = e }
  if (loadError) throw loadError
  const out = entry.factory((spec) => { if (spec === 'react') return rt.api; throw new Error('未声明的 require: ' + spec) })
  const registered = []
  const slots = {
    inject(name, cb) { cb() },
    register(desc, component) { registered.push({ desc, component }); return () => {} },
  }
  const ctx = {
    slots,
    inject(services, cb) { cb({ slots, get: () => ({ registerTab: () => () => {} }), effect: (fn) => { fn() } }) },
  }
  out.apply(ctx)
  return { rt, out, registered, state, timers }
}

/** 渲染 + 跑完所有 effect + 重渲染，直到状态稳定。渲染期异常也收进 errors（标签才名副其实）。 */
async function renderSettled(rt, element) {
  let tree = null
  const safeRender = () => {
    try { tree = rt.renderNode(element) } catch (error) { rt.errors.push(error); if (process.env.DAS_SMOKE_TRACE) console.error('RENDER ' + (error && error.stack)); tree = null }
  }
  safeRender()
  for (let i = 0; i < 30; i++) {
    const pending = rt.takePending()
    if (pending.length === 0 && !rt.isDirty()) break
    rt.clearDirty()
    for (const fn of pending) {
      try { await fn() } catch (error) { rt.errors.push(error); if (process.env.DAS_SMOKE_TRACE) console.error('EFFECT ' + (error && error.stack)) }
    }
    await new Promise((resolve) => setTimeout(resolve, 6))
    safeRender()
  }
  return { tree, errors: rt.errors }
}

/** 模拟点击：找到按钮、调用它真实的 onClick、把状态跑稳。 */
async function clickAndSettle(rt, element, tree, label, exact) {
  const btn = exact === true ? buttonByExactText(tree, label) : buttonByText(tree, label)
  if (!btn || typeof btn.props.onClick !== 'function') throw new Error('找不到可点击的按钮：' + label)
  await btn.props.onClick()
  return renderSettled(rt, element)
}

/** 回到插件视图（scenario() 结尾把 Merged 切到了技能视图）——Panel#plugin 实例会被复用。 */
function backToPlugin(loaded) {
  loaded.rt.api.__instances.get('Merged').hooks[0].v = 'plugin'
}

async function scenario(batchAgeMs, interrupted, hostRev) {
  const loaded = loadClient(fetchImpl)
  loaded.state.batchAgeMs = batchAgeMs
  loaded.state.interrupted = interrupted === true
  if (hostRev) loaded.state.hostRev = hostRev
  const section = loaded.registered.find((r) => r.desc.name === 'settings.section')
  const element = section.component({})
  const first = await renderSettled(loaded.rt, element)
  const pluginTree = first.tree
  /* 模拟用户点「技能」页签：Merged 的 mode 是它的第 0 个 hook。
     直接改 hook 值再重渲染，与 setState('skill') 等价 —— 并且同样会让 key={mode} 的
     Panel 换实例、真正重新挂载（这正是要验证的行为）。 */
  const merged = loaded.rt.api.__instances.get('Merged')
  merged.hooks[0].v = 'skill'
  const second = await renderSettled(loaded.rt, element)
  return { loaded, element, pluginTree, skillTree: second.tree, errors: first.errors.concat(second.errors) }
}

// ───────────────────────── 1 插件视图：92 分钟前的过期记录 ─────────────────────────
console.log('\n1 插件视图 · 批量记录已完成但已超出锁定保鲜期（复刻用户截图那一刻）')
const stale = await scenario(92 * 60 * 1000)
const staleText = textOf(stale.pluginTree)
const staleTitles = titlesOf(stale.pluginTree)
/* 行集合：后面多处复用，定义提前（同一个模块作用域，不能重复声明） */
const dataRows = elementsOf(stale.pluginTree, (n) => n.tag === 'tr' && elementsOf(n, (m) => m.tag === 'td').length > 1)
check('渲染无异常（apply / 渲染 / effect 都算）', stale.errors.length === 0, stale.errors.map((e) => e.message).join(' | '))
check('取到了 /updates 与 /update-all-status', stale.loaded.state.calls.includes('updates') && stale.loaded.state.calls.includes('update-all-status'), stale.loaded.state.calls.join(','))
/* 随 DSH 提供的行默认隐藏，所以断言「除内置行外都在表里」 */
check('全部非内置插件成行（' + PLUGIN_ROWS.filter((r) => r.bundled !== true).length + ' 个）',
  PLUGIN_ROWS.filter((r) => r.bundled !== true).every((r) => staleText.includes(r.pkg)),
  '缺：' + PLUGIN_ROWS.filter((r) => r.bundled !== true && !staleText.includes(r.pkg)).map((r) => r.pkg).join(','))
check('KPI 数据带渲染（插件 / 中文化 / 更新状态 / 需处置）', staleText.includes('插件') && staleText.includes('已中文化') && staleText.includes('更新状态') && staleText.includes('需处置'))
/* ── 用户第二条：KPI 数据带与提示行太占地方（先红后绿） ── */
const statsBar = elementsOf(stale.pluginTree, (n) => n.props && String(n.props.className || '').indexOf('das-stats') >= 0)[0]
check('【密度】KPI 收成一条数据带（.das-stats），不再是格子网格',
  !!statsBar && !/\.das-kpi \{[^}]*display: grid/.test(clientSrc))
check('【密度】数据带里没有块级格子（每项都是行内元素）',
  !!statsBar && elementsOf(statsBar.kids, (n) => n.tag === 'div').length === 0,
  statsBar ? 'divs=' + elementsOf(statsBar.kids, (n) => n.tag === 'div').length : '找不到 .das-stats')
/* 用户：插件中随 DSH 提供的，隐藏 —— 默认不占列表，但要如实给出数量且能一键显示 */
check('【内置行】默认隐藏随 DSH 提供的对象（列表里不再出现）',
  !staleText.includes('@deepseek-ai/dsh-base'), staleText.slice(0, 160))
check('【内置行】给出隐藏数量并提供显示入口（不是静默隐藏）',
  staleText.includes('随 DSH') && /展开/.test(staleText), staleText.slice(0, 220))
check('本轮结果合并到状态提示与对象行', staleText.includes('本轮处理 3 项') && staleTitles.includes('安装已执行，但版本未变（仍为 0.5.0）'))
check('【核心】历史结果不再单独占表，页面说明当前按快照判定', staleText.includes('按最新快照') && !staleText.includes('记录不约束下表'))
check('超期状态保持紧凑且不重复渲染结果表', (staleText.match(/本轮处理 3 项/g) || []).length === 1)
check('对象行继续保留结果说明', staleTitles.includes('它不是当前状态'))
check('超期 = 不锁行：可更新的行仍给出「更新」入口（含不在该批次里的第 4 行）',
  staleText.includes('更新') && staleTitles.includes('更新到 0.5.1') && staleTitles.includes('更新到 0.3.16') && staleTitles.includes('更新到 0.2.0'))
check('【核心】行按钮不再代表那一轮时，把上轮结果贴回该行（3 行都有）', (staleText.match(/本轮 · (?:版本未变|未变化)/g) || []).length === 3, 'count=' + (staleText.match(/本轮 · (?:版本未变|未变化)/g) || []).length)
check('贴回的记录明确声明「它不是当前状态」', staleTitles.includes('它不是当前状态'))
check('一键更新按钮可用（锁已释放），且标注可更新数量 4',
  (() => { const b = buttonByText(stale.pluginTree, '一键更新'); return !!b && b.props.disabled !== true && textOf(b).includes('4') })())
check('最新列显示 ↑ 远端新版本，未变化只是「本轮结果」的记录', staleText.includes('↑ 0.5.1') && staleText.includes('↑ 0.3.16'))
check('降级保护：已装 1.1.0 / 远端 0.5.0 不标为可更新', staleText.includes('1.1.0') && staleText.includes('0.5.0'))
check('行内只留严重度徽章，事实标题进悬停与 title', /低/.test(staleText) && staleTitles.includes('与另一个插件共享非平台模块'))
check('渲染文本里没有 undefined', !/\bundefined\b/.test(staleText), staleText.slice(0, 160))
check('版本 chip 同时给出客户端与宿主版本', staleText.includes('v' + REV) && staleText.includes('宿主 v' + REV))

/* ── 用户三条「显示优化」的验收点（先红后绿）：一行一项 / 悬停展开 / 更新状态 ── */
/* ── 用户本轮要求：列表要直接展示「优化结果」（中文名 + 中文说明），本名要优化 ──
   注意：这是**有意**放宽上一轮的「严格一行」——中文名与一行中文说明各占一行，
   其余仍单行；密度靠字号与省略号控制。 */
check('【主功能】中文名优先展示，不再把「包名（中文）」整串塞进行内',
  staleText.includes('划词批注') && !staleText.includes('（划词批注） · '), staleText.slice(0, 160))
/* 页面自己要把「本插件干什么」说清楚（用户：功能与简介缺乏展示） */
check('【主功能】页面用一句话讲清价值，而不是只讲命名约定',
  staleText.includes('精炼成中文') && staleText.includes('Plugins 页'), staleText.slice(0, 200))
/* 本插件自己的那一行也必须显示中文名（客户端就是它自己，没必要等宿主提供） */
const ownRow = elementsOf(stale.pluginTree, (n) => n.tag === 'tr' && textOf(n).includes('dsh-audit-skills'))[0]
check('【主功能】本插件自己的行也显示中文名（不依赖宿主）',
  !!ownRow && textOf(ownRow).includes('插件与技能审查'), ownRow ? textOf(ownRow).slice(0, 160) : '未找到本插件行')
/* ── 旧宿主兜底：内置 catalog 中文快照（宿主 <2.9 的插件行不发 displayName/localizedDescription） ── */
const cj = JSON.parse(fs.readFileSync(path.join(REPO, 'references', 'dsh-plugin-locale-catalog.json'), 'utf8'))
const zhOf = (pkg) => { const e = cj.entries.find((x) => x.pkg === pkg); return e && e.zh ? e.zh : null }
const side = zhOf('dsh-better-sidebar')
const sideName = side ? /[（(]([^（()）]+)[)）]\s*$/.exec(side.title)[1] : ''
check('【主功能】旧宿主下用内置快照显示中文名（不必等重启）',
  sideName !== '' && staleText.includes(sideName), '期望中文名=' + sideName + ' | ' + staleText.slice(0, 160))
check('【主功能】旧宿主下连中文说明也显示，并标注来源是内置快照',
  !!side && staleText.includes(String(side.description).slice(0, 12)) && staleTitles.includes('来自客户端内置快照'),
  'desc前12=' + JSON.stringify(side && String(side.description).slice(0, 12)) + ' text命中=' + (!!side && staleText.includes(String(side.description).slice(0, 12))) +
  ' title命中=' + staleTitles.includes('来自客户端内置快照'))
check('【主功能】快照只覆盖内置 catalog：不在快照里的行仍如实说明（不编造）',
  !staleText.includes('dsh-sidebar-qa（'), staleText.slice(0, 160))
check('【主功能】原包名仍可见（退为次级），不因中文名而丢失',
  staleText.includes('@changfenhuang/dsh-annotation'))
check('【主功能】优化后的中文说明直接可见（不再是只在悬停里）',
  staleText.includes('选中助手回复中的文字即可批注'))
check('【主功能】密度靠字号与省略号：次级包名 11px、说明单行截断',
  /\.das-name-pkg \{[^}]*font-size: var\(--dsw-font-xxxs-11-font-size, 11px\)/.test(clientSrc) &&
  /\.das-desc-line \{[^}]*text-overflow: ellipsis/.test(clientSrc))
/* ── 审查：只统计事实级；推断级降噪（线上 14 条全是 inferred·low，其中 13 条是旧宿主
   看不到 app.asar 模块造成的假阳性） ── */
check('【审查】KPI 只报「需处置」的发现，低置信推断不占数字',
  staleText.includes('无需处置') || staleText.includes('需处置'), staleText.slice(0, 200))
check('【审查】推断级只在 title 里说明（可悬停，不喧宾夺主）',
  staleTitles.includes('推断'), staleTitles.slice(0, 160))
check('【主功能/密度】窄容器用容器查询收起次级包名（不再靠视口宽度猜）',
  clientSrc.includes('container-type: inline-size') && /@container \(max-width: 820px\) \{ \.das-name-pkg \{ display: none; \} \}/.test(clientSrc))

/* 悬停详情与行内密度（原「长文案不进表格行」已按用户新要求改写） */
check('【密度】长文案在行内单行截断，完整版仍在悬停里',
  staleTitles.includes('中文说明：给模型提供上下文面板'))
check('【密度】td 默认 nowrap —— 不再出现「更/新」这种竖排文字',
  /\.das-table td \{[^}]*white-space: nowrap/.test(clientSrc))
check('【密度】名称列单行截断（ellipsis），不靠换行堆叠',
  /\.das-table td \{[^}]*text-overflow: ellipsis/.test(clientSrc) && clientSrc.includes('table-layout: fixed') && clientSrc.includes('overflow-x: hidden'))
check('【更新状态】更新列给出显式状态 chip（已最新 / 不可比）',
  staleText.includes('已最新') && staleText.includes('不可比'))
/* 用户：悬停预览显示在页面下方、要滚动才看得到 —— 改成锚定在行旁的浮层（借鉴本机 dsh-annotation：
   position:fixed + getBoundingClientRect + 下方放不下就翻上方 + 双轴钳制视口） */
check('【悬停卡】用固定定位浮层，不再占用表格下方的布局槽位',
  /\.das-hover \{[^}]*position: fixed/.test(clientSrc) && !/\.das-hover \{[^}]*min-height: 52px/.test(clientSrc))
{
  backToPlugin(stale.loaded)   /* scenario() 结尾把 Merged 切到了技能视图，悬停卡要先切回插件视图 */
  const hoverRow = dataRows.find((tr) => textOf(tr).includes('dsh-context-doctor'))
  check('【悬停卡】找到可悬停的行', !!hoverRow && typeof hoverRow.props.onMouseEnter === 'function')
  /* 视口 1024x768（夹具 window 提供）；行在视口下方 → 必须翻到行的上方 */
  hoverRow.props.onMouseEnter({
    currentTarget: { getBoundingClientRect: () => ({ top: 700, bottom: 724, left: 40, right: 420, width: 380, height: 24 }) },
  })
  const card = elementsOf((await renderSettled(stale.loaded.rt, stale.element)).tree,
    (n) => n.props && n.props.className === 'das-hover')[0]
  const st = (card && card.props.style) || {}
  check('【悬停卡】下方放不下时翻到行的上方（top 在行上方）',
    !!card && typeof st.top === 'number' && st.top + 200 <= 700,
    'card=' + !!card + ' style=' + JSON.stringify(st))
  check('【悬停卡】水平与垂直都被钳制在视口内（不会跑出屏幕）',
    !!card && st.left >= 0 && st.left <= 1024 - 200 && st.top >= 0 && st.top <= 768,
    JSON.stringify(st))
  check('【悬停卡】给出最大高度，内容超高时卡片内部滚动而不是溢出视口',
    !!card && typeof st.maxHeight === 'number' && st.maxHeight > 100 && st.maxHeight <= 768, JSON.stringify(st))
  /* 行在视口顶部 → 放在行的下方 */
  hoverRow.props.onMouseEnter({
    currentTarget: { getBoundingClientRect: () => ({ top: 60, bottom: 84, left: 40, right: 420, width: 380, height: 24 }) },
  })
  const card2 = elementsOf((await renderSettled(stale.loaded.rt, stale.element)).tree,
    (n) => n.props && n.props.className === 'das-hover')[0]
  const st2 = (card2 && card2.props.style) || {}
  check('【悬停卡】上方空间不足/行在上方时放在行的下方', !!card2 && st2.top >= 84, JSON.stringify(st2))
}
/* 用户：切换按钮参考插件市场，位置上移，腾出显示位置 —— 头部只留一行：页签与标题同一行 */
check('【提示】未悬停时也说明「怎么看到完整信息」（提示不随槽位一起消失）',
  staleText.includes('把鼠标移到'), staleText.slice(0, 200))
{
  const heads = elementsOf(stale.pluginTree, (n) => n.props && n.props.className === 'das-head')
  const segs = elementsOf(stale.pluginTree, (n) => n.props && n.props.className === 'das-seg')
  check('【头部】只剩一行头部（页签与标题合并）', heads.length === 1, 'heads=' + heads.length)
  check('【头部】页签与标题在同一行里（标题上移、腾出内容高度）',
    heads.length === 1 && segs.length === 1 &&
    elementsOf(heads[0], (n) => n.tag === 'h3').length === 1 &&
    textOf(heads[0]).includes('插件') && textOf(heads[0]).includes('插件与技能审查'),
    heads.length ? textOf(heads[0]).slice(0, 160) : 'no head')
}
const ctxRow = elementsOf(stale.pluginTree, (n) => n.tag === 'tr' && textOf(n).includes('dsh-context') && !textOf(n).includes('doctor'))[0]
check('【悬停】行节点挂了 onMouseEnter', !!ctxRow && typeof ctxRow.props.onMouseEnter === 'function')
check('【操作列】按钮不再弹原生长提示，避免和行详情卡重叠', (() => {
  const actionRows = dataRows.filter((tr) => elementsOf(tr, (n) => n.tag === 'button').length > 0)
  const btns = actionRows.flatMap((tr) => elementsOf(tr, (n) => n.tag === 'button'))
  return btns.length > 0 && btns.every((b) => !Object.prototype.hasOwnProperty.call(b.props || {}, 'title')) &&
    btns.every((b) => typeof (b.props || {})['aria-label'] === 'string' && (b.props || {})['aria-label'] !== '')
})(), dataRows.map((tr) => textOf(tr).slice(-60)).join(' | '))
let hoverText = ''
if (ctxRow && typeof ctxRow.props.onMouseEnter === 'function') {
  backToPlugin(stale.loaded)   /* scenario() 结尾切到了技能视图，先切回来再悬停 */
  ctxRow.props.onMouseEnter()
  hoverText = textOf((await renderSettled(stale.loaded.rt, stale.element)).tree)
}
check('【悬停】悬停后槽位显示该行完整信息（长文案 + 已装/最新对照）',
  hoverText.includes('中文说明：给模型提供上下文面板') && hoverText.includes('0.56.2'),
  'hoverText=' + hoverText.slice(0, 240))
check('【留痕】悬停槽显示该行的上次翻译优化结果', hoverText.includes('上次翻译优化'), 'hoverText=' + hoverText.slice(0, 240))
/* ── 用户本轮要求：每行太高、可见对象太少 → 一行一项，行内不许再有块级堆叠 ──
   上一轮允许「中文名 + 中文说明各占一行」，状态列与版本列又各自换行，一行被撑成 2~4 行；
   现在硬契约：一个数据行里**一个块级 div 都不许有**，说明文字在同一行内省略号截断。 */
const rowDivs = dataRows.map((tr) => elementsOf(tr, (n) => n.tag === 'div').length)
check('【密度】行内没有任何块级 div：一行就是一行',
  dataRows.length >= PLUGIN_ROWS.filter((r) => r.bundled !== true).length && rowDivs.every((n) => n === 0),
  'divs/row=' + rowDivs.join(','))
check('【密度】4 个单元格各自只有一个 .das-cell（单行 flex 容器）',
  dataRows.length > 0 && dataRows.every((tr) => elementsOf(tr, (n) => n.props && String(n.props.className || '').indexOf('das-cell') >= 0).length === 4),
  dataRows.map((tr) => elementsOf(tr, (n) => n.props && String(n.props.className || '').indexOf('das-cell') >= 0).length).join(','))
/* ── 用户第二次追问「我明明点过翻译优化」→ 运行必须留痕 + 能自愈（先红后绿） ── */
check('【留痕】行内标出「上次翻译优化失败」，不再是无来历的待生成文案',
  staleText.includes('上次失败'), staleText.slice(0, 120))
check('【留痕】指标带出上次优化结果', staleText.includes('上次优化') || staleText.includes('上次失败'))
check('【自愈】检测到「有条目但不在盘上」的对象时自动补应用',
  stale.loaded.state.calls.indexOf('apply') >= 0 && stale.loaded.state.posted.some((b) => b.action === 'auto-apply'),
  'calls=' + stale.loaded.state.calls.join(',') + ' posted=' + stale.loaded.state.posted.map((b) => b.action).join(','))
check('【密度】行高固定 26px 且垂直居中（不再由内容堆叠决定行高）',
  /\.das-table td \{[^}]*height: 26px/.test(clientSrc) && /\.das-table td \{[^}]*vertical-align: middle/.test(clientSrc))
check('【密度】.das-cell 一律 nowrap，列宽由 table-layout: fixed 决定',
  /\.das-cell \{[^}]*flex-wrap: nowrap/.test(clientSrc) && clientSrc.includes('table-layout: fixed'))
check('【密度】操作列不再换行（td.das-act 不再是 flex-wrap: wrap）',
  /\.das-act \{[^}]*white-space: nowrap/.test(clientSrc) && !/\.das-act \{[^}]*flex-wrap: wrap/.test(clientSrc))
/* 「展开」原本自己占一格按钮，还要跟「更新」「优化文案」抢宽度 → 并进状态 chip：chip 自己就是展开入口 */
const chipButtons = dataRows.flatMap((tr) => elementsOf(tr, (n) => n.tag === 'button' && String((n.props || {}).className || '').indexOf('das-chip') >= 0))
check('【密度】「展开」不再单独占一个按钮：状态 chip 自己就是展开入口',
  dataRows.length > 0 && chipButtons.length > 0 &&
  dataRows.every((tr) => elementsOf(tr, (n) => n.tag === 'button' && textOf(n).indexOf('展开') === 0).length === 0),
  'chipButtons=' + chipButtons.length)
check('【密度】状态 chip 按钮带 aria-expanded / aria-label，且不弹原生 title',
  chipButtons.length > 0 && chipButtons.every((b) => typeof (b.props || {})['aria-expanded'] === 'boolean' &&
    typeof (b.props || {})['aria-label'] === 'string' && !Object.prototype.hasOwnProperty.call(b.props || {}, 'title')))
check('【密度】chip 文案有省略号保护（.das-chip-t），窄列也不撑破行',
  /\.das-chip-t \{[^}]*text-overflow: ellipsis/.test(clientSrc) && clientSrc.includes("'das-chip-t'"))
check('【密度】面板根不再让内容决定最小宽度（min-width: 0，防页面级横向滚动条）',
  /\.das-root\s*\{[^}]*min-width: 0/.test(clientSrc))
check('【列宽】四列都有明确宽度（合计 100%），表格有 max-width 上限',
  [1, 2, 3, 4].every((n) => new RegExp('\\.das-table td:nth-child\\(' + n + '\\) \\{ width: ').test(clientSrc)) &&
  /\.das-table \{[^}]*max-width: 100%/.test(clientSrc))
check('【密度】行内不再有「展开看建议」这类常驻提示（都进悬停卡）',
  !clientSrc.includes('das-row-hint'))

/* ── 用户：《翻译优化…为什么没有顺利生效、失败原因》──
   实测那一次：模型生成阶段失败，但落盘记录里只剩应用阶段的「已安装但缺少精炼文案」——
   原因是按包名合并结果时 apply 结果覆盖了生成结果，**真实失败原因就此消失**。
   现在两个阶段各自留痕，且页脚要说明还剩几个包缺文案、再点一次只重试它们。 */
{
  backToPlugin(stale.loaded)
  mockGenerate = { ok: false, code: 'bad-output', message: '模型返回无法解析为约定 JSON（已自动重试 1 次）', reason: '模型输出缺少 en/zh.title/description，或不是合法 JSON' }
  mockApplyValue = [{ pkg: '@wxg-prc-cpg/browser-skill-dsh-plugin', state: 'needs-catalog', message: '已安装但缺少精炼文案' }]
  const optimized = await clickAndSettle(stale.loaded.rt, stale.element, stale.pluginTree, '翻译优化')
  const trPost = stale.loaded.state.posted.filter((b) => b.url === 'translate-run' && Array.isArray(b.items)).pop()
  const trItems = (trPost && trPost.items) || []
  check('【翻译】生成失败的真实原因留在记录里（不被应用阶段的 needs-catalog 覆盖）',
    trItems.some((x) => x.pkg === '@wxg-prc-cpg/browser-skill-dsh-plugin' && x.state === 'failed' && x.code === 'bad-output' && /无法解析|合法 JSON/.test(String(x.message))),
    JSON.stringify(trItems))
  check('【翻译】一个包的两阶段都留痕（生成失败 + 待补文案），不再二选一',
    trItems.filter((x) => x.pkg === '@wxg-prc-cpg/browser-skill-dsh-plugin').length === 2 &&
    trItems.some((x) => x.state === 'needs-catalog'), JSON.stringify(trItems))
  const trMessage = String((trPost && trPost.message) || '')
  check('【翻译】汇总文案与条目状态自洽（失败数 = 条目里 failed 的条数）',
    trItems.filter((x) => x.state === 'failed').length === 1 && /失败 1 个/.test(trMessage) && /待补文案 1 个|应用 0 项/.test(trMessage),
    'message=' + trMessage + ' items=' + JSON.stringify(trItems))
  check('【翻译】页脚说明还剩几个缺文案、再点一次只会重试它们',
    textOf(optimized.tree).indexOf('再点一次') >= 0,
    'calls=' + stale.loaded.state.calls.slice(-10).join(',') + ' | posted=' + stale.loaded.state.posted.map((b) => b.action).join(','))
  mockGenerate = null
  mockApplyValue = null
}

/* 模拟用户点「详情」：Panel 的 openPkg 是它的第 4 个 hook。
   这一步同时验证 FindingCard / IssueCard —— 此前它们从未被渲染过。
   先把视图切回插件（Panel#plugin 实例会被复用，不重新挂载、不重复请求）。 */
stale.loaded.rt.api.__instances.get('Merged').hooks[0].v = 'plugin'
const panel = stale.loaded.rt.api.__instances.get('Panel#plugin')
panel.hooks[4].v = 'dsh-audit-skills'
const detailed = await renderSettled(stale.loaded.rt, stale.element)
const detailText = textOf(detailed.tree)
check('详情渲染无异常', detailed.errors.length === 0, detailed.errors.map((e) => e.message).join(' | '))
check('行内详情给出问题的原因与解决办法', detailText.includes('npm registry 上没有这个包') && detailText.includes('GitHub 直装，跳过 npm 比对'))
check('行内详情给出「忽略」入口', detailText.includes('忽略'))
check('推断级发现保留文字标识且不折叠进卡片', detailText.includes('推断') && !detailText.includes('仅供知悉'))
check('事实级发现连同证据与建议一并给出', detailText.includes('证据：两者都 inject third-party-shared') && detailText.includes('建议：若两者版本不兼容会一起坏'))

// ───────────────────────── 2 插件视图：刚完成的新记录 ─────────────────────────
console.log('\n2 插件视图 · 批量记录在保鲜期内（应锁定下表）')
const fresh = await scenario(60 * 1000)
const freshText = textOf(fresh.pluginTree)
check('渲染无异常', fresh.errors.length === 0, fresh.errors.map((e) => e.message).join(' | '))
check('状态提示显示行锁数量', freshText.includes('已锁定 3 行'))
check('锁定行数与结果数量一致（3 行，而不是记录条数）', freshText.includes('本轮处理 3 项') && freshText.includes('已锁定 3 行'))
check('被锁的三行按钮按结果暗下去，显示「未变化」', (freshText.match(/版本未变/g) || []).length >= 3)
check('一键更新按钮被禁用（与行锁一致，不再自相矛盾）', (() => { const b = buttonByText(fresh.pluginTree, '一键更新'); return !!b && b.props.disabled === true })())
check('锁有效时不必再贴记录（这 3 行的按钮本身已显示「未变化」）', !freshText.includes('本轮 · 未变化'))
check('不在该批次里的可更新行不受锁影响（第 4 行仍有「更新」入口）',
  titlesOf(fresh.pluginTree).includes('更新到 0.2.0') === true && titlesOf(fresh.pluginTree).includes('更新到 0.5.1') === false)

/* 对抗复查抓到的真缺陷：refresh() 清了行锁但留着批量记录，旧 lockNote 便把它当成「超期」，
   输出「这是 1 分钟前的记录，已超出 10 分钟的锁定保鲜期」。这里**真的点一次「刷新状态」**。 */
backToPlugin(fresh.loaded)
const refreshed = await clickAndSettle(fresh.loaded.rt, fresh.element, fresh.pluginTree, '刷新状态')
const refreshedText = textOf(refreshed.tree)
check('点「刷新状态」后渲染无异常', refreshed.errors.length === 0, refreshed.errors.map((e) => e.message).join(' | '))
check('刷新后如实报告释放了几个行锁（这段新文案必须被真的跑到）', refreshedText.includes('已释放上一轮的 3 个行锁'), refreshedText.slice(0, 160))
check('【核心】刷新释放 ≠ 超期：不得再出现「N 分钟前…已超出 10 分钟」的自相矛盾',
  refreshedText.includes('已释放上一轮的 3 个行锁') && refreshedText.includes('按最新快照') && !refreshedText.includes('已超出 10 分钟的锁定保鲜期'))
check('刷新后行按钮恢复可用（重新判定）', titlesOf(refreshed.tree).includes('更新到 0.5.1'))

// ───────────────────────── 3 插件视图：中断的批量（没有 finishedAt） ─────────────────────────
console.log('\n3 插件视图 · 批量被中断（running=false 且没有 finishedAt）')
const broken = await scenario(0, true)
const brokenText = textOf(broken.pluginTree)
check('渲染无异常', broken.errors.length === 0, broken.errors.map((e) => e.message).join(' | '))
check('中断的批量不得被说成「已完成」', brokenText.includes('已中断（未完成）') && !brokenText.includes('批量更新 · 已完成'))
check('并说明只有中断前完成的部分有结果、且不锁定下表', brokenText.includes('未跑完') && brokenText.includes('只有中断前完成'))
check('中断不锁行 → 可更新的行仍可点', titlesOf(broken.pluginTree).includes('更新到 0.5.1'))
check('中断不置位锁标记（一键更新仍可用）', (() => { const b = buttonByText(broken.pluginTree, '一键更新'); return !!b && b.props.disabled !== true })())

/* 对抗复查抓到的第二个真缺陷：中断的批量之后再点一次单行更新，chip 说「已中断」、
   lockNote 却说「（刚刚完成）」。现在行锁时间取自锁自己，两边不再打架。 */
backToPlugin(broken.loaded)
const brokenUpdated = await clickAndSettle(broken.loaded.rt, broken.element, broken.pluginTree, '更新', true)
const brokenAfter = textOf(brokenUpdated.tree)
check('中断 + 单行更新：渲染无异常', brokenUpdated.errors.length === 0, brokenUpdated.errors.map((e) => e.message).join(' | '))
check('【核心】不得出现「已中断」与「刚刚完成」同屏打架',
  brokenAfter.includes('已中断（未完成）') && !brokenAfter.includes('刚刚完成'))
check('行锁时间取自锁本身（单行更新后按结果暗下去）', brokenAfter.includes('已锁定 1 行'))
check('单行更新失败如实报因并给下一步动作', brokenAfter.includes('HTTP 404') && brokenAfter.includes('重启 DSH'))

// ───────────────────────── 5 版本不一致：提示必须短，长解释进 title ─────────────────────────
console.log('\n5 版本不一致（宿主落后于客户端）')
const mismatch = await scenario(60 * 1000, false, '2.8.0')
const mmText = textOf(mismatch.pluginTree)
const mmTitles = titlesOf(mismatch.pluginTree)
check('渲染无异常', mismatch.errors.length === 0, mismatch.errors.map((e) => e.message).join(' | '))
check('不一致仍被如实指出，并给出下一步', mmText.includes('落后于客户端') && mmText.includes('重启 DSH'), 'mmText=' + mmText.slice(0, 200))
/* 宿主太旧时，必须说出「为什么看不到中文名/说明」——实测 2.8.0 宿主对插件行不发 displayName */
check('【主功能】宿主太旧时明确告知：重启后才能看到插件的中文名与说明',
  mmText.includes('重启 DSH 后才能看到插件的中文名'), mmText.slice(0, 220))
check('【密度】长解释不再占版面（只在 title 里可悬停读到）',
  !mmText.includes('因此可能缺少本页需要的接口') && !mmText.includes('宿主半体是旧的') &&
  mmTitles.includes('因此可能缺少本页需要的接口') && mmTitles.includes('请重启 DSH。'), 'titles=' + mmTitles.slice(0, 120))
check('技能页同样渲染成一条紧凑数据带',
  elementsOf(stale.skillTree, (n) => n.props && String(n.props.className || '').indexOf('das-stats') >= 0).length === 1)
/* 旧宿主（对插件行不发 displayName）下：不在内置快照里的行必须解释清楚为什么没有中文 */
backToPlugin(mismatch.loaded)
const noNameRow = elementsOf(mismatch.pluginTree, (n) => n.tag === 'tr' && textOf(n).includes('dsh-sidebar-qa'))[0]
check('【主功能】本地化但没有中文名的行可悬停（用于说明原因）',
  !!noNameRow && typeof noNameRow.props.onMouseEnter === 'function')
if (noNameRow && typeof noNameRow.props.onMouseEnter === 'function') noNameRow.props.onMouseEnter()
const noNameText = textOf((await renderSettled(mismatch.loaded.rt, mismatch.element)).tree)
check('【主功能】槽位写出「宿主未提供中文名，重启后可见」', noNameText.includes('未提供中文名'), noNameText.slice(0, 240))

// ───────────────────────── 6 技能视图 ─────────────────────────
console.log('\n4 技能视图 · 版本/修订回落链与来源压缩')
const skillText = textOf(stale.skillTree)
check('切换视图后无异常（key={mode} 真重挂载并拉 /skills）', stale.loaded.state.calls.includes('skills'), stale.loaded.state.calls.join(','))
check('10 个技能全部成行', SKILL_ROWS.every((r) => skillText.includes(r.pkg)), '缺：' + SKILL_ROWS.filter((r) => !skillText.includes(r.pkg)).map((r) => r.pkg).join(','))
check('视图切换不串数据：技能表里没有插件名', !skillText.includes('dsh-free-search') && !skillText.includes('@furongjun1999/dsh-memory'))
check('【核心】未声明 version 的技能回落到 git 提交号', skillText.includes('git b1c7007') && skillText.includes('git 36acead2'))
check('未声明且非 git 的技能显示「未声明」而不是「—」', skillText.includes('未声明'))
check('声明了 version 的技能显示 vX.Y.Z', skillText.includes('v1.6.0') && skillText.includes('v0.2.0'))
check('技能来源显示 GitHub 原作者仓库，不刷本地 Windows 路径', skillText.includes('GitHub 原作者仓库') && !skillText.includes('C:\\Users'))
check('如实标出本地改动文件数', skillText.includes('本地改动 3 个文件') && skillText.includes('本地改动 2 个文件'))
check('技能页 KPI 含本地目录 / 本地改动 / 描述为英文', skillText.includes('本地目录') && skillText.includes('本地改动') && skillText.includes('描述为英文'))
check('技能页版本列表头合并为「版本与来源」', skillText.includes('版本与来源'))
check('【主功能】技能侧中文名同样优先展示（不再整串「包名（中文）」）',
  skillText.includes('学习一个视频') && !skillText.includes('（学习一个视频） · '), skillText.slice(0, 160))
check('技能页说明写入边界但不铺陈长段落', skillText.includes('翻译会写入 SKILL.md 并保留备份') && !skillText.includes('技能改写会真实写入 SKILL.md'))
check('技能视图不出现插件批量记录（两页各自渲染自己的更新结果）', !skillText.includes('安装已执行，但版本未变'))
check('技能视图文本里没有 undefined', !/\bundefined\b/.test(skillText), skillText.slice(0, 160))

// ───────────────────────── 6 失败隔离（Boundary 故障注入） ─────────────────────────
console.log('\n6 失败隔离 · 渲染期异常必须只让自己那一块失效')
const fault = loadClient(fetchImpl)
const faultSection = fault.registered.find((r) => r.desc.name === 'settings.section')
const faultElement = faultSection.component({})
/* 第 2 次 useState 属于 Panel（第 1 次是 Merged 的 mode）—— 让 Panel 渲染期抛错，
   验证 Boundary 真的兜住（此前这条错误路径从未被执行过）。 */
fault.rt.api.__inject.stateCalls = 0
fault.rt.api.__inject.throwOnStateCall = 2
const faulted = await renderSettled(fault.rt, faultElement)
const faultText = textOf(faulted.tree)
check('Panel 渲染期抛错时不外抛（页面其余部分仍可渲染）', fault.rt.errors.length === 0, fault.rt.errors.map((e) => e.message).join(' | '))
check('Boundary 输出隔离说明而不是白屏', faultText.includes('dsh-audit-skills 渲染失败，已隔离'), faultText.slice(0, 160))
check('隔离说明带上原始异常信息（可诊断）', faultText.includes('注入的渲染期异常'))

// ───────────────────────── 6b 读取失败：注入类错误必须给可执行提示 ─────────────────────────
console.log('\n6b 读取失败 · 宿主注入失败不能只把英文原文甩给用户')
mockSnapshotFailure = { ok: false, code: 'host-inject', message: 'cannot get property "includeExternalSkills" without inject' }
const injLoaded = loadClient(fetchImpl)
const injSection = injLoaded.registered.find((r) => r.desc.name === 'settings.section')
const injText = textOf((await renderSettled(injLoaded.rt, injSection.component({}))).tree)
mockSnapshotFailure = null
check('注入失败：原始原因保留（可诊断）', injText.includes('cannot get property "includeExternalSkills" without inject'), injText.slice(0, 240))
check('注入失败：不被挂载期的批量历史提示顶掉', injText.includes('读取失败：') && !/^\s*上次批量执行/.test(injText), injText.slice(0, 240))
check('注入失败：表格区不再假装仍在加载', injText.includes('状态未读取成功，原因见上方提示。'), injText.slice(0, 240))
check('注入失败：给出可执行下一步（重启 DSH）', injText.includes('请重启 DSH。'), injText.slice(0, 240))
check('注入失败：点明是两端版本/未重启而非数据问题', injText.includes('宿主半体版本过旧或未重启'), injText.slice(0, 240))
mockSnapshotFailure = { ok: false, message: 'boom' }
const plainFail = loadClient(fetchImpl)
const plainFailSection = plainFail.registered.find((r) => r.desc.name === 'settings.section')
const plainFailText = textOf((await renderSettled(plainFail.rt, plainFailSection.component({}))).tree)
mockSnapshotFailure = null
check('无失败码时仍原样透出宿主原因', plainFailText.includes('读取失败：boom'), plainFailText.slice(0, 240))
/* 关键：**运行中的旧宿主**没有 H3 的 code，只有那句英文。靠报文兜底识别，用户刷新页面就能拿到重启指引。 */
mockSnapshotFailure = { ok: false, message: 'cannot get property "legacyField" without inject' }
const legacyFail = loadClient(fetchImpl)
const legacyFailSection = legacyFail.registered.find((r) => r.desc.name === 'settings.section')
const legacyFailText = textOf((await renderSettled(legacyFail.rt, legacyFailSection.component({}))).tree)
mockSnapshotFailure = null
check('旧宿主（无 code）也能按报文识别并给出重启指引', legacyFailText.includes('legacyField') && legacyFailText.includes('请重启 DSH。'), legacyFailText.slice(0, 300))

// ───────────────────────── 7 行内卡片（plugins.row.config） ─────────────────────────
console.log('\n7 插件行内卡片')
const inline = loadClient(fetchImpl)
const rowConfig = inline.registered.find((r) => r.desc.name === 'plugins.row.config')
const summary = rowConfig.component({ view: 'summary' })
check('summary 视图返回一句话说明', typeof summary === 'string' && summary.includes('翻译优化'))
const inlineTree = (await renderSettled(inline.rt, rowConfig.component({ view: 'full' }))).tree
check('full 视图渲染出完整面板', textOf(inlineTree).includes('dsh-free-search') && textOf(inlineTree).includes('精炼成中文'))
check('full 视图无异常且无 undefined', inline.rt.errors.length === 0 && !/\bundefined\b/.test(textOf(inlineTree)))

/* ───────────── 7 可选：--live 用**真实线上快照**渲染**真客户端**（没有浏览器时最硬的端到端证据） ─────────────
   合成夹具只能证明「给定输入会这样渲染」；这一块把 DSH 真实进程返回的 /updates 灌进同一个真客户端，
   再断言渲染文本。桥接不上就 SKIP（四道闸门不依赖活的 DSH，此时仍用 node scripts/render-smoke.mjs --live 手动跑）。 */
if (process.argv.includes('--live')) {
  console.log('\n7 LIVE · 真实线上快照 → 真客户端 → 真渲染')
  let live = null
  try {
    const r = await fetch('http://127.0.0.1:19387/api/dsh-audit-skills/updates', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    live = await r.json()
  } catch (error) {
    console.log('  SKIP  桥接不可达：' + (error && error.message))
  }
  if (live && Array.isArray(live.value)) {
    console.log('  线上快照 rev=' + live.rev + '，共 ' + live.value.length + ' 行')
    /* 把合成夹具换成线上行（PLUGIN_ROWS 是被 fetchImpl 闭包捕获的同一个数组，原地替换即可） */
    PLUGIN_ROWS.length = 0
    for (const row of live.value) PLUGIN_ROWS.push(Object.assign(pluginRow({ pkg: row.pkg }), row))
    const liveLoaded = loadClient(fetchImpl)
    const liveSection = liveLoaded.registered.find((x) => x.desc.name === 'settings.section')
    const liveTree = (await renderSettled(liveLoaded.rt, liveSection.component({}))).tree
    const liveText = textOf(liveTree)
    const rows = elementsOf(liveTree, (n) => n.tag === 'tr' && elementsOf(n, (m) => m.tag === 'td').length > 1)
    const listed = live.value.filter((r) => r.bundled !== true)
    const hidden = live.value.length - listed.length
    check('【LIVE】真客户端渲染线上快照无异常（含隐藏 ' + hidden + ' 个随 DSH 提供的对象）',
      rows.length === listed.length, 'rows=' + rows.length + ' expected=' + listed.length + '（总 ' + live.value.length + '）')
    check('【LIVE】渲染文本里没有 undefined', !/\bundefined\b/.test(liveText))
    /* 这条契约的对象是「行」，不是整页：整页文本里合法地会出现「（…） · 」（例如状态提示里的
       时间说明），按整页判会假红。逐行判才是用户看到的那个形态。 */
    const dupShape = rows.map((tr) => textOf(tr)).filter((t) => /（[^）]{1,20}） · /.test(t))
    check('【LIVE】行内不再出现「包名（中文） · 包名」的整串重复形态',
      dupShape.length === 0, dupShape.slice(0, 2).join(' || '))
    /* 逐行：只要这份内置 catalog 覆盖它、且中文确实已落盘，渲染文本里就必须出现它的中文名 */
    let covered = 0
    const missed = []
    for (const row of live.value) {
      if (row.bundled === true) continue
      const zh = zhOf(row.pkg)
      if (!zh) continue
      const zhName = /[（(]([^（()）]+)[)）]\s*$/.exec(zh.title)
      const name = zhName ? zhName[1] : zh.title
      if (row.localized !== true) continue
      covered += 1
      const tr = rows.find((el) => textOf(el).includes(row.pkg))
      if (!tr || !textOf(tr).includes(name)) missed.push(row.pkg + '→' + name)
      check('【LIVE】' + row.pkg + ' 行内显示中文名「' + name + '」及中文说明',
        !!tr && textOf(tr).includes(name) && textOf(tr).includes(String(zh.description).slice(0, 10)),
        tr ? textOf(tr).slice(0, 160) : '未找到该行')
    }
    console.log('  覆盖：' + covered + '/' + live.value.length + ' 行' + (missed.length ? '，缺失：' + missed.join('、') : ''))
    const ownLive = rows.find((el) => textOf(el).includes('dsh-audit-skills'))
    check('【LIVE】本插件自己那行也显示中文名', !!ownLive && textOf(ownLive).includes('插件与技能审查'))
  }
}

console.log('\nRENDER SMOKE  pass=' + pass + '  fail=' + fail)
process.exitCode = fail === 0 ? 0 : 1
