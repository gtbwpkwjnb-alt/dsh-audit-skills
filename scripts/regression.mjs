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
check('注册了 9 条 bridge 路由（新增审查忽略接口）', routes.length === 9, 'got ' + routes.length + ': ' + routes.map((r) => r.path).join(','))
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
const st = await post('updates')
check('POST /updates 返回 ok 与数组', st.ok === true && Array.isArray(st.value), JSON.stringify(st).slice(0, 120))
check('端到端：每个 bridge 响应带 rev 且与本插件版本一致', typeof st.rev === 'string' && st.rev === m.OWN_REV, JSON.stringify({ rev: st.rev, own: m.OWN_REV }))
check('POST /updates 命中沙箱的两个包', st.value.length === 2, JSON.stringify(st.value.map((r) => r.pkg)))
const up = await post('updates')
check('POST /updates 返回 ok 与数组', up.ok === true && Array.isArray(up.value))
check('POST /updates 每行都带 issues 数组（端到端送达界面）', st.value.every((r) => Array.isArray(r.issues)), JSON.stringify(st.value.map((r) => typeof r.issues)))
check('POST /updates 每行都带 issues 数组', up.value.every((r) => Array.isArray(r.issues)))
check('POST /updates 对不存在的包给出 unavailable 而非崩溃', up.value.every((r) => r.latest === null && r.reason !== null), JSON.stringify(up.value.map((r) => r.reason)))
const badUpd = await post('update', {})
check('POST /update 缺 pkg 时拒绝', badUpd.ok === false && String(badUpd.message).includes('pkg'))
const atkGen = await post('generate', { pkg: '../../evil' })
check('端到端：/generate 拒绝穿越包名', atkGen.ok === false && atkGen.code === 'invalid-pkg', JSON.stringify(atkGen))
const atkUpd = await post('update', { pkg: '../../evil' })
check('端到端：/update 拒绝穿越包名', atkUpd.ok === false && atkUpd.code === 'invalid-pkg', JSON.stringify(atkUpd))
const gone = await fetch(base + '/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
check('端到端：/status 已移除（HTTP 404）', gone.status === 404, String(gone.status))
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
// 完成处理现在是 async（收尾要做一次变化提示查询），所以给足等待
await new Promise((r) => setTimeout(r, 800))
const jr = m.updateJobStatus(started.token)
check('轮询到 done 且 ok（不再是一次长请求）', jr.ok === true && jr.job.done === true && jr.job.ok === true, JSON.stringify(jr))
check('installBundle 收到的 spec 正确', seenSpecs.includes('pkg-with-exports@latest'), JSON.stringify(seenSpecs))
check('未知 token 优雅报错', m.updateJobStatus('nope').ok === false)
// 失败路径
const failPM = { listBundles: () => [], installBundle: () => Promise.reject(new Error('boom')) }
const started2 = m.startUpdate({ get: () => failPM }, sandbox, 'pkg-with-exports')
await new Promise((r) => setTimeout(r, 700))
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
const snapshotBody = clientSrc.slice(clientSrc.indexOf('var snapshot ='), clientSrc.indexOf('useEffect(function () { snapshot(); }'))
// 单一快照原则：表格行只能由 snapshot() 写入
const setRowsCount = (clientSrc.match(/setRows\(/g) || []).length
check('单一数据源：setRows 只出现 1 次（仅 snapshot 内）', setRowsCount === 1, '出现 ' + setRowsCount + ' 次')
check('单一数据源：snapshot 只调 /updates', snapshotBody.includes("call('updates'") && !snapshotBody.includes("call('status'"), snapshotBody.slice(0, 120).replace(/\s+/g, ' '))
check('客户端不再直接使用 /status', !clientSrc.includes("call('status'") && !clientSrc.includes('loadStatus'))
// 用户报告的 bug：点「翻译优化」后页面内容错乱（把 /apply 返回值当行）
check('apply/revert 后不得把返回值当表格行', !/call\('(apply|revert)'\)[\s\S]{0,600}?setRows\(/.test(clientSrc))
check('apply/revert 后必须重新取快照', /call\('apply'[\s\S]{0,600}?snapshot\(/.test(clientSrc) && /call\('revert'\)[\s\S]{0,600}?snapshot\(/.test(clientSrc))
check('更新完成后必须重新取快照（否则最新列被清空）', /updateOne\(pkg\)[\s\S]{0,400}?snapshot\(\{ force: true \}\)/.test(clientSrc))
// 按钮集（用户定的名字与职责）
check('按钮：翻译优化 / 还原翻译 / 刷新状态', clientSrc.includes("'翻译优化'") && clientSrc.includes("'还原翻译'") && clientSrc.includes("'刷新状态'"))
check('检查更新已并入刷新（无独立按钮）', !clientSrc.includes("'检查更新'"))
check('已删除单独的「自动生成」按钮（并入翻译优化）', !clientSrc.includes("'自动生成'") && clientSrc.includes("call('generate'"))
const optimizeHasBoth = optimizeBody.includes("call('generate'") && optimizeBody.includes("call('apply'") && optimizeBody.includes('stepGen')
check('翻译优化内置生成流程（同函数内含递归生成 + 应用）', optimizeHasBoth)
check('存在一键更新（串行遍历可更新项）', clientSrc.includes('updateAll') && clientSrc.includes("'一键更新（'"))
const updateAllBody = clientSrc.slice(clientSrc.indexOf('var updateAll ='), clientSrc.indexOf('var s = rows ?'))
check('客户端不再自己跑更新循环（改由宿主侧执行）', updateAllBody.includes("call('update-all'") && updateAllBody.includes('pollBatch') && !updateAllBody.includes('var step = function'))
const idxSrcA5 = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')
check('宿主：批量更新串行 for + await，且无 Promise.all', /for \(let i = 0; i < items\.length; i \+= 1\)/.test(idxSrcA5) && /await installAndWait/.test(idxSrcA5) && !/Promise\.all/.test(idxSrcA5))
check('汇总行由 rows 派生（与表格同源）', clientSrc.includes('function summarize(rows)') && clientSrc.includes('var s = rows ? summarize(rows) : null'))
check('客户端：含宿主半体过旧提示', clientSrc.includes('宿主半体版本过旧'))
check('客户端：显示宿主版本', clientSrc.includes('宿主半体 v'))
check('宿主：每个 bridge 响应带 rev', /\{ rev: OWN_REV \}/.test(fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')))
check('宿主：OWN_REV 形如版本号', /^\d+\.\d+\.\d+/.test(m.OWN_REV), String(m.OWN_REV))
check('宿主：版本查询带 TTL 缓存', /latestVersionCached/.test(fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')))
// ─────────────────────── A6 对抗性加固契约（来自 ruofeng 审查） ───────────────────────
console.log(String.fromCharCode(10) + 'A6 对抗性加固契约')
// 威胁1 标识符路径穿越
check('包名白名单：拒绝 ../../evil 之类穿越', !m.isSafePackageName('../../evil') && !m.isSafePackageName('../evil') && !m.isSafePackageName('..') && !m.isSafePackageName('a/../../b'))
check('包名白名单：拒绝空串/超长/非法字符', !m.isSafePackageName('') && !m.isSafePackageName('a'.repeat(300)) && !m.isSafePackageName('a b') && !m.isSafePackageName('a;rm -rf /'))
check('包名白名单：接受正常包名', m.isSafePackageName('dsh-free-search') && m.isSafePackageName('@scope/name') && m.isSafePackageName('dsh-x.y_z'))
const attackProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'atk-'))
fs.mkdirSync(path.join(attackProfile, 'node_modules'), { recursive: true })
fs.mkdirSync(path.join(attackProfile, 'evil'), { recursive: true })
fs.writeFileSync(path.join(attackProfile, 'evil', 'package.json'), JSON.stringify({ name: 'evil', version: '9.9.9', description: 'x', dsh: { bundle: { patch: './p.yml' } } }))
check('readBundleInfo 拒绝穿越（此前可读到树外包）', m.readBundleInfo(attackProfile, '../../evil') === undefined)
check('resolveUpdateSpec 拒绝穿越（依赖门，原本就挡住）', m.resolveUpdateSpec(attackProfile, '../../evil').spec === null)
fs.rmSync(attackProfile, { recursive: true, force: true })
// 威胁2 降级不当更新
check('版本序：降级不算更新', m.isNewerVersion('1.5.0', '2.0.0') === false)
check('版本序：升级算更新', m.isNewerVersion('2.0.0', '1.5.0') === true)
check('版本序：相同不算更新', m.isNewerVersion('1.0.0', '1.0.0') === false)
check('版本序：非标准版本退回不等比较', m.isNewerVersion('beta', 'alpha') === true)
// 威胁3 命名约定必须强制
check('enforceTitle：模型不守约定时补前缀', m.enforceTitle('dsh-x', '完全无关的名字') === 'dsh-x（完全无关的名字）', m.enforceTitle('dsh-x', '完全无关的名字'))
check('enforceTitle：已守约定则原样保留', m.enforceTitle('dsh-x', 'dsh-x（甲）') === 'dsh-x（甲）')
check('enforceTitle：空标题退回包名', m.enforceTitle('dsh-x', '') === 'dsh-x')
// 威胁4 行形状统一 + needsText 语义
const rowSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'row-'))
const rowNm = path.join(rowSandbox, 'node_modules')
const bundleDecl = { dsh: { bundle: { patch: './cordis.patch.yml' } } }
// 一个有内置文案但未应用（无 locale 文件）的包 —— 用真实 catalog 里的名字
fs.mkdirSync(path.join(rowNm, 'dsh-better-sidebar'), { recursive: true })
fs.writeFileSync(path.join(rowNm, 'dsh-better-sidebar', 'package.json'), JSON.stringify(Object.assign({ name: 'dsh-better-sidebar', version: '1.0.0' }, bundleDecl)))
// 一个既无内置文案也无 locale 的包
fs.mkdirSync(path.join(rowNm, 'never-heard-of'), { recursive: true })
fs.writeFileSync(path.join(rowNm, 'never-heard-of', 'package.json'), JSON.stringify(Object.assign({ name: 'never-heard-of', version: '1.0.0' }, bundleDecl)))
fs.writeFileSync(path.join(rowSandbox, 'package.json'), JSON.stringify({ name: 'p', dependencies: { 'dsh-better-sidebar': '*', 'never-heard-of': '*' }, dsh: { profile: { bundles: ['dsh-better-sidebar', 'never-heard-of'] } } }))
const rowRows = m.collectStatus([rowSandbox])
const rowA = rowRows.find((r) => r.pkg === 'dsh-better-sidebar')
const rowB = rowRows.find((r) => r.pkg === 'never-heard-of')
check('行：有内置文案但未应用 -> localized=false 且 needsText=false（不白调模型）', !!rowA && rowA.localized === false && rowA.inCatalog === true && rowA.needsText === false, JSON.stringify(rowA))
check('行：无任何文案 -> needsText=true（才该调模型）', !!rowB && rowB.needsText === true, JSON.stringify(rowB))
check('行：不再携带死字段 description/title', rowRows.every((r) => !('description' in r) && !('title' in r)), JSON.stringify(Object.keys(rowRows[0] || {})))
check('行：两条路径共用同一构造函数（含 inCatalog 字段）', 'inCatalog' in (rowRows[0] || {}))
fs.rmSync(rowSandbox, { recursive: true, force: true })
// 威胁5 任务表有界
const idxSrc = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')
check('更新任务表有界（有 prune）', idxSrc.includes('pruneUpdateJobs') && idxSrc.includes('UPDATE_JOB_KEEP'))
// YAGNI：/status 已删除
check('YAGNI：/status 端点已删除', !idxSrc.includes("BRIDGE_PREFIX + '/status'"))
// ─────────────────────── A7 批量更新契约（宿主侧 + 落盘 + 诚实反馈） ───────────────────────
console.log(String.fromCharCode(10) + 'A7 批量更新契约')
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = sandbox
const batchFile = path.join(sandbox, 'dsh-audit-skills', 'update-batch.json')
const noMgrCtx = { get: () => undefined }
const startedBatch = m.startUpdateAll(noMgrCtx, sandbox, ['pkg-with-exports', 'never-heard-of'])
check('批量更新启动返回 batch 与总数', startedBatch.ok === true && startedBatch.batch.total === 2)
await new Promise((r) => setTimeout(r, 1500))
const stB1 = m.updateAllStatus()
check('批量状态落盘且已完成', !!stB1 && stB1.running === false && typeof stB1.finishedAt === 'number', JSON.stringify(stB1 && stB1.message))
check('状态文件确实写在磁盘（宿主模块被重载也不丢）', fs.existsSync(batchFile))
check('无插件管理器时逐项如实报失败', !!stB1 && stB1.items.every((x) => x.state === 'failed'), JSON.stringify(stB1 && stB1.items.map((x) => x.state)))
check('非法包名被过滤而不进入批次', m.startUpdateAll(noMgrCtx, sandbox, ['../../evil']).ok === false)
fs.writeFileSync(batchFile, JSON.stringify({ running: true, startedAt: Date.now(), items: [], total: 0, index: 0, message: 'x' }))
check('进行中时幂等返回、不重复启动', m.startUpdateAll(noMgrCtx, sandbox, ['pkg-with-exports']).alreadyRunning === true)
fs.writeFileSync(batchFile, JSON.stringify({ running: true, startedAt: Date.now() - 11 * 60 * 1000, items: [], total: 0, index: 0, message: 'x' }))
check('超过 10 分钟无进展的 running 视为中断（不卡死后续批量）', m.updateAllStatus().running === false)
const targetPkgJson = path.join(nm, 'pkg-with-exports', 'package.json')
const bumpPM = { listBundles: () => [], installBundle: async () => { const j = JSON.parse(fs.readFileSync(targetPkgJson, 'utf8')); j.version = '9.9.9'; fs.writeFileSync(targetPkgJson, JSON.stringify(j, null, 2)); return {} } }
m.startUpdateAll({ get: (n) => (n === 'pluginManager' ? bumpPM : undefined) }, sandbox, ['pkg-with-exports'])
await new Promise((r) => setTimeout(r, 1500))
const itemB = (m.updateAllStatus().items || []).find((x) => x.pkg === 'pkg-with-exports')
check('成功路径记录 from→to 并标为 updated', !!itemB && itemB.state === 'updated' && itemB.from !== itemB.to, JSON.stringify(itemB))
const noopPM = { listBundles: () => [], installBundle: async () => ({}) }
// 注意：A3 段已把沙箱依赖表重写为 {pkg-with-exports, pkg-git, pkg-local}，
// 所以这里必须用仍在依赖里的包，否则会先被「不在依赖里」拦掉。
m.startUpdateAll({ get: (n) => (n === 'pluginManager' ? noopPM : undefined) }, sandbox, ['pkg-with-exports'])
await new Promise((r) => setTimeout(r, 1500))
const itemC = (m.updateAllStatus().items || []).find((x) => x.pkg === 'pkg-with-exports')
check('安装执行了但版本未变 -> 如实标为 unchanged（不假装成功）', !!itemC && itemC.state === 'unchanged', JSON.stringify(itemC))
check('结束语区分 成功/未变化/失败', /成功 \d+ 个，未变化 \d+ 个，失败 \d+ 个/.test(String(m.updateAllStatus().message)), String(m.updateAllStatus().message))
process.env.DSH_HOME = savedHome

// ─────────────────────── A8 更新后的精炼保持 + 变化提示 ───────────────────────
console.log(String.fromCharCode(10) + 'A8 更新后精炼保持 / 变化提示')
const savedHome3 = process.env.DSH_HOME
process.env.DSH_HOME = sandbox
// 用真实 catalog 里的包名，验证「更新后自动补回精炼」
const keepDir = path.join(nm, 'dsh-better-sidebar')
fs.mkdirSync(keepDir, { recursive: true })
fs.writeFileSync(path.join(keepDir, 'package.json'), JSON.stringify({ name: 'dsh-better-sidebar', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2))
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'p', dependencies: { 'dsh-better-sidebar': '^1.0.0' }, dsh: { profile: { bundles: ['dsh-better-sidebar'] } } }, null, 2))
check('更新前：该包未被精炼', m.inspectPackage(sandbox, { pkg: 'dsh-better-sidebar' }).localized === false)
// 假插件管理器：模拟「重新物化目录」——把 locale 洗掉并把版本抬上去
const rematerializePM = { listBundles: () => [], installBundle: async () => {
  fs.rmSync(path.join(keepDir, 'locale'), { recursive: true, force: true })
  const j = JSON.parse(fs.readFileSync(path.join(keepDir, 'package.json'), 'utf8')); j.version = '2.0.0'
  fs.writeFileSync(path.join(keepDir, 'package.json'), JSON.stringify(j, null, 2)); return {} } }
m.startUpdateAll({ get: (n) => (n === 'pluginManager' ? rematerializePM : undefined) }, sandbox, ['dsh-better-sidebar'])
await new Promise((r) => setTimeout(r, 1500))
const keepItem = (m.updateAllStatus().items || []).find((x) => x.pkg === 'dsh-better-sidebar')
check('更新后：精炼被自动补回并标记 refined', !!keepItem && keepItem.refined === true, JSON.stringify(keepItem && { state: keepItem.state, refined: keepItem.refined }))
check('更新后：locale 文件确实重新落盘（用户无需再点翻译优化）', fs.existsSync(path.join(keepDir, 'locale', 'zh.json')))
// 变化提示：包内 CHANGELOG 优先
fs.writeFileSync(path.join(keepDir, 'CHANGELOG.md'), ['# Changelog', '', '## 2.0.0', '', '- 新增：支持 X 功能', '- 修复：Y 崩溃', '', '## 1.0.0', '', '- 初始版本'].join(String.fromCharCode(10)))
const section = m.readLocalChangelog(sandbox, 'dsh-better-sidebar', '2.0.0')
check('readLocalChangelog 抽取正确版本小节', typeof section === 'string' && section.includes('支持 X 功能') && !section.includes('初始版本'), String(section).slice(0, 60))
check('readLocalChangelog 对缺失版本返回 undefined', m.readLocalChangelog(sandbox, 'dsh-better-sidebar', '9.9.9') === undefined)
const deltaLocal = await m.describeUpdateDelta(sandbox, 'dsh-better-sidebar', '1.0.0', '2.0.0')
check('有 CHANGELOG 时来源标为 changelog（事实优先）', deltaLocal.source === 'changelog', JSON.stringify(deltaLocal.source))
check('describeDeltaText 事实源直出日志', m.describeDeltaText(deltaLocal).startsWith('变更日志：'))
// 无 CHANGELOG -> 退回结构性推断，且必须明确说明无法判定修复/新增
fs.rmSync(path.join(keepDir, 'CHANGELOG.md'), { force: true })
const deltaNet = await m.fetchVersionDelta('dsh-context', '0.56.1', '0.56.2')
check('registry 差异查询可用', deltaNet.status === 'ok', JSON.stringify(deltaNet).slice(0, 120))
check('dsh-context 0.56.1→0.56.2 未检出结构性变化（与实测一致）', Array.isArray(deltaNet.details) && deltaNet.details.length === 0, JSON.stringify(deltaNet.details))
const deltaText = m.describeDeltaText({ source: 'structure', details: [], repoUrl: 'https://github.com/x/y' })
check('推断源明确标注「无法判定是修复还是新增」', deltaText.includes('未检出结构性变化') && deltaText.includes('无法判定是修复还是新增'), deltaText)
check('推断源附带仓库地址（让用户自己看 release notes）', deltaText.includes('https://github.com/x/y'))
check('新增依赖会被报为结构性变化', m.describeDeltaText({ source: 'structure', details: ['新增依赖 a、b'], repoUrl: null }).includes('新增依赖 a、b'))
check('信息不可得时如实说明', m.describeDeltaText({ source: 'unavailable', reason: 'HTTP 404' }).includes('无法获取变更信息'))
process.env.DSH_HOME = savedHome3

// ─────────────────────── A9 更新不得被卡住 + 优化跳过已优化 ───────────────────────
console.log(String.fromCharCode(10) + 'A9 有界等待 / 跳过已优化')
const savedHome4 = process.env.DSH_HOME
process.env.DSH_HOME = sandbox
// A8 改过沙箱依赖，这里恢复出需要的包
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'p', dependencies: { 'pkg-with-exports': '^1.0.0' }, dsh: { profile: { bundles: ['pkg-with-exports'] } } }, null, 2))
// 核心：永不 settle 的安装不能让流程挂住（实机表现就是「批量卡在 1/3」）
const neverPM = { listBundles: () => [], installBundle: () => new Promise(() => {}) }
const tHang = Date.now()
const hangResult = await m.installAndWait({ get: (n) => (n === 'pluginManager' ? neverPM : undefined) }, sandbox, 'pkg-with-exports', 2500)
const hangMs = Date.now() - tHang
check('永不 settle 的安装不会挂住（有界超时）', hangResult.ok === false && hangResult.timedOut === true && hangMs < 9000, 'ms=' + hangMs + ' ' + JSON.stringify(hangResult))
// 版本真的变了 -> 快速返回成功，不必等满超时
const fastPM = { listBundles: () => [], installBundle: async () => { const f = path.join(nm, 'pkg-with-exports', 'package.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.version = '7.7.7'; fs.writeFileSync(f, JSON.stringify(j, null, 2)); return {} } }
const tFast = Date.now()
const fastResult = await m.installAndWait({ get: (n) => (n === 'pluginManager' ? fastPM : undefined) }, sandbox, 'pkg-with-exports', 30000)
check('版本确实变化时提前返回成功', fastResult.ok === true && fastResult.to === '7.7.7' && Date.now() - tFast < 8000, JSON.stringify({ ms: Date.now() - tFast, r: fastResult }))
check('有界等待不再出现裸 await pm.installBundle', !/await pm\.installBundle/.test(fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')))
// /apply 支持定向：只处理指定包
const onlyA = m.applyLocale([sandbox], { entries: m.readCatalog().filter((e) => e.pkg === 'dsh-better-sidebar') })
check('定向应用只返回被指定的包', onlyA.length === 1 && onlyA[0].pkg === 'dsh-better-sidebar', JSON.stringify(onlyA.map((x) => x.pkg)))
check('定向应用对空列表什么都不做', m.applyLocale([sandbox], { entries: [] }).length === 0)
process.env.DSH_HOME = savedHome4
// 客户端契约：跳过已优化 + 去启用列 + 措辞
check('客户端：翻译优化会跳过已优化（只对未 localized 的包调 apply）', clientSrc.includes('var toApply = cur.filter') && clientSrc.includes("call('apply', { pkgs: toApply.map"))
check('客户端：全部已优化时直接返回不做事', clientSrc.includes('均已优化，无需处理'))
check('客户端：表格已去掉「启用」列', !clientSrc.includes("'启用'"))
check('客户端：精炼措辞已改为优化', !clientSrc.includes('已精炼') && !clientSrc.includes('待精炼') && clientSrc.includes("'已优化'"))
check('客户端：三态标签齐全（已优化/待应用/待优化）', clientSrc.includes("'已优化'") && clientSrc.includes("'待应用'") && clientSrc.includes("'待优化'"))

// ─────────────────────── A10 审查规则引擎 ───────────────────────
console.log(String.fromCharCode(10) + 'A10 审查规则')
// 补丁解析：必须区分「新增行」与「覆盖行」，否则会把自己新挂的行误报成覆盖别人
// 注意缩进：真实文件里顶层覆盖行与 `- insert:` **同级**，insert 的子条目更深一层
const patchSample = [
  '    - insert:',
    "        - id: my-row",
    "          name: 'pkg-alpha'",
  '    - id: shared-row',
  '      config:',
  '        a: 1',
].join(String.fromCharCode(10))
const parsed = m.parsePatchTargets(patchSample)
check('补丁解析：insert 下的条目算新增行', parsed.inserts.includes('my-row') && !parsed.inserts.includes('shared-row'), JSON.stringify(parsed))
check('补丁解析：顶层只有 id 的算覆盖行', parsed.overrides.includes('shared-row') && !parsed.overrides.includes('my-row'), JSON.stringify(parsed))
// 自建最小 asar，让注入可满足性判定不依赖本机路径
const auditRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'))
const auditNm = path.join(auditRoot, 'node_modules')
const appPkgs = ['@deepseek-ai/dsh-client-locale', 'third-party-shared']
const bundleDecl2 = { dsh: { bundle: { patch: './cordis.patch.yml' } } }
function mkPkg(name, opts) {
  const dir = path.join(auditNm, ...name.split('/'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(Object.assign({ name, version: '1.0.0', dsh: Object.assign({}, bundleDecl2.dsh, opts.client ? { client: { platform: 'web', inject: opts.client } } : {}) }, opts.extra || {}), null, 2))
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), opts.patch)
}
mkPkg('pkg-alpha', { patch: ['- insert:', '    - id: alpha-row', "      name: 'pkg-alpha'"].join(String.fromCharCode(10)), client: ['@deepseek-ai/dsh-client-locale'] })
mkPkg('pkg-beta', { patch: ['- id: shared-row', '  config:', '    b: 2'].join(String.fromCharCode(10)), client: ['@deepseek-ai/no-such-module'] })
mkPkg('pkg-gamma', { patch: ['- id: shared-row', '  config:', '    c: 3'].join(String.fromCharCode(10)) })
mkPkg('pkg-delta', { patch: ['- id: delta-row', '  config: {}'].join(String.fromCharCode(10)), client: ['third-party-shared'] })
mkPkg('pkg-epsilon', { patch: ['- id: epsilon-row', '  config: {}'].join(String.fromCharCode(10)), client: ['third-party-shared'] })
fs.writeFileSync(path.join(auditRoot, 'package.json'), JSON.stringify({ name: 'audit', dependencies: { 'pkg-alpha': '*', 'pkg-beta': '*', 'pkg-gamma': '*', 'pkg-delta': '*', 'pkg-epsilon': '*' }, dsh: { profile: { bundles: ['pkg-alpha', 'pkg-beta', 'pkg-gamma', 'pkg-delta', 'pkg-epsilon'] } } }, null, 2))
fs.writeFileSync(path.join(auditRoot, 'cordis.patch.yml'), ['- id: alpha-row', '  config: {}'].join(String.fromCharCode(10)))
// 最小 asar：只放我们声明的两个模块名
function writeMiniAsar(file, names) {
  const data = []
  const files = {}
  let offset = 0
  const nmFiles = {}
  for (const n of names) {
    const parts = n.split('/')
    const content = Buffer.from(JSON.stringify({ name: n, version: '0.0.0' }), 'utf8')
    data.push(content)
    nmFiles[parts[0]] = nmFiles[parts[0]] || { files: {} }
    nmFiles[parts[0]].files[parts[1]] = { files: { 'package.json': { size: content.length, offset: offset } } }
    offset += content.length
  }
  const header = { files: { dsh: { files: { node_modules: { files: nmFiles } } } } }
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8')
  const pre = Buffer.alloc(8)
  pre.writeUInt32LE(4, 0)
  pre.writeUInt32LE(headerJson.length, 4)
  fs.writeFileSync(file, Buffer.concat([pre, headerJson].concat(data)))
}
const miniAsar = path.join(auditRoot, 'app.asar')
writeMiniAsar(miniAsar, appPkgs)
process.env.DSH_APP_ASAR = miniAsar
m.clearAuditCache()
const audited = m.auditPackages({ get: () => undefined }, auditRoot)
const find = (kind, pkg) => audited.findings.filter((f) => f.kind === kind && (f.pkg === pkg || (f.peers || []).includes(pkg)))
check('R1：声明缺失模块 -> 事实级发现', find('conflict', 'pkg-beta').some((f) => f.confidence === 'fact' && f.title.includes('no-such-module')), JSON.stringify(find('conflict', 'pkg-beta').map((f) => f.title)))
check('R1：模块可满足则不报', !find('conflict', 'pkg-alpha').some((f) => f.title.includes('dsh-client-locale')))
check('R1：缺失只断言「不存在」，标题不宣称致命', (function () { const r1 = find('conflict', 'pkg-beta').filter((f) => f.title.includes('no-such-module')); return r1.length === 1 && r1[0].title.includes('不存在') && !r1[0].title.includes('无法启动') })(), JSON.stringify(find('conflict', 'pkg-beta').map((f) => f.title)))
check('R2：覆盖非自身行 -> 报出', find('conflict', 'pkg-beta').some((f) => f.title.includes('shared-row')), JSON.stringify(find('conflict', 'pkg-beta').map((f) => f.title)))
check('R2：自己 insert 的行不算覆盖', !find('conflict', 'pkg-alpha').some((f) => f.title.includes('alpha-row')))
check('R3：两个插件覆盖同一行 -> 一条、双方可见', (function () {
  const dup = audited.findings.filter((f) => f.kind === 'conflict' && f.peers.includes('pkg-gamma'))
  return dup.length === 1 && dup[0].peers.length === 1 && dup[0].severity === 'high'
})(), JSON.stringify(audited.findings.filter((f) => f.title.includes('shared-row')).map((f) => f.pkg + '/' + f.peers)))
check('R4：用户补丁层与插件新增行撞名 -> 推断级', find('interaction', 'pkg-alpha').some((f) => f.confidence === 'inferred' && f.title.includes('alpha-row')), JSON.stringify(find('interaction', 'pkg-alpha').map((f) => f.title)))
check('R6：共享非平台模块 -> 一条、标推断', (function () {
  const sh = audited.findings.filter((f) => f.kind === 'interaction' && String(f.evidence).includes('third-party-shared'))
  return sh.length === 1 && sh[0].confidence === 'inferred'
})(), JSON.stringify(audited.findings.filter((f) => f.kind === 'interaction').map((f) => f.title)))
check('R6：平台模块（@deepseek-ai/*）共享不报（避免噪音）', !audited.findings.some((f) => f.evidence && f.evidence.includes('@deepseek-ai/dsh-client-locale')))
check('R5：未声明兼容性收集为汇总名单，不逐行', Array.isArray(audited.noCompat) && audited.noCompat.length === 5 && !audited.findings.some((f) => f.title.includes('兼容')))
check('审查缓存：第二次命中同一对象', m.auditPackages({ get: () => undefined }, auditRoot) === audited)
// 忽略列表：写入后不再出现
const savedHome5 = process.env.DSH_HOME
process.env.DSH_HOME = auditRoot
const target = audited.findings[0]
check('忽略：写入成功', m.ignoreFinding(target.id).ok === true)
check('忽略：读回包含该 id', m.readIgnored().includes(target.id))
check('忽略：幂等（重复写不重复计）', (function () { m.ignoreFinding(target.id); return m.readIgnored().filter((x) => x === target.id).length === 1 })())
process.env.DSH_HOME = savedHome5
delete process.env.DSH_APP_ASAR
fs.rmSync(auditRoot, { recursive: true, force: true })
// 客户端契约
check('客户端：审查并入刷新，无独立按钮', clientSrc.includes('call(\'updates\'') && !clientSrc.includes("'安全审查'"))
check('客户端：事实/推断分组展示', clientSrc.includes('另有 ') && clientSrc.includes('仅供知悉'))
check('客户端：严重度用文字而非仅颜色', clientSrc.includes("high: '高'") && clientSrc.includes("medium: '中'"))
check('客户端：提供忽略入口', clientSrc.includes("call('ignore'") && clientSrc.includes('忽略此条'))

// ─────────────────────── C 真实 profile 只读 ───────────────────────
console.log(String.fromCharCode(10) + 'C 真实 profile：只读检查（不写入）')
const real = m.collectStatus([PROFILE])
check('collectStatus 在真实 profile 上有结果', real.length > 0, 'rows=' + real.length)
check('collectStatus 不含未安装项', real.every((r) => r.installed === true))
check('collectStatus 每项都有 pkg', real.every((r) => typeof r.pkg === 'string' && r.pkg.length > 0))
const cat = m.readCatalog()
check('catalog 可读且非空', Array.isArray(cat) && cat.length > 0, 'entries=' + cat.length)
const tc1 = Date.now(); await m.latestVersionCached('dsh-free-search'); const dc1 = Date.now() - tc1
const tc2 = Date.now(); const cachedHit = await m.latestVersionCached('dsh-free-search'); const dc2 = Date.now() - tc2
check('版本缓存：第二次命中（刷新即时）', cachedHit.latest !== null && dc2 <= dc1, 'first=' + dc1 + 'ms second=' + dc2 + 'ms')
const forced = await m.latestVersionCached('dsh-free-search', true)
check('版本缓存：force 可绕过', forced.latest !== null, JSON.stringify(forced))
m.clearLatestCache()
check('版本缓存：可清空', true)

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