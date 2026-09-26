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
check('注册了 7 条 bridge 路由', routes.length === 7, 'got ' + routes.length + ': ' + routes.map((r) => r.path).join(','))
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
check('端到端：每个 bridge 响应带 rev 且与本插件版本一致', typeof st.rev === 'string' && st.rev === m.OWN_REV, JSON.stringify({ rev: st.rev, own: m.OWN_REV }))
check('POST /status 命中沙箱的两个包', st.value.length === 2, JSON.stringify(st.value.map((r) => r.pkg)))
const up = await post('updates')
check('POST /updates 返回 ok 与数组', up.ok === true && Array.isArray(up.value))
check('POST /status 每行都带 issues 数组（端到端送达界面）', st.value.every((r) => Array.isArray(r.issues)), JSON.stringify(st.value.map((r) => typeof r.issues)))
check('POST /updates 每行都带 issues 数组', up.value.every((r) => Array.isArray(r.issues)))
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

// ─────────────────────── A3 覆盖层 / spec 解析 / 更新任务 ───────────────────────
console.log(String.fromCharCode(10) + 'A3 覆盖层 · spec 解析 · 更新任务 · 问题诊断')
check('outlayPath 指向 ~/.dsh/dsh-audit-skills/catalog.local.json', /dsh-audit-skills[\\/]catalog\.local\.json$/.test(m.overlayPath()), m.overlayPath())
const catAll = m.readCatalog()
const overlayPkgs = ['@changfenhuang/dsh-annotation', 'dsh-computer-use-win', 'dsh-side-chat-plus']
check('覆盖层条目已并入 catalog', overlayPkgs.every((p) => catAll.some((e) => e.pkg === p)), 'catalog=' + catAll.length)
check('覆盖层优先于内置（同一 pkg 取覆盖层）', (function () {
  const hit = catAll.filter((e) => e.pkg === 'dsh-side-chat-plus')
  return hit.length === 1 && /侧边聊天/.test(hit[0].zh.title)
})(), JSON.stringify(catAll.filter((e) => e.pkg === 'dsh-side-chat-plus').map((e) => e.zh.title)))
// spec 解析：三类依赖
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({
  name: 'sandbox',
  dependencies: { 'pkg-with-exports': '^1.0.0', 'pkg-git': 'github:owner/repo', 'pkg-local': 'file:../x' },
  dsh: { profile: { bundles: ['pkg-with-exports'] } },
}, null, 2))
const specReg = m.resolveUpdateSpec(sandbox, 'pkg-with-exports')
const specGit = m.resolveUpdateSpec(sandbox, 'pkg-git')
const specLoc = m.resolveUpdateSpec(sandbox, 'pkg-local')
const specUnk = m.resolveUpdateSpec(sandbox, 'not-a-dep')
check('registry 依赖 → pkg@latest', specReg.kind === 'registry' && specReg.spec === 'pkg-with-exports@latest', JSON.stringify(specReg))
check('git 依赖 → 原样回传 git spec（不加 @latest）', specGit.kind === 'git' && specGit.spec === 'github:owner/repo', JSON.stringify(specGit))
check('本地依赖 → 拒绝并说明', specLoc.spec === null && specLoc.kind === 'local', JSON.stringify(specLoc))
check('未知依赖 → 拒绝并说明', specUnk.spec === null, JSON.stringify(specUnk))
// 更新任务：有 pluginManager 时拿到 token 并可轮询到 done
const seenSpecs = []
const fakePM = {
  listBundles: () => [],
  installBundle: (spec) => { seenSpecs.push(spec); return Promise.resolve({ installed: true }) },
}
const ctxWithPM = { get: (n) => (n === 'pluginManager' ? fakePM : undefined) }
const started = m.startUpdate(ctxWithPM, sandbox, 'pkg-with-exports')
check('startUpdate 立即返回 token 与计划', started.ok === true && typeof started.token === 'string' && started.plan.kind === 'registry', JSON.stringify(started))
check('startUpdate 对 git 依赖用 git spec', m.startUpdate(ctxWithPM, sandbox, 'pkg-git').plan.spec === 'github:owner/repo')
await new Promise((r) => setTimeout(r, 80))
const jr = m.updateJobStatus(started.token)
check('轮询到 done 且 ok（不再是一次长请求）', jr.ok === true && jr.job.done === true && jr.job.ok === true, JSON.stringify(jr))
check('installBundle 收到的 spec 正确', seenSpecs.includes('pkg-with-exports@latest'), JSON.stringify(seenSpecs))
check('未知 token 优雅报错', m.updateJobStatus('nope').ok === false)
// 失败路径
const failPM = { listBundles: () => [], installBundle: () => Promise.reject(new Error('boom')) }
const started2 = m.startUpdate({ get: () => failPM }, sandbox, 'pkg-with-exports')
await new Promise((r) => setTimeout(r, 80))
const jr2 = m.updateJobStatus(started2.token)
check('安装失败时 stage=failed 且带原因', jr2.ok && jr2.job.done === true && jr2.job.ok === false && jr2.job.message === 'boom', JSON.stringify(jr2))
// 问题诊断
const diagText = m.describeIssues({ pkg: 'x', needsText: true })
check('needsText → 给出原因/办法/动作(由翻译优化处理)', diagText.length === 1 && diagText[0].code === 'needs-text' && diagText[0].remedy.length > 10 && diagText[0].action.kind === 'hint', JSON.stringify(diagText))
const diag404 = m.describeIssues({ pkg: 'y', version: '1.2.0', latest: null, reason: 'HTTP 404' })
check('HTTP 404 → 解释为 GitHub 直装而非裸报错', diag404.length === 1 && diag404[0].code === 'not-on-npm', JSON.stringify(diag404))
check('正常行无问题项', m.describeIssues({ pkg: 'z', version: '1.0.0', latest: '1.0.0', needsText: false }).length === 0)
const diagNet = m.describeIssues({ pkg: 'w', version: '1.0.0', latest: null, reason: 'ETIMEDOUT' })
check('网络失败 → registry-unavailable + 重试按钮', diagNet.length === 1 && diagNet[0].code === 'registry-unavailable' && diagNet[0].action.kind === 'retry', JSON.stringify(diagNet))
const diagBundle = m.describeIssues({ pkg: 'v', version: '1.0.0', latest: '1.0.0', error: 'incompatible-version' })
check('bundle 异常 → bundle-error + 处理建议', diagBundle.some((x) => x.code === 'bundle-error'), JSON.stringify(diagBundle))
check('四类问题映射全部可达', ['needs-text', 'not-on-npm', 'registry-unavailable', 'bundle-error'].every((c) => [].concat(diagText, diag404, diagNet, diagBundle).some((x) => x.code === c)))

// ─────────────────────── A4 LLM 自动生成文案 ───────────────────────
console.log(String.fromCharCode(10) + 'A4 LLM 自动生成（解析 / 流形态 / 模型解析 / 覆盖层写入）')
const goodJson = '{"en":{"title":"dsh-x","description":"EN text"},"zh":{"title":"dsh-x（甲）","description":"中文说明"}}'
check('parseGenerated 解析纯 JSON', (function () { const r = m.parseGenerated(goodJson); return !!r && r.zh.title === 'dsh-x（甲）' })())
check('parseGenerated 容忍代码块包裹', (function () { const r = m.parseGenerated('\`\`\`json' + String.fromCharCode(10) + goodJson + String.fromCharCode(10) + '\`\`\`'); return !!r && r.en.description === 'EN text' })())
check('parseGenerated 容忍前后杂讯', (function () { const r = m.parseGenerated('好的，结果如下：' + goodJson + ' 希望有帮助'); return !!r })())
check('parseGenerated 字段缺失返回 undefined', m.parseGenerated('{"en":{"title":"a"}}') === undefined)
check('parseGenerated 非 JSON 返回 undefined', m.parseGenerated('完全不是 JSON') === undefined)
check('collectStreamText 同步 text-delta', m.collectStreamText([{ type: 'text-delta', text: 'a' }, { type: 'text-delta', text: 'b' }]) === 'ab')
check('collectStreamText chunk 包裹形态', m.collectStreamText([{ type: 'chunk', chunk: { type: 'text-delta', text: 'x' } }]) === 'x')
check('collectStreamText text-chunks 形态', m.collectStreamText([{ type: 'text-chunks', index: 0, texts: ['p', 'q'] }]) === 'pq')
const asyncGen = (async function* () { yield { type: 'text-delta', text: 'ay' }; yield { type: 'chunk', chunk: { type: 'text-delta', text: 'bz' } } })()
check('collectStreamText 异步可迭代', (await m.collectStreamText(asyncGen)) === 'aybz')
check('collectStreamText 忽略 reasoning', m.collectStreamText([{ type: 'reasoning-delta', text: '想' }, { type: 'text-delta', text: '说' }]) === '说')
const ctxSettings = { get: (n) => (n === 'settings' ? { read: async (ns) => (ns === 'agent-default-model' ? { provider: 'deepseek-official', model: 'deepseek-flash' } : undefined) } : undefined) }
const selS = await m.resolveGenerationModel(ctxSettings)
check('resolveGenerationModel 走 settings 默认模型', selS && selS.model === 'deepseek-flash', JSON.stringify(selS))
const ctxLlm = { get: () => undefined, llm: { listProviders: async () => ['p1'], listModels: async () => [{ id: 'm1' }] } }
const selL = await m.resolveGenerationModel(ctxLlm)
check('resolveGenerationModel 回落 llm 提供商枚举', selL && selL.model === 'm1', JSON.stringify(selL))
check('resolveGenerationModel 无可用模型返回 undefined', (await m.resolveGenerationModel({ get: () => undefined, llm: { listProviders: async () => [], listModels: async () => [] } })) === undefined)
const fakeStreamLlm = { stream: () => [{ type: 'text-delta', text: goodJson }] }
const ctxGen = { get: (n) => (n === 'settings' ? { read: async () => ({ provider: 'p', model: 'm' }) } : undefined), llm: fakeStreamLlm }
const gen = await m.generateRefinement(ctxGen, 'dsh-x', 'some english')
check('generateRefinement 全链路成功', gen.ok === true && gen.entry.zh.title === 'dsh-x（甲）', JSON.stringify(gen))
check('无 llm 服务 → llm-unavailable', (await m.generateRefinement({ get: () => undefined }, 'p', 'd')).code === 'llm-unavailable')
check('模型输出不可解析 → bad-output', (await m.generateRefinement({ get: (n) => (n === 'settings' ? { read: async () => ({ provider: 'p', model: 'm' }) } : undefined), llm: { stream: () => [{ type: 'text-delta', text: 'nope' }] } }, 'p', 'd')).code === 'bad-output')
// upsertOverlay：临时 DSH_HOME，绝不碰真实覆盖层
const oldHome = process.env.DSH_HOME
process.env.DSH_HOME = sandbox
const up1 = m.upsertOverlay('dsh-x', { en: { title: 'dsh-x', description: 'EN' }, zh: { title: 'dsh-x（甲）', description: '中文' } })
check('upsertOverlay 写入成功', up1.ok === true && fs.existsSync(m.overlayPath()), JSON.stringify(up1))
m.upsertOverlay('dsh-x', { en: { title: 'dsh-x', description: 'EN2' }, zh: { title: 'dsh-x（甲2）', description: '中文2' } })
const ovDoc = JSON.parse(fs.readFileSync(m.overlayPath(), 'utf8'))
check('upsertOverlay 同名替换而非追加', ovDoc.entries.filter((e) => e.pkg === 'dsh-x').length === 1)
check('upsertOverlay 保留其他条目', ovDoc.entries.some((e) => e.pkg === 'pkg-with-exports') === false || ovDoc.entries.length === 1)
process.env.DSH_HOME = oldHome

// ─────────────────────── A5 设计契约（锁死交互，防回归） ───────────────────────
console.log(String.fromCharCode(10) + 'A5 设计契约 / 客户端静态检查')
const clientSrc = fs.readFileSync(path.join(REPO, 'client.js'), 'utf8')
const optimizeBody = clientSrc.slice(clientSrc.indexOf('var optimize ='), clientSrc.indexOf('var revert ='))
// 用户报告的 bug：点「翻译优化」后页面内容错乱，根因是把 /apply 的返回当成了表格行
check('客户端：apply/revert 后不得把返回值当表格行', !/call\('(apply|revert)'\)[\s\S]{0,500}?setRows\(/.test(clientSrc))
check('客户端：apply/revert 后必须重新取状态', /call\('apply'\)[\s\S]{0,500}?loadStatus\(/.test(clientSrc) && /call\('revert'\)[\s\S]{0,500}?loadStatus\(/.test(clientSrc))
check('客户端：三个按钮且职责互不重叠', clientSrc.includes("'翻译优化'") && clientSrc.includes("'还原翻译'") && clientSrc.includes("'刷新'"))
check('客户端：已删除重复的「刷新状态」「检查更新」', !clientSrc.includes("'刷新状态'") && !clientSrc.includes("'检查更新'"))
check('客户端：已删除单独的「自动生成」按钮（并入翻译优化）', !clientSrc.includes("'自动生成'") && clientSrc.includes("call('generate'"))
check('客户端：翻译优化内置生成流程', clientSrc.includes('needsText === true') && optimizeBody.includes("call('generate'") && optimizeBody.includes("call('apply'") && optimizeBody.includes('stepGen'))
check('客户端：含宿主半体过旧提示', clientSrc.includes('宿主半体版本过旧'))
check('客户端：显示宿主版本', clientSrc.includes('宿主半体 v'))
check('宿主：每个 bridge 响应带 rev', /{ rev: OWN_REV }/.test(fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')))
check('宿主：OWN_REV 形如版本号', /^\d+\.\d+\.\d+/.test(m.OWN_REV), String(m.OWN_REV))

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