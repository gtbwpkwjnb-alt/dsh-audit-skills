#!/usr/bin/env node
/**
 * regression.mjs — dsh-audit-skills 回归测试（可复跑）
 *
 * 覆盖此前从未验证的部分：
 *   A 沙箱 profile 上的 applyLocale / revertLocale 端到端 + 幂等性 + exports 迁移
 *   B bridge 路由的真实 HTTP 调用（起一个真 http server 打到 handler 上）
 *   C 真实 profile 的只读检查 + npm 版本查询 + 服务缺失时的降级
 *
 * 全程不修改真实 profile：所有写操作只发生在临时沙箱目录。
 * 用法：node scripts/regression.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')))
const PROFILE = 'C:/Users/Administrator/.dsh/profiles/desktop'
let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')) }
}

// 让 index.js 能解析 @deepseek-ai/schemastery（复用 profile 里的副本）
function ensureScheme() {
  const target = path.join(REPO, 'node_modules', '@deepseek-ai', 'schemastery')
  const source = path.join(PROFILE, 'node_modules', '@deepseek-ai', 'schemastery')
  if (fs.existsSync(target)) return false
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.symlinkSync(source, target, 'junction')
  return true
}
const created = ensureScheme()
let cleanupLink = created
try {

const m = await import('../index.js')

// ─────────────────────── A 沙箱 profile ───────────────────────
console.log(String.fromCharCode(10) + 'A 沙箱 profile：apply / revert / 幂等 / exports 迁移')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-reg-'))
const nm = path.join(sandbox, 'node_modules')
fs.mkdirSync(path.join(nm, 'pkg-with-exports'), { recursive: true })
fs.mkdirSync(path.join(nm, 'pkg-no-exports'), { recursive: true })
const bundle = { patch: './cordis.patch.yml' }
const legacy = { name: 'pkg-with-exports', version: '1.0.0', exports: { '.': './index.js', './locale/*': './locale/*' }, dsh: { bundle } }
const plain = { name: 'pkg-no-exports', version: '2.0.0', dsh: { bundle } }
fs.writeFileSync(path.join(nm, 'pkg-with-exports', 'package.json'), JSON.stringify(legacy, null, 2))
fs.writeFileSync(path.join(nm, 'pkg-no-exports', 'package.json'), JSON.stringify(plain, null, 2))
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'sandbox', dependencies: { 'pkg-with-exports': '*', 'pkg-no-exports': '*' }, dsh: { profile: { bundles: ['pkg-with-exports', 'pkg-no-exports'] } } }, null, 2))
const entries = [
  { pkg: 'pkg-with-exports', en: { title: 'pkg-with-exports', description: 'EN A' }, zh: { title: 'pkg-with-exports（甲）', description: '中文甲' } },
  { pkg: 'pkg-no-exports', en: { title: 'pkg-no-exports', description: 'EN B' }, zh: { title: 'pkg-no-exports（乙）', description: '中文乙' } },
]
const r1 = m.applyLocale([sandbox], { entries })
check('applyLocale 两个包均为 applied', r1.filter((r) => r.state === 'applied').length === 2, JSON.stringify(r1))
check('遗留 ./locale/* 被迁移为 ./locale/*.json', r1.some((r) => r.exportNote === 'migrated-legacy-locale-export'))
const manA = JSON.parse(fs.readFileSync(path.join(nm, 'pkg-with-exports', 'package.json'), 'utf8'))
check('exports 已含 ./locale/*.json', Object.hasOwn(manA.exports, './locale/*.json'))
check('遗留键 ./locale/* 已删除', !Object.hasOwn(manA.exports, './locale/*'))
const req = createRequire(nm + '/')
let resolveA = 'FAIL', resolveB = 'FAIL'
try { req.resolve('pkg-with-exports/locale/en.json'); resolveA = 'OK' } catch (e) { resolveA = e.code }
try { req.resolve('pkg-no-exports/locale/en.json'); resolveB = 'OK' } catch (e) { resolveB = e.code }
check('有 exports 的包 locale 可解析', resolveA === 'OK', resolveA)
check('无 exports 的包 locale 可解析（纯路径）', resolveB === 'OK', resolveB)
const statA = fs.statSync(path.join(nm, 'pkg-with-exports', 'locale', 'zh.json')).mtimeMs
m.applyLocale([sandbox], { entries })
check('幂等：第二次 applyLocale 不改动文件', fs.statSync(path.join(nm, 'pkg-with-exports', 'locale', 'zh.json')).mtimeMs === statA)
const r2 = m.revertLocale([sandbox], { entries })
check('revertLocale 全部报告 restored', r2.every((r) => r.state === 'restored'), JSON.stringify(r2))
check('revert 删除了新建的 locale 目录（原本不存在）', !fs.existsSync(path.join(nm, 'pkg-no-exports', 'locale')), 'still exists')
const manAfter = JSON.parse(fs.readFileSync(path.join(nm, 'pkg-with-exports', 'package.json'), 'utf8'))
check('revert 后 exports 回到旧形态', Object.hasOwn(manAfter.exports, './locale/*') && !Object.hasOwn(manAfter.exports, './locale/*.json'))

// ─────────────────────── B bridge 真实 HTTP ───────────────────────
console.log(String.fromCharCode(10) + 'B bridge：真实 HTTP 打到 route handler')
const routes = []
const services = { webServer: { register: (route) => { routes.push(route); return () => {} } } }
const fakeCtx = {
  logger: { info() {}, warn() {} },
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
  get: (n) => services[n],
  inject(names, cb) { if (names.every((n) => services[n] !== undefined)) cb({ get: fakeCtx.get, effect: fakeCtx.effect, webServer: services.webServer }) },
}
m.apply(fakeCtx, { autoApply: false, revertOnDisable: false, profileDir: sandbox })
check('注册了 5 条 bridge 路由', routes.length === 5, 'got ' + routes.length + ': ' + routes.map((r) => r.path).join(','))
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  const route = routes.find((r) => r.path === url.pathname)
  if (!route) { response.writeHead(404); response.end('{}'); return }
  route.handler(request, response)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port + '/api/dsh-audit-skills'
const post = async (action, body) => {
  const res = await fetch(base + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  return res.json()
}
const st = await post('status')
check('POST /status 返回 ok 与数组', st.ok === true && Array.isArray(st.value), JSON.stringify(st).slice(0, 120))
check('POST /status 命中沙箱的两个包', st.value.length === 2, JSON.stringify(st.value.map((r) => r.pkg)))
const up = await post('updates')
check('POST /updates 返回 ok 与数组', up.ok === true && Array.isArray(up.value))
check('POST /updates 对不存在的包给出 unavailable 而非崩溃', up.value.every((r) => r.latest === null && r.reason !== null), JSON.stringify(up.value.map((r) => r.reason)))
const badUpd = await post('update', {})
check('POST /update 缺 pkg 时拒绝', badUpd.ok === false && String(badUpd.message).includes('pkg'))
const noMgr = await post('update', { pkg: 'pkg-no-exports' })
check('POST /update 无 pluginManager 时优雅降级', noMgr.ok === false && noMgr.code === 'manager-unavailable', JSON.stringify(noMgr))
const rv = await post('revert')
check('POST /revert 返回 ok', rv.ok === true)
await new Promise((resolve) => server.close(resolve))

// ─────────────────────── A2 边界用例 ───────────────────────
console.log(String.fromCharCode(10) + 'A2 边界用例')
const missing = m.applyLocale([path.join(sandbox, 'nope')], { entries })
check('applyLocale 对不存在的包返回 skipped-not-installed', missing.every((r) => r.state === 'skipped-not-installed'))
// 损坏的 package.json：必须返回 failed 而不是抛错
fs.mkdirSync(path.join(nm, 'pkg-broken'), { recursive: true })
fs.writeFileSync(path.join(nm, 'pkg-broken', 'package.json'), '{ this is not json')
const broken = m.applyLocale([sandbox], { entries: [{ pkg: 'pkg-broken', en: { title: 'x', description: 'y' }, zh: { title: 'x', description: 'y' } }] })
const brokenRow = broken.find((r) => r.pkg === 'pkg-broken')
check('package.json 损坏时返回 failed 且不抛错', !!brokenRow && brokenRow.state === 'failed', JSON.stringify(brokenRow))
// 恢复后，别人写在 locale/ 里的文件不能被我们删掉
fs.mkdirSync(path.join(nm, 'pkg-with-exports', 'locale'), { recursive: true })
fs.writeFileSync(path.join(nm, 'pkg-with-exports', 'locale', 'ja.json'), '{"meta":{"title":"他人所有"}}')
m.applyLocale([sandbox], { entries })
m.revertLocale([sandbox], { entries })
check('revert 不删除第三方语言文件 ja.json', fs.existsSync(path.join(nm, 'pkg-with-exports', 'locale', 'ja.json')))
// 内容被用户改过的 locale 文件，revert 也不应删除
const zhPath = path.join(nm, 'pkg-with-exports', 'locale', 'zh.json')
fs.writeFileSync(zhPath, JSON.stringify({ meta: { title: '用户手改', description: 'x' } }, null, 2) + String.fromCharCode(10))
m.revertLocale([sandbox], { entries })
check('revert 不删除被用户改过内容的 locale 文件', fs.existsSync(zhPath))
const latestScoped = await m.fetchLatestVersion('@furongjun1999/dsh-memory')
check('作用域包名可正确查询（URL 编码 /）', latestScoped.status === 'ok', JSON.stringify(latestScoped))

// ─────────────────────── C 真实 profile 只读 ───────────────────────
console.log(String.fromCharCode(10) + 'C 真实 profile：只读检查（不写入）')
const real = m.collectStatus([PROFILE])
check('collectStatus 在真实 profile 上有结果', real.length > 0, 'rows=' + real.length)
check('collectStatus 不含未安装项', real.every((r) => r.installed === true))
check('collectStatus 每项都有 pkg', real.every((r) => typeof r.pkg === 'string' && r.pkg.length > 0))
const cat = m.readCatalog()
check('catalog 可读且非空', Array.isArray(cat) && cat.length > 0, 'entries=' + cat.length)
const latestOk = await m.fetchLatestVersion('dsh-free-search')
check('npm 版本查询可用（dsh-free-search）', latestOk.status === 'ok' && typeof latestOk.latest === 'string', JSON.stringify(latestOk))
const latestGit = await m.fetchLatestVersion('dsh-audit-skills')
check('npm 上不存在的包返回 unavailable（不猜）', latestGit.status === 'unavailable', JSON.stringify(latestGit))
const noSvc = m.collectStatusViaService({ get: () => undefined }, [PROFILE])
check('无 pluginManager 时 collectStatusViaService 返回 undefined', noSvc === undefined)

// ─────────────────────── 收尾 ───────────────────────
fs.rmSync(sandbox, { recursive: true, force: true })
console.log(String.fromCharCode(10) + 'RESULT  pass=' + pass + '  fail=' + fail)
process.exitCode = fail === 0 ? 0 : 1

} finally {
  if (cleanupLink) fs.rmSync(path.join(REPO, 'node_modules'), { recursive: true, force: true })
}