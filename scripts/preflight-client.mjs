#!/usr/bin/env node
/**
 * preflight-client.mjs — 客户端半体发布前闸门（v1.2.1 事故后新增，必须常驻）
 *
 * 事故根因：DSH 以传统 <script> 加载 client.js，裸 ESM 会抛
 *   Uncaught SyntaxError: Cannot use import statement outside a module
 * 且这是【致命】的 —— web boot 失败，整个 GUI 起不来。
 *
 * 本脚本以传统脚本方式在 vm 中执行 client.js，任何顶层 import/export 都会当场抛错。
 * 用法：node scripts/preflight-client.mjs [client.js 路径]
 */
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const file = process.argv[2] ?? path.join(root, 'client.js')
const code = fs.readFileSync(file, 'utf8')
const fail = (msg) => { console.error('FAIL ' + msg); process.exit(1) }

const loaded = []
const sandbox = { console, window: { __ModuleLoader__: { load: (spec) => loaded.push(spec) } } }
const ctx = vm.createContext(sandbox)

try {
  vm.runInContext(code, ctx, { filename: 'client.js' })
} catch (error) {
  fail('以传统脚本解析失败（顶层 import/export？）：' + error.message)
}
console.log('PASS 传统脚本解析（无顶层 import）')

if (loaded.length !== 1) fail('window.__ModuleLoader__.load 调用次数 = ' + loaded.length + '，应为 1')
if (!loaded[0].id) fail('load() 缺少 id')
console.log('PASS load() id=' + loaded[0].id)

const stubReact = {
  createElement: () => ({}),
  Component: class { constructor(p) { this.props = p } },
  useCallback: (f) => f,
  useEffect: () => {},
  useState: (v) => [v, () => {}],
}
const requireStub = (name) => { if (name === 'react') return stubReact; throw new Error('未声明的 require: ' + name) }

let exported
try {
  exported = loaded[0].factory(requireStub)
} catch (error) {
  fail('factory 执行失败：' + error.message)
}
for (const key of ['name', 'inject', 'apply']) if (!(key in exported)) fail('exports 缺少 ' + key)
console.log('PASS exports = ' + Object.keys(exported).join(','))

const calls = []
const services = {
  get(name) { calls.push('get:' + name); return { registerTab: () => () => {} } },
}
const slots = {
  inject(name, cb) { calls.push('inject:' + name); try { cb() } catch (error) { calls.push('cbErr:' + name + ':' + error.message) } },
  register(desc) { calls.push('register:' + desc.name + (desc.key ? '#' + desc.key : desc.id ? '#' + desc.id : '')); return () => {} },
}
const fakeCtx = {
  slots,
  // 真实 ctx.inject 在服务就绪时调用回调 —— 这里同步调用，保证内层注册同样被验证
  inject(services_, cb) {
    calls.push('injectSvc:' + services_.join(','))
    if (typeof cb === 'function') cb(Object.assign({ slots }, services))
  },
}
try {
  exported.apply(fakeCtx)
} catch (error) {
  fail('apply() 抛错：' + error.message)
}
console.log('PASS apply() 未抛错')
for (const c of calls) console.log('     ' + c)
console.log('' + String.fromCharCode(10) + 'ALL PASS — 可发布')