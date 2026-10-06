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
import { execFileSync } from 'node:child_process'
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
const legacy = { name: 'pkg-with-exports', version: '1.0.0', repository: { type: 'git', url: 'git+https://user:token@gitlab.example.com:8443/team/pkg-with-exports.git?x=1#frag' }, exports: { '.': './index.js', './locale/*': './locale/*' }, dsh: { bundle } }
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
const fakeCtxBase = {
  logger: { info() {}, warn() {} },
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
  get: (n) => services[n],
  inject(names, cb) { if (names.every((n) => services[n] !== undefined)) cb({ get: fakeCtx.get, effect: fakeCtx.effect, webServer: services.webServer }) },
}
// Cordis 语义：未 inject 的服务名**读属性就抛**。用 Proxy 复刻，
// 于是本节每条 route handler 都在真实上下文语义下被验证 ——
// 裸读 ctx.llm 的老代码会当场变成 'cannot get property "llm" without inject'。
const fakeCtx = new Proxy(fakeCtxBase, {
  get(target, key) {
    /* Cordis 语义：读**任何**未声明的属性都抛，不只是 llm/settings。
       旧版这里只白名单式地特判 4 个服务名，于是漏掉了真机那次
       `ctx.includeExternalSkills` 裸读（属性名不在特判表里 → 返回 undefined → 测试全绿、真机全红）。 */
    if (typeof key === 'symbol' || key === 'prototype' || key === 'then' || String(key).startsWith('_')) return Reflect.get(target, key)
    if (Reflect.has(target, key)) return Reflect.get(target, key)
    throw new Error('cannot get property "' + String(key) + '" without inject')
  },
})
m.apply(fakeCtx, { autoApply: false, revertOnDisable: false, profileDir: sandbox })
const requiredRoutes = ['/management', '/manage', '/apply', '/updates', '/update', '/skills', '/update-skills', '/apply-skills', '/revert-skills', '/generate-skill', '/finding-action', '/ignore', '/generate', '/update-all', '/update-all-status', '/translate-run', '/update-status', '/revert']
check('注册了全部 bridge 路由（含治理快照/动作与翻译留痕）', requiredRoutes.every((suffix) => routes.some((r) => r.path === '/api/dsh-audit-skills' + suffix)) && new Set(routes.map((r) => r.path)).size === routes.length, 'got ' + routes.length + ': ' + routes.map((r) => r.path).join(','))
check('治理 bridge 路由已注册', routes.some((r) => r.path.endsWith('/management')) && routes.some((r) => r.path.endsWith('/manage')))
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
/* 端到端复现真机 bug：宿主上下文里没有 includeExternalSkills 这个字段（Cordis 读它就抛）。
   技能目录指向沙箱空目录，避免扫真实技能库并联网。 */
const savedHomeSk = process.env.DSH_HOME
const savedAgentsSk = process.env.DSH_AGENTS_HOME
process.env.DSH_HOME = path.join(sandbox, 'no-dsh-home')
process.env.DSH_AGENTS_HOME = path.join(sandbox, 'no-agents-home')
const skE2E = await post('skills')
process.env.DSH_HOME = savedHomeSk
process.env.DSH_AGENTS_HOME = savedAgentsSk
check('端到端：宿主 ctx 无 includeExternalSkills 时 /skills 仍返回 ok（不再整条路由失败）', skE2E.ok === true && Array.isArray(skE2E.value), JSON.stringify(skE2E).slice(0, 200))
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
// 端到端复现真机 bug：宿主 ctx 没有 llm 服务时，/generate-skill 必须给出可读的
// llm-unavailable，而**不是** Cordis 的 'cannot get property "llm" without inject'。
const savedHomeB = process.env.DSH_HOME
const savedAgentsB = process.env.DSH_AGENTS_HOME
process.env.DSH_HOME = path.join(sandbox, 'no-dsh-home')
process.env.DSH_AGENTS_HOME = path.join(sandbox, 'no-agents-home')
const e2eSkillDir = path.join(process.env.DSH_AGENTS_HOME, 'skills', 'demo-e2e')
fs.mkdirSync(e2eSkillDir, { recursive: true })
fs.writeFileSync(path.join(e2eSkillDir, 'SKILL.md'), ['---', 'name: demo-e2e', 'description: EN only desc', '---', 'body'].join(String.fromCharCode(10)))
const genNoLlm = await post('generate-skill', { pkg: 'demo-e2e' })
check('端到端：/generate-skill 在无 llm 服务时给可读原因（不是 without inject）',
  genNoLlm.ok === false && genNoLlm.code === 'llm-unavailable', JSON.stringify(genNoLlm))
process.env.DSH_HOME = savedHomeB
process.env.DSH_AGENTS_HOME = savedAgentsB
const rv = await post('revert')
check('POST /revert 返回 ok', rv.ok === true)
// 翻译留痕：端到端 POST /translate-run → 宿主规范化后落盘（沙箱 DSH_HOME，绝不碰真实覆盖层目录）
const savedHomeT = process.env.DSH_HOME
process.env.DSH_HOME = sandbox
const tr = await post('translate-run', {
  action: 'optimize',
  message: '翻译优化完成',
  items: [
    { pkg: 'pkg-with-exports', state: 'applied', message: '已写入 locale/zh.json' },
    { pkg: 'pkg-no-exports', state: 'failed', message: '找不到默认模型' },
    { pkg: '', state: 'applied' },
    { pkg: 'pkg-bad-state', state: 'weird-state' },
  ],
})
check('端到端：/translate-run 落盘并回传规范化记录', tr.ok === true && tr.value.total === 3 && tr.value.applied === 1 && tr.value.failed === 1, JSON.stringify(tr).slice(0, 200))
check('端到端：空包名被丢弃、未知动作退回 optimize', tr.ok === true && tr.value.action === 'optimize' && !tr.value.items.some((it) => it.pkg === ''))
check('端到端：记录有 finishedAt，可供页面显示「上次优化几时」', typeof tr.value.finishedAt === 'number')
const trRead = m.readTranslateRun()
check('端到端：记录真的写在磁盘上（宿主重载也不丢）', !!trRead && trRead.total === 3 && trRead.failed === 1, JSON.stringify(trRead).slice(0, 160))
/* 技能页留痕必须是**独立文件**：共用一个文件时技能页会覆盖插件页
   （这正是技能页此前干脆不留痕的原因）。 */
const trSkill = await post('translate-run', {
  action: 'optimize', scope: 'skill', message: '技能页翻译留痕',
  items: [{ pkg: 'demo-skill', state: 'applied', message: '已写入 SKILL.md' }],
})
check('端到端：scope=skill 的留痕写自己的文件并回传 scope',
  trSkill.ok === true && trSkill.value.total === 1 && trSkill.value.scope === 'skill', JSON.stringify(trSkill).slice(0, 200))
check('端到端：技能留痕不覆盖插件页记录（两份并存）',
  m.readTranslateRun('plugin').total === 3 && m.readTranslateRun('skill').total === 1,
  JSON.stringify({ plugin: m.readTranslateRun('plugin').total, skill: m.readTranslateRun('skill').total }))
const upAfterTr = await post('updates')
check('端到端：/updates 仍返回插件页留痕', !!upAfterTr.translate && upAfterTr.translate.total === 3, JSON.stringify(upAfterTr.translate).slice(0, 140))
const savedHomeSk2 = process.env.DSH_HOME
const savedAgentsSk2 = process.env.DSH_AGENTS_HOME
process.env.DSH_HOME = sandbox
process.env.DSH_AGENTS_HOME = path.join(sandbox, 'no-agents-home')
const skTr = await post('skills')
process.env.DSH_HOME = savedHomeSk2
process.env.DSH_AGENTS_HOME = savedAgentsSk2
check('端到端：/skills 返回技能页自己的留痕（两页不串）', !!skTr.translate && skTr.translate.total === 1, JSON.stringify(skTr.translate).slice(0, 140))
check('规范化：条目数有上限（不信任客户端输入）', m.normalizeTranslateRun({ action: 'optimize', items: new Array(200).fill({ pkg: 'x', state: 'applied' }) }).total === 60)
check('规范化：非对象输入不抛错', m.normalizeTranslateRun(null).action === 'optimize' && m.normalizeTranslateRun('nope').total === 0)

// ─────── A1c 本轮修复：更新失败（git 直装）与「翻译优化看不到失败原因」（先红后绿） ───────
console.log(String.fromCharCode(10) + 'A1c 更新失败 + 翻译失败原因留痕')
/* 1) 附注标签：`git ls-remote refs/tags/v2.10.5` 给的是**标签对象** sha，不是提交。
   实测本插件（v2.10.5 是附注标签）因此被永久误判「可更新」，点更新必然失败。 */
const lsRemoteAnnotated = [
  '847947f0fa81d8715ceb1c70301774d436c2825a\trefs/tags/v2.10.5',
  '9bd914e0fa81d8715ceb1c70301774d436c2825a\trefs/tags/v2.10.5^{}',
].join('\n')
check('[更新] 附注标签取 peeled 提交，而不是标签对象',
  m.pickRemoteCommit(lsRemoteAnnotated) === '9bd914e0fa81d8715ceb1c70301774d436c2825a', String(m.pickRemoteCommit(lsRemoteAnnotated)))
check('[更新] 只有分支行时照常取该 sha；空输出返回 null（不猜）',
  m.pickRemoteCommit('a'.repeat(40) + '\trefs/heads/main') === 'a'.repeat(40) && m.pickRemoteCommit('') === null)
check('[更新] 标签查询候选里同时包含 `^{}`（否则拿不到 peeled 提交）',
  JSON.stringify(m.remoteRefCandidates('v2.10.5')).includes('refs/tags/v2.10.5^{}'))
/* 2) git 直装插件的安装规格必须是「会变的那一条」：宿主管理器按依赖字符串是否变化判断装了哪个包，
   原样重装 `github:repo#v2.10.5` 时字符串不变 → 管理器抛 ambiguous-install（已从 DSH 核心代码证实）。 */
check('[更新] 有更新的 tag 时把 spec 换成新 tag（依赖字符串改变，管理器才认得出）',
  m.gitUpdateSpec('github:repo-owner/dsh-x#v2.10.5', 'v2.10.6') === 'github:repo-owner/dsh-x#v2.10.6',
  String(m.gitUpdateSpec('github:repo-owner/dsh-x#v2.10.5', 'v2.10.6')))
check('[更新] 跟分支的 git 依赖改用远端提交 sha 固定（同样让字符串变化）',
  m.gitUpdateSpec('github:a/b', 'b'.repeat(40)) === 'github:a/b#' + 'b'.repeat(40))
check('[更新] 目标 ref 与现状相同时返回 null（不许拿同样的 spec 去重装）',
  m.gitUpdateSpec('github:a/b#v1.0.0', 'v1.0.0') === null)
check('[更新] 已是最新的 tag pin：没有更新目标（不再调用管理器，从根上避免 ambiguous-install）',
  m.gitUpdateTarget({ kind: 'git', newestTag: null, remoteCommit: 'c'.repeat(40), currentCommit: 'c'.repeat(40) }, 'github:a/b#v1.0.0') === null)
check('[更新] 有更高版本的 tag：给出 tag 目标',
  JSON.stringify(m.gitUpdateTarget({ kind: 'git', newestTag: { name: 'v2.0.0' }, remoteCommit: 'd'.repeat(40), currentCommit: 'c'.repeat(40) }, 'github:a/b#v1.0.0')) === '{"tag":"v2.0.0"}')
check('[更新] 跟 HEAD/分支：远端提交不同则给出 sha 目标',
  JSON.stringify(m.gitUpdateTarget({ kind: 'git', newestTag: null, remoteCommit: 'e'.repeat(40), currentCommit: 'c'.repeat(40) }, 'github:a/b')) === '{"sha":"' + 'e'.repeat(40) + '"}')
check('[更新] 最高版本 tag 的挑选：忽略比当前低的、忽略非版本号 tag',
  (() => {
    const tags = { 'v2.10.4': 'a', 'v2.10.6': 'b', 'v2.10.5': 'c', nightly: 'd', 'v1.0.0': 'e' }
    const best = m.newestTagAbove(tags, 'v2.10.5')
    return !!best && best.name === 'v2.10.6' && m.newestTagAbove({ 'v1.0.0': 'e', nightly: 'd' }, 'v2.10.5') === null
  })())
check('[更新] 管理器失败码有人话解释，不再把 ambiguous-install 原样丢给用户',
  /不确定|无法确认|不能确认/.test(m.describeManagerFailure('ambiguous-install', 'ambiguous-install')) &&
  m.describeManagerFailure('bundle-in-use', '').length > 8 &&
  m.describeManagerFailure('某个没见过的码', '未知诊断').includes('未知诊断'),
  String(m.describeManagerFailure('ambiguous-install', 'ambiguous-install')))
/* 3) 翻译留痕：生成阶段的失败原因不能被应用阶段的 needs-catalog 覆盖；needs-catalog 必须出现在计数里 */
const trMixed = m.normalizeTranslateRun({
  action: 'optimize',
  message: '新生成 0 条，应用 1 项，待补文案 1 个，失败 1 个',
  items: [
    { pkg: 'a', state: 'failed', message: '模型返回无法解析为约定 JSON（已自动重试 1 次）' },
    { pkg: 'a', state: 'needs-catalog', message: '已安装但缺少精炼文案' },
    { pkg: 'b', state: 'generated', message: '已写入覆盖层' },
    { pkg: 'b', state: 'applied', message: '已写入 locale/zh.json' },
  ],
})
check('[翻译] 生成失败原因与应用阶段结论同时留在记录里（一个包两条，各自可见）',
  trMixed.items.filter((it) => it.pkg === 'a').length === 2 &&
  trMixed.items.some((it) => it.state === 'failed' && it.message.includes('无法解析')), JSON.stringify(trMixed.items))
check('[翻译] needs-catalog 计入独立计数（原来既不算失败也不算跳过，条目在计数里凭空消失）',
  trMixed.needsCatalog === 1 && trMixed.failed === 1 && trMixed.generated === 1 && trMixed.applied === 1, JSON.stringify(trMixed))
check('[翻译] 文案里的数字与宿主数出来的计数一致（不再自相矛盾）',
  trMixed.message.indexOf('应用 1 项') >= 0 && trMixed.message.indexOf('失败 1 个') >= 0 &&
  trMixed.applied === 1 && trMixed.failed === 1)
process.env.DSH_HOME = savedHomeT
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
check('技能 GitHub 来源规范化为可打开地址且不带凭据',
  m.normalizeRepoUrl('git@github.com:owner/repo.git') === 'https://github.com/owner/repo' &&
  m.normalizeRepoUrl('https://token@github.com/owner/repo.git') === 'https://github.com/owner/repo')
check('来源规范化支持 GitLab、自建 Git 与非标准端口',
  m.normalizeRepoUrl('ssh://git@gitlab.example.com:8443/team/repo.git') === 'https://gitlab.example.com:8443/team/repo' &&
  m.normalizeRepoUrl('https://user:token@gitlab.example.com:8443/team/repo.git?x=1#frag') === 'https://gitlab.example.com:8443/team/repo')
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
// 完成处理现在是 async（收尾要做一次变化提示查询），所以给足等待
await new Promise((r) => setTimeout(r, 800))
const jr = m.updateJobStatus(started.token)
check('轮询到 done 且状态可解释（版本未变不再假报成功）', jr.ok === true && jr.job.done === true && jr.job.state === 'unchanged' && jr.job.ok === false, JSON.stringify(jr))
check('installBundle 收到的 spec 正确', seenSpecs.includes('pkg-with-exports@latest'), JSON.stringify(seenSpecs))
const gitStarted = m.startUpdate(ctxWithPM, sandbox, 'pkg-git')
check('startUpdate 对 git 依赖用 git spec', gitStarted.ok === true && gitStarted.plan.spec === 'github:owner/repo', JSON.stringify(gitStarted))
await new Promise((r) => setTimeout(r, 800))
check('未知 token 优雅报错', m.updateJobStatus('nope').ok === false)
// 失败路径
const failPM = { listBundles: () => [], installBundle: () => Promise.reject(new Error('boom')) }
const started2 = m.startUpdate({ get: () => failPM }, sandbox, 'pkg-with-exports')
await new Promise((r) => setTimeout(r, 700))
const jr2 = m.updateJobStatus(started2.token)
check('安装失败时 stage=failed 且带原因', jr2.ok && jr2.job.done === true && jr2.job.ok === false && jr2.job.message === 'boom', JSON.stringify(jr2))
// 第一方 pluginManager 的 change() 会把失败封装为 resolved application=failed，不能被当成 unchanged。
const wrappedFailPM = {
  listBundles: () => [],
  installBundle: () => Promise.resolve({ application: 'failed', error: { code: 'operation-error', diagnostic: 'pnpm failed' }, packageResult: { output: 'network denied' } }),
}
const started3 = m.startUpdate({ get: () => wrappedFailPM }, sandbox, 'pkg-with-exports')
await new Promise((r) => setTimeout(r, 700))
const jr3 = m.updateJobStatus(started3.token)
check('管理器 resolved application=failed 时仍报告 failed（不误报未变化）',
  jr3.ok && jr3.job.done === true && jr3.job.state === 'failed' && jr3.job.message.includes('pnpm failed'), JSON.stringify(jr3))
const incompatibleSinglePM = { listBundles: () => [], installBundle: async () => ({ application: 'failed', error: { code: 'incompatible-version', incompatible: [{ name: 'pkg-with-exports', version: '2.0.0', runtimeVersion: '0.2.0-rc.1' }] } }) }
const started4 = m.startUpdate({ get: () => incompatibleSinglePM }, sandbox, 'pkg-with-exports')
await new Promise((r) => setTimeout(r, 700))
const jr4 = m.updateJobStatus(started4.token)
check('单项更新保留管理器错误码与 application', jr4.ok && jr4.job.code === 'incompatible-version' && jr4.job.application === 'failed', JSON.stringify(jr4))
const delayedPM = { listBundles: () => [], installBundle: () => new Promise((resolve) => setTimeout(() => resolve({}), 400)) }
const delayedSingle = m.startUpdate({ get: () => delayedPM }, sandbox, 'pkg-with-exports')
const blockedBatchDuringSingle = m.startUpdateAll({ get: () => delayedPM }, sandbox, ['pkg-with-exports'])
check('单项进行中时批量更新被互斥锁拒绝', delayedSingle.ok && blockedBatchDuringSingle.ok === false && blockedBatchDuringSingle.code === 'update-busy', JSON.stringify(blockedBatchDuringSingle))
await new Promise((r) => setTimeout(r, 900))
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
// 真机 bug（v2.7.0 实测）：宿主半体 inject = []，代码却直接读 ctx.llm →
// Cordis 抛 'cannot get property "llm" without inject'，于是「翻译优化」一次都没真正调用过模型
// （实测证据：POST /generate-skill 返回该 message，且 skill-catalog.local.json 从未生成）。
// 这里用 Proxy 复刻 Cordis 的属性访问语义：未 inject 的服务名一读就抛。
const cordisLike = (services) => new Proxy({
  get: (n) => services[n],
}, {
  get(target, key) {
    if (key === 'llm' || key === 'settings' || key === 'skills' || key === 'pluginManager') {
      throw new Error('cannot get property "' + String(key) + '" without inject')
    }
    return target[key]
  },
})
const strictPluginCtx = cordisLike({ llm: fakeStreamLlm, settings: { read: async () => ({ provider: 'p', model: 'm' }) } })
const genStrict = await m.generateRefinement(strictPluginCtx, 'dsh-x', 'some english')
check('Cordis 语义（未 inject）下也能生成 —— 修掉 cannot get property "llm" without inject', genStrict.ok === true, JSON.stringify(genStrict))
const skillJson = '{"zhName":"demo（甲）","description":"触发X → 做什么与不做什么"}'
const strictSkillCtx = cordisLike({ llm: { stream: () => [{ type: 'text-delta', text: skillJson }] }, settings: { read: async () => ({ provider: 'p', model: 'm' }) } })
const genSkillStrict = await m.generateSkillRefinement(strictSkillCtx, 'demo', 'EN desc')
check('技能侧生成同样不再依赖 ctx.llm 直读', genSkillStrict.ok === true, JSON.stringify(genSkillStrict))
check('llmOf / settingsOf：未注册时返回 undefined 而不抛错', m.llmOf({ get: () => undefined }) === undefined && m.settingsOf({ get: () => undefined }) === undefined)
check('llmOf：属性读取抛错时仍能取到服务（属性直读只作测试替身兜底）', m.llmOf(cordisLike({ llm: { stream: () => [] } })) !== undefined)
check('宿主：不再有裸读 ctx.llm 的调用点', !/await ctx\.llm|ctx\.llm\.stream/.test(fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')))
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
check('单一数据源：snapshot 按页二选一，只用这两个端点', /call\(IS_SKILL \? 'skills' : 'updates'/.test(snapshotBody) && !snapshotBody.includes("call('status'"), snapshotBody.slice(0, 130).replace(/\s+/g, ' '))
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
// A6b：功能性按钮的统一规则（用户要求：不可用要「暗下去、无法点击」；两页同一套逻辑）
check('按钮：不可用即暗下去（两页共用一个 opBtn）',
  clientSrc.includes('function opBtn(') && clientSrc.includes("off: { opacity: 0.45, cursor: 'default' }") &&
  clientSrc.includes('onClick: off ? undefined : onClick') && clientSrc.includes('disabled: !!off'))
check('按钮：翻译优化 / 还原翻译 无待办时禁用（插件页与技能页同一判定）',
  clientSrc.includes('var noOptimize = noRows || s.toApply === 0') &&
  clientSrc.includes('var noRevert = noRows || s.refined === 0') &&
  clientSrc.includes("opBtn('opt'") && clientSrc.includes("opBtn('rev'"))
check('按钮：一键更新在无待更新或本轮已完成时禁用',
  clientSrc.includes('var noUpdate = noRows || updatable === 0 || batchSettled') && clientSrc.includes("opBtn('all'"))
check('按钮：更新完成后按结果暗下去（不是消失），刷新才重新判定',
  clientSrc.includes('var OUTCOME =') && clientSrc.includes('function outcomeLabel(') &&
  clientSrc.includes("n[pkg] = { state: res.state || (res.ok ? 'updated' : 'failed')") && clientSrc.includes('absorbBatch(b)') &&
  clientSrc.includes('setDone(carry)') && clientSrc.includes('setBatchSettled'))
check('按钮：行内不再有「可点但点了没用」的更新按钮', !clientSrc.includes("op.push(h('button', { key: 'u'"))
// ── A5b：本轮结果 / 行锁口径（用户报告「状态栏说完成、行里还能点更新」） ──
check('口径：批量记录与行锁是同一份状态，且页面自己讲明差异',
  clientSrc.includes('function lockNote(') && clientSrc.includes('不再约束下表') &&
  clientSrc.includes('锁定保鲜期') && clientSrc.includes('var LOCK_MS = 10 * 60 * 1000'))
check('口径：记录仍在、锁已超期时只作记录（旧实现把记录与锁一起按 10 分钟处理，超期后只留下矛盾）',
  clientSrc.includes("if (fresh) absorbBatch(b); else absorbResults('update', b.items)"))
check('口径：批量 / 单行 / 技能三种更新都会置位本轮锁定（否则一键更新与行锁互相打脸）',
  (clientSrc.match(/setBatchSettled\(true\)/g) || []).length >= 3 && clientSrc.includes('setBatchSettled(fresh)'))
check('本轮结果：逐项结果贴回对象行 + 失败码给出下一步动作（修「状态栏红色、功能状态未知」）',
  clientSrc.includes('var ACTION_TEXT =') && clientSrc.includes('fixOf(it.code)') &&
  clientSrc.includes('var recordChip =') && !clientSrc.includes('function ResultsPanel('))
check('显示密度：行内单行（nowrap + 省略号）+ 悬停详情槽 + 更新状态 chip',
  /\.das-table td \{[^}]*white-space: nowrap/.test(clientSrc) && clientSrc.includes('className: \'das-hover\'') &&
  clientSrc.includes('onMouseEnter') && clientSrc.includes("'已最新'") && clientSrc.includes("'不可比'"))
check('口径：中断的批量不得被说成「已完成」',
  clientSrc.includes("'已中断（未完成）'") && clientSrc.includes('没有完成时间') && clientSrc.includes('未跑完'))
/* ── 用户要求：每行太高、可见对象太少、不要横向拉条（点「横向拉条」会把其它列推出视野） ──
   契约：固定 26px 行高 + 每列一个 nowrap 的 .das-cell + 表格有宽度上限 + 面板根 min-width:0。 */
check('[密度] 列表是单行紧凑表格：26px 行高 + 每列一个 nowrap 的 .das-cell + 无横向溢出',
  /\.das-table td \{[^}]*height: 26px/.test(clientSrc) &&
  /\.das-cell \{[^}]*flex-wrap: nowrap/.test(clientSrc) &&
  /\.das-wrap \{ overflow-x: hidden/.test(clientSrc) &&
  /\.das-table \{[^}]*max-width: 100%/.test(clientSrc) &&
  /\.das-root\s*\{[^}]*min-width: 0/.test(clientSrc))
check('[密度] 展开入口并进状态 chip：行内不再有块级 div、也不再有「展开」按钮与常驻提示',
  clientSrc.includes("h('span', { className: 'das-cell'") && clientSrc.includes('function chipBtn(') &&
  !clientSrc.includes('das-row-hint') && !/h\('div', \{ className: 'das-desc-line'/.test(clientSrc) &&
  !clientSrc.includes("'展开 ' + (issues.length + findings.length)"))
check('口径：只有真拿到逐项结果才置位行锁（避免「一键更新已禁用、行锁却不存在」）',
  (clientSrc.match(/items\.length > 0\) \{ setBatchSettled\(true\); setLockedAt\(Date\.now\(\)\); absorbBatch\(/g) || []).length >= 1 &&
  clientSrc.includes('if (bb && Array.isArray(bb.items) && bb.items.length > 0)'))
// ── A5c：对抗复查抓到的两条（都在口径文案里，且都靠「反推」产生） ──
check('口径：刷新释放行锁不得被说成「超期」（released 与 expired 必须分开）',
  clientSrc.includes("reason === 'released'") && clientSrc.includes("reason === 'expired'") &&
  clientSrc.includes('主动释放了行锁'))
check('口径：行锁时间取自锁本身，不借用批量记录的完成时间（否则「刚刚完成」与「已中断」同屏打架）',
  clientSrc.includes('var lockedAtState = useState(0)') && clientSrc.includes('setLockedAt(Date.now())') &&
  clientSrc.includes("(lockedAt > 0 ? agoText(lockedAt) : '刚刚')"))
check('口径：原因由 Panel 显式判定（lockReason），不让 lockNote 靠 finishedAt 反推',
  clientSrc.includes("var lockReason = 'session'") && clientSrc.includes("lockReason = 'released'") &&
  clientSrc.includes("lockReason = 'expired'") && clientSrc.includes("lockReason = 'interrupted'"))
check('轮询失败必须退避重试（一次抖动就放开按钮会导致并发安装）',
  clientSrc.includes('var POLL_RETRY_MAX =') && clientSrc.includes('pollBatch(tries + 1)') &&
  clientSrc.includes('已停止轮询'))
check('技能更新：宿主静默过滤掉的对象要如实补一条失败说明（而不是「点了没反应」）',
  clientSrc.includes('宿主没有回应该技能'))
check('宿主：批量进行中时单包更新被拒绝（batch-running，避免两条 pnpm 并发）',
  /code: 'batch-running'/.test(fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')) && clientSrc.includes("c === 'batch-running'"))
check('本轮结果：每个失败码都有对应的下一步动作', clientSrc.includes("c === 'generate-failed'") && clientSrc.includes('fixOf(it.code)'))
check('技能版本列：version → git 提交号 → 未声明 的回落链，不留「—」',
  clientSrc.includes('function skillRevision(') && clientSrc.includes("'git ' + shortShaOf(r.localSha)") && clientSrc.includes("'未声明'"))
check('技能来源：来源信息进 title 与悬停卡（版本列不再放来源标签）',
  clientSrc.includes("'来源：'") && clientSrc.includes('sourceUrl') && !clientSrc.includes("target: '_blank'"))
check('显示密度：指标收成一条紧凑数据带 + 插件表固定布局且无横向滚动',
  clientSrc.includes('.das-stats {') && clientSrc.includes('function kpiStat(') &&
  !clientSrc.includes('minmax(94px') && clientSrc.includes('position: sticky') && clientSrc.includes('.das-wrap') && clientSrc.includes('overflow-x: hidden') && clientSrc.includes('table-layout: fixed'))
check('样式命名空间化，只用 DSH token 并带回落（亮/暗主题都跟随）',
  clientSrc.includes('--dsw-alias-border-l1,') && clientSrc.includes('--dsw-font-mono,') && clientSrc.includes('prefers-reduced-motion'))
// ── A5d：翻译优化的「留痕 + 自愈」（用户两次追问「我明明点过翻译优化，为什么还是待应用/待生成」） ──
check('留痕：一次运行的结果会上报宿主落盘，下次刷新可回看',
  clientSrc.includes("call('translate-run'") && clientSrc.includes('var recordTranslate = useCallback(') &&
  clientSrc.includes("recordTranslate('optimize'") && clientSrc.includes("'translate' in r"))
check('留痕：行内标上次失败、悬停槽给该项的上次结果、指标带给上次时间',
  clientSrc.includes("'上次失败'") && clientSrc.includes("上次翻译优化") && clientSrc.includes("上次优化"))
check('自愈：catalog 有条目但文件不在盘上时自动补 apply，且只对插件页、每次挂载只做一次',
  clientSrc.includes('r.inCatalog === true && r.localized !== true') &&
  clientSrc.includes('if (IS_SKILL || healed || rows === null) return') &&
  clientSrc.includes("recordTranslate('auto-apply'"))
check('自愈不污染「本轮结果」（自愈不是用户点的动作）',
  !/recordTranslate\('auto-apply'[\s\S]{0,300}?absorbResults\(/.test(clientSrc))
check('无表情符号（gpt-tasteskill 硬规则：不得使用 emoji）',
  (clientSrc.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu) || []).length === 0,
  (clientSrc.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu) || []).join(''))
check('客户端：中文名优先展示对**两个视图**都生效（技能侧同样拆开）',
  clientSrc.includes('var zhName = zhNameOf(r.displayName, r.pkg);') && clientSrc.includes('function zhNameOf('))
check('客户端：首屏第一句讲价值（不是命名约定），机制说明退到 title',
  clientSrc.includes('把插件的英文标题与说明精炼成中文') && clientSrc.includes('Plugins 页会直接显示中文') &&
  clientSrc.includes('命名约定：标题保留原包名'))
check('客户端：宿主太旧时解释「为什么没有中文名」（区分宿主未提供 / 条目本来没有）',
  clientSrc.includes('重启 DSH 后才能看到插件的中文名与说明') && clientSrc.includes('未提供中文名') && clientSrc.includes('该条目没有中文名'))
// ── A5e：内置 catalog 中文快照（旧宿主兜底）+ 漂移闸门 ──
// 宿主 <2.9 的插件行不发 displayName/localizedDescription（2.8.0 的 index.js 里 displayName 只在技能行），
// 所以客户端内联一份仓库内置 catalog 的中文快照；这里校验它与 catalog 文件**逐条一致**，防止漂移。
{
  const catJson = JSON.parse(fs.readFileSync(path.join(REPO, 'references', 'dsh-plugin-locale-catalog.json'), 'utf8'))
  const entries = (catJson.entries || []).filter((e) => e && e.zh && typeof e.zh.title === 'string')
  const blockSrc = clientSrc.slice(clientSrc.indexOf('var CATALOG_ZH = {'), clientSrc.indexOf('/* @catalog-snapshot:end */'))
  const missing = entries.filter((e) => !blockSrc.includes(JSON.stringify(e.pkg) + ': ' + JSON.stringify([e.zh.title, e.zh.description || '']) + ','))
  check('客户端内联的 catalog 中文快照与 references/dsh-plugin-locale-catalog.json 逐条一致（无漂移）',
    blockSrc !== '' && missing.length === 0,
    '缺失/不一致 ' + missing.length + '/' + entries.length + '：' + missing.map((e) => e.pkg).join(','))
  check('快照注入脚本存在且支持 --check（漂移时的修复入口）',
    fs.existsSync(path.join(REPO, 'scripts', 'build-client-catalog.mjs')) &&
    fs.readFileSync(path.join(REPO, 'scripts', 'build-client-catalog.mjs'), 'utf8').includes('--check'))
  check('快照只在「宿主没给中文名」且「这一行中文确实已落盘」时才用（不误导待应用的行）',
    clientSrc.includes('var snap = zhName === \'\' ? catalogZh(r.pkg) : null;') &&
    clientSrc.includes('var useSnap = snap !== null && r.localized === true;') &&
    clientSrc.includes('function catalogZh(pkg)'))
  check('快照来源被如实标注（悬停槽写明来自客户端内置快照）',
    clientSrc.includes('来自客户端内置快照'))
}
check('客户端：本插件自己的行也用中文名（客户端就是它自己，不必等宿主提供）',
  clientSrc.includes("var OWN_PKG = 'dsh-audit-skills';") &&
  clientSrc.includes("if (zhName === '' && r.pkg === OWN_PKG) zhName = LABEL;") &&
  clientSrc.includes("· 本插件自身"))
check('冒烟支持 --live：用真实线上快照渲染真客户端（无浏览器时的端到端证据）', (() => {
  const smokeSrc = fs.readFileSync(path.join(REPO, 'scripts', 'render-smoke.mjs'), 'utf8')
  return smokeSrc.includes("process.argv.includes('--live')") && smokeSrc.includes('【LIVE】') &&
    smokeSrc.includes('api/dsh-audit-skills/updates')
})())
const updateAllBody = clientSrc.slice(clientSrc.indexOf('var updateAll ='), clientSrc.indexOf('var s = rows ?'))
check('客户端不再自己跑更新循环（改由宿主侧执行）', updateAllBody.includes("call('update-all'") && updateAllBody.includes('pollBatch') && !updateAllBody.includes('var step = function'))
const idxSrcA5 = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')
const loopAt = idxSrcA5.indexOf('for (let i = 0; i < items.length; i += 1)')
const loopAround = loopAt > 0 ? idxSrcA5.slice(Math.max(0, loopAt - 2000), loopAt + 2000) : ''
check('宿主：插件批量更新串行（循环内 await installAndWait，且附近无 Promise.all）', loopAt > 0 && loopAround.includes('await installAndWait') && !loopAround.includes('Promise.all'))
check('汇总行由 rows 派生（与表格同源）', clientSrc.includes('function summarize(rows, isSkill)') && clientSrc.includes('summarize(rows, IS_SKILL)'))
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
check('行：带展示中文名与优化说明字段', rowRows.every((r) => Object.hasOwn(r, 'displayName') && Object.hasOwn(r, 'localizedDescription')), JSON.stringify(Object.keys(rowRows[0] || {})))
check('行：两条路径共用同一构造函数（含 inCatalog 字段）', 'inCatalog' in (rowRows[0] || {}))
const readonlyRows = m.collectStatusViaService({ get: () => ({ listBundles: () => [
  { name: 'dsh-base', installed: true, enabled: true, version: '9.0.0', readOnlyReason: 'unaddressable' },
  { name: 'managed-plugin', installed: true, enabled: true, version: '1.0.0', readOnlyReason: 'management-required' },
  { name: '@deepseek-ai/dsh-experimental-auto-review', installed: false, enabled: true, version: '9.0.0' },
] }) }, [rowSandbox])
const bundledPlugin = readonlyRows && readonlyRows.find((r) => r.pkg === 'dsh-base')
const managedPlugin = readonlyRows && readonlyRows.find((r) => r.pkg === 'managed-plugin')
const bundledOfficial = readonlyRows && readonlyRows.find((r) => r.pkg === '@deepseek-ai/dsh-experimental-auto-review')
check('只读内置 bundle 不进入待生成文案', !!bundledPlugin && bundledPlugin.bundled === true && bundledPlugin.translationEligible === false && bundledPlugin.needsText === false, JSON.stringify(bundledPlugin))
check('宿主管理对象不进入翻译优化', !!managedPlugin && managedPlugin.readOnlyReason === 'management-required' && managedPlugin.translationEligible === false && managedPlugin.needsText === false, JSON.stringify(managedPlugin))
check('未安装的官方 bundle 即使无 readOnlyReason 也不进入待生成文案', !!bundledOfficial && bundledOfficial.bundled === true && bundledOfficial.translationEligible === false && bundledOfficial.needsText === false, JSON.stringify(bundledOfficial))
check('只读对象不生成 needs-text 审查问题', m.describeIssues(Object.assign({}, bundledPlugin, { latest: null })).length === 0)
const incompatibleRows = m.collectStatusViaService({ get: () => ({ listBundles: () => [
  { name: '@wenaixi/dsh-ponytail', installed: true, enabled: true, version: '4.9.0-dsh.5', error: {
    code: 'incompatible-version',
    message: 'Plugin @wenaixi/dsh-ponytail@4.9.0-dsh.5 is incompatible with dsh 0.2.0-rc.1',
    incompatible: [{ name: '@deepseek-ai/dsh-skill', range: '^0.1.1-rc.2', runtimeVersion: '0.2.0-rc.1' }],
    peerDependencies: { '@deepseek-ai/dsh-skill': '^0.1.1-rc.2' },
  } },
] }) }, [rowSandbox])
const incompatibleRow = incompatibleRows && incompatibleRows[0]
const incompatibleIssues = incompatibleRow ? m.describeIssues(Object.assign({}, incompatibleRow, { latest: null })) : []
check('宿主兼容性错误保留错误码和原始诊断', !!incompatibleRow && incompatibleRow.errorCode === 'incompatible-version' && /0\.2\.0-rc\.1/.test(incompatibleRow.errorMessage) && incompatibleRow.incompatible.length === 1, JSON.stringify(incompatibleRow))
check('宿主跳过 bundle 时回填本地版本', !!incompatibleRow && incompatibleRow.version === '4.9.0-dsh.5', JSON.stringify(incompatibleRow))
check('启动被跳过的插件给出兼容性处理建议', incompatibleIssues.some((x) => x.code === 'incompatible-version' && /停用/.test(x.remedy) && /0\.2\.0-rc\.1/.test(x.reason)), JSON.stringify(incompatibleIssues))
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
const blockedSingle = m.startUpdate(noMgrCtx, sandbox, 'pkg-with-exports')
check('批量进行中时单包更新被拒绝（否则两条 pnpm 并发改同一个 profile）',
  blockedSingle.ok === false && blockedSingle.code === 'batch-running', JSON.stringify(blockedSingle))
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
check('结束语区分 成功/未变化/失败', /成功 \d+ 个，未变化 \d+ 个(?:，待确认 \d+ 个)?，失败 \d+ 个/.test(String(m.updateAllStatus().message)), String(m.updateAllStatus().message))
// 第一方可能重新物化 lockfile / 依赖树，但 package.json 的 version 不变；changed=true 代表更新确实落盘。
const sameVersionPM = { listBundles: () => [], installBundle: async () => ({ changed: true, application: 'restart-required' }) }
m.startUpdateAll({ get: (n) => (n === 'pluginManager' ? sameVersionPM : undefined) }, sandbox, ['pkg-with-exports'])
await new Promise((r) => setTimeout(r, 1500))
const itemD = (m.updateAllStatus().items || []).find((x) => x.pkg === 'pkg-with-exports')
check('管理器 changed=true 且版本字段不变 -> 记录为 updated 而非 unchanged', !!itemD && itemD.state === 'updated' && itemD.versionUnchanged === true, JSON.stringify(itemD))
check('同版本重新物化结果要求重启确认', !!itemD && /重启 DSH/.test(String(itemD.message)), JSON.stringify(itemD))
const incompatiblePM = { listBundles: () => [], installBundle: async () => ({ application: 'failed', error: { code: 'incompatible-version', incompatible: [{ name: 'pkg-with-exports', version: '2.0.0', runtimeVersion: '0.2.0-rc.1' }] } }) }
m.startUpdateAll({ get: (n) => (n === 'pluginManager' ? incompatiblePM : undefined) }, sandbox, ['pkg-with-exports'])
await new Promise((r) => setTimeout(r, 1500))
const itemE = (m.updateAllStatus().items || []).find((x) => x.pkg === 'pkg-with-exports')
check('管理器兼容性拒绝 -> 记录为 failed 且保留错误码', !!itemE && itemE.state === 'failed' && itemE.code === 'incompatible-version' && /0\.2\.0-rc\.1/.test(String(itemE.message)), JSON.stringify(itemE))
check('管理中心仅对存在备份的技能显示还原能力', idxSrc.includes('canRollback: item.translationEligible !== false && typeof item.skillPath === \'string\'') && idxSrc.includes('hasAnyBackup(item.skillPath)'), 'canRollback 必须与实际备份绑定')
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
await new Promise((r) => setTimeout(r, 5000))
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
check('客户端：优化后的中文名显示在插件名称位置（中文名优先、原包名次级）',
  clientSrc.includes('das-name-main') && clientSrc.includes('function zhNameOf(') &&
  clientSrc.includes('das-name-pkg') && clientSrc.includes('das-desc-line') && clientSrc.includes('primaryName'))
check('客户端：审查只把「需处置」的计入数字与筛选，低置信推断降噪',
  clientSrc.includes('notableInferred') && clientSrc.includes('lowInferred') &&
  clientSrc.includes("f.severity !== 'low'") && clientSrc.includes('暂无需处置'))
check('客户端：窄容器用容器查询收起次级包名（不是靠视口宽度）',
  clientSrc.includes('container-type: inline-size') && clientSrc.includes('@container (max-width: 820px)'))
check('客户端：优化列显示已落盘的中文说明', clientSrc.includes('das-optimized-copy') && clientSrc.includes('r.localizedDescription'))
check('客户端：更新结果透传管理器错误码与同版本重装标记', clientSrc.includes('job.code ||') && clientSrc.includes('versionUnchanged') && clientSrc.includes("incompatible-version"))
check('客户端：全部已优化时直接返回不做事', clientSrc.includes('均已优化，无需处理'))
check('客户端：表格已去掉「启用」列', !clientSrc.includes("'启用'"))
check('客户端：精炼措辞已改为优化', !clientSrc.includes('已精炼') && !clientSrc.includes('待精炼') && clientSrc.includes("'已优化'"))
check('客户端：三态标签齐全（已优化/待应用/待生成文案）', clientSrc.includes("'已优化'") && clientSrc.includes("'待应用'") && clientSrc.includes("'待生成文案'"))

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
// 非法 name 真因必须作为事实级发现出现，不能继续被“全绿”掩盖。
const invalidName = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-invalid-name-'))
fs.mkdirSync(path.join(invalidName, 'node_modules', 'bad-plugin'), { recursive: true })
fs.writeFileSync(path.join(invalidName, 'package.json'), JSON.stringify({ name: 'invalid-audit', dependencies: { 'bad-plugin': '1.0.0' }, dsh: { profile: { bundles: ['bad-plugin'] } } }, null, 2))
fs.writeFileSync(path.join(invalidName, 'node_modules', 'bad-plugin', 'package.json'), JSON.stringify({ name: 'Bad Plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2))
fs.writeFileSync(path.join(invalidName, 'node_modules', 'bad-plugin', 'cordis.patch.yml'), '- id: bad-row')
const invalidCtx = { get: (name) => name === 'pluginManager' ? { listBundles: () => [{ name: 'bad-plugin', installed: true, enabled: true, version: '1.0.0' }] } : undefined }
m.clearAuditCache()
const invalidAudit = m.auditPackages(invalidCtx, invalidName)
check('审查：非法 package.json name 以事实级问题出现', invalidAudit.findings.some((f) => f.pkg === 'bad-plugin' && f.title.includes('package.json 的 name 非法') && f.confidence === 'fact'), JSON.stringify(invalidAudit.findings.filter((f) => f.pkg === 'bad-plugin').map((f) => f.title)))
check('审查：非法 name 不会被全绿 KPI 隐藏', invalidAudit.counts.high >= 1 && invalidAudit.actionable >= 1, JSON.stringify(invalidAudit.counts))
fs.rmSync(invalidName, { recursive: true, force: true })
m.clearAuditCache()
const auditedCached = m.auditPackages({ get: () => undefined }, auditRoot)
check('审查缓存：第二次命中同一对象', m.auditPackages({ get: () => undefined }, auditRoot) === auditedCached)
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
check('客户端：审查并入刷新，无独立按钮', /call\(IS_SKILL \? 'skills' : 'updates'/.test(clientSrc) && !clientSrc.includes("'安全审查'"))
check('客户端：事实/推断分组展示', clientSrc.includes('另有 ') && clientSrc.includes('仅供知悉'))
check('客户端：严重度用文字而非仅颜色', clientSrc.includes("high: '高'") && clientSrc.includes("medium: '中'"))
check('客户端：提供忽略入口', clientSrc.includes("call('ignore'") && clientSrc.includes('忽略此条'))

// ─────────────────────── A11 技能页（与插件页同构） ───────────────────────
console.log(String.fromCharCode(10) + 'A11 技能页规则')
check('技能 frontmatter 解析：正常字段', (function () { const f = m.parseSkillFrontmatter(['---', 'name: demo', 'description: 一段说明', 'version: 1.2.3', '---', 'body'].join(String.fromCharCode(10))); return f.present && f.fields.name === 'demo' && f.fields.version === '1.2.3' })())
check('技能 frontmatter 解析：块标量续行会拼接', (function () { const f = m.parseSkillFrontmatter(['---', 'description: 第一行', '  第二行', '---'].join(String.fromCharCode(10))); return f.fields.description === '第一行 第二行' })())
check('技能 frontmatter 缺失时 present=false', m.parseSkillFrontmatter('没有 frontmatter').present === false)
check('描述语言：纯英文', m.descriptionLanguage('This is an English only description') === '英文')
check('描述语言：纯中文', m.descriptionLanguage('这是一段纯中文说明') === '中文')
check('描述语言：中英混合', m.descriptionLanguage('使用 skill 完成任务的一套方法论框架') === '中文为主')
check('描述语言：空', m.descriptionLanguage('   ') === '空')
const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'))
const dshHome = path.join(skillRoot, 'dsh')
const agentsHome = path.join(skillRoot, 'agents')
const skHi = path.join(dshHome, 'skills')
const skLo = path.join(agentsHome, 'skills')
const mkSkill = (base, dir, frontmatter) => {
  fs.mkdirSync(path.join(base, dir), { recursive: true })
  fs.writeFileSync(path.join(base, dir, 'SKILL.md'), frontmatter)
}
mkSkill(skHi, 'demo-good', ['---', 'name: demo-good', 'description: 中文说明', 'version: 0.1.0', '---', 'body'].join(String.fromCharCode(10)))
mkSkill(skHi, 'demo-nofm', 'no frontmatter here')
mkSkill(skHi, 'demo-mismatch', ['---', 'name: another-name', 'description: 中文', '---'].join(String.fromCharCode(10)))
mkSkill(skHi, 'demo-nodesc', ['---', 'name: demo-nodesc', 'description:', '---'].join(String.fromCharCode(10)))
mkSkill(skHi, path.join('demo-nested', 'modes', 'inner'), ['---', 'name: inner', '---'].join(String.fromCharCode(10)))
mkSkill(skHi, 'demo-nested', ['---', 'name: demo-nested', 'description: 中文', '---'].join(String.fromCharCode(10)))
fs.writeFileSync(path.join(skHi, 'demo-flat.md'), ['---', 'name: demo-flat', 'description: English only', '---'].join(String.fromCharCode(10)))
mkSkill(skLo, 'demo-good', ['---', 'name: demo-good', 'description: 低优先级那份', '---'].join(String.fromCharCode(10)))
// 明确回归：历史归档项与 Codex/ZCode 外部项不能进入 DSH 管理范围。
for (const archived of ['ponytail', 'skillopt', 'skills-summarize-audit']) {
  mkSkill(skHi, archived, ['---', 'name: ' + archived, 'description: archived', '---'].join(String.fromCharCode(10)))
}
for (const external of ['codex-only', 'zcode-only']) {
  mkSkill(skLo, external, ['---', 'name: ' + external, 'description: external', '---'].join(String.fromCharCode(10)))
}
const savedHome6 = process.env.DSH_HOME
const savedAgentsHome = process.env.DSH_AGENTS_HOME
process.env.DSH_HOME = dshHome
process.env.DSH_AGENTS_HOME = agentsHome
const skRows = m.collectSkills({ get: () => undefined, includeExternalSkills: true })
const byName2 = new Map(skRows.map((r) => [r.pkg, r]))
const scopedSkillRows = m.collectSkills({ get: () => undefined })
check('技能范围：归档 ponytail/skillopt/skills-summarize-audit 永不入表', ['ponytail', 'skillopt', 'skills-summarize-audit'].every((name) => !scopedSkillRows.some((r) => r.pkg === name)))
/* 本机证据：DSH 内核把 `agentsHome = config.agentsHome ?? DSH_AGENTS_HOME ?? ~/.agents` 当技能根，
   而本机 `~/.dsh/skills` 根本不存在、9 个技能全在 `~/.agents/skills`（正是会话里可用的那批）。
   把 rank 500 一律排除 = 技能页永远为空（实测 /skills 返回 0 行）。所以默认纳入，rank 只决定同名优先级。 */
check('技能范围：DSH agentsHome 技能根（rank 500）默认纳入 —— 它就是本机技能库',
  ['codex-only', 'zcode-only'].every((name) => scopedSkillRows.some((r) => r.pkg === name)), JSON.stringify(scopedSkillRows.map((r) => r.pkg)))
check('技能扫描：目录形态被发现', byName2.has('demo-good'))
check('技能扫描：顶层 .md 形态被发现', byName2.has('demo-flat'))
check('技能扫描：name 取 frontmatter 而非目录名', byName2.has('another-name') && !byName2.has('demo-mismatch'))
check('技能扫描：版本可读', (byName2.get('demo-good') || {}).version === '0.1.0')
check('遮蔽：取高优先级那份（rank 400）', (byName2.get('demo-good') || {}).skillPath.includes(path.join('dsh', 'skills')))
check('遮蔽：记录了低优先级那份', ((byName2.get('demo-good') || {}).shadowed || []).length === 1)
const skFind = m.auditSkills(skRows)
const hasF = (pkg, kw) => skFind.some((f) => f.pkg === pkg && f.title.includes(kw))
check('S1：缺 frontmatter -> 事实级高', hasF('demo-nofm', '缺少 frontmatter') && skFind.find((f) => f.pkg === 'demo-nofm').severity === 'high')
check('S2：name 与目录名不一致 -> 报出', hasF('another-name', '不一致'))
check('S3：description 为空 -> 报出', hasF('demo-nodesc', '为空'))
check('S4：嵌套 SKILL.md 不会被发现 -> 报出', hasF('demo-nested', '不会被发现'))
check('S5：纯英文描述 -> 提示可读性且如实说明改写属行为变更', (function () { const f = skFind.find((x) => x.pkg === 'demo-flat'); return !!f && f.remedy.includes('行为变更') && f.remedy.includes('.dsh-skill.backup') })())
check('S6：同名被遮蔽 -> 事实级高', (function () { const f = skFind.find((x) => x.pkg === 'demo-good' && x.title.includes('遮蔽')); return !!f && f.severity === 'high' })())
check('demo-good 只报「被遮蔽」一条（无 frontmatter/名称/描述问题）', (function () { const g2 = skFind.filter((x) => x.pkg === 'demo-good'); return g2.length === 1 && g2[0].title.includes('遮蔽') })())
const withBundled = m.collectSkills({ includeExternalSkills: true, get: (n) => (n === 'skills' ? { list: () => [{ name: 'demo-good' }, { name: 'office-docx', provider: 'dsh' }] } : undefined) })
const bundledRow = withBundled.find((r) => r.pkg === 'office-docx')
check('随 DSH 提供的技能会入表并标注来源', !!bundledRow && bundledRow.source.includes('随 DSH 提供') && bundledRow.bundled === true)
/* 补齐路径判据放宽：DSH 技能服务列出即算（只排除明确标了外部工具来源的记录）。 */
const withUnlabeled = m.collectSkills({ get: (n) => (n === 'skills' ? { list: () => [{ name: 'demo-good' }, { name: 'office-docx' }] } : undefined) })
check('补齐：DSH 服务列出但没标 provider 的技能也入表（bundled，默认隐藏）',
  (withUnlabeled.find((r) => r.pkg === 'office-docx') || {}).bundled === true)
const withExternal = m.collectSkills({ get: (n) => (n === 'skills' ? { list: () => [{ name: 'codex-remote-only', provider: 'codex' }] } : undefined) })
check('补齐：明确标了外部工具来源（provider=codex）的技能不入表', !withExternal.some((r) => r.pkg === 'codex-remote-only'))
check('技能行提供作用说明与来源字段', !!(byName2.get('demo-good') || {}).purpose && Object.hasOwn(byName2.get('demo-good') || {}, 'sourceUrl'))

// ── A1d 宿主 ctx 注入守卫 ────────────────────────────────────────────────
// 实测：POST /api/dsh-audit-skills/skills 返回
//   {"ok":false,"message":"cannot get property \"includeExternalSkills\" without inject"}
// 原因：Cordis 上下文是注入式 proxy —— 读未注入的字段即抛；该行不在 try 内，
// 异常冒泡成整条路由失败（技能页与设置页同时显示「读取失败」）。
// 这里按宿主同一规则造一个会抛的 ctx，任何裸读都会立刻让测试变红。
const injectProxy = (provided) => new Proxy(provided, {
  get(target, prop) {
    if (typeof prop === 'symbol' || prop === 'prototype' || prop === 'then' || String(prop).startsWith('_')) return Reflect.get(target, prop)
    if (Reflect.has(target, prop)) return Reflect.get(target, prop)
    throw new Error('cannot get property "' + String(prop) + '" without inject')
  },
})
const hostCtx = injectProxy({ get: () => undefined })
const noThrow = (fn) => { try { fn(); return true } catch (error) { return 'threw: ' + String((error && error.message) || error) } }
check('宿主 ctx 守卫：collectSkills 读到未注入字段不再抛错', noThrow(() => m.collectSkills(hostCtx)) === true)
check('宿主 ctx 守卫：读不到注入字段时 rank 500 技能照样入表（不再整页为空）', (function () { try { return m.collectSkills(hostCtx).some((r) => r.pkg === 'codex-only') } catch { return false } })())
check('宿主 ctx 守卫：llmOf / settingsOf / getPluginManager 均不抛错', noThrow(() => m.llmOf(hostCtx)) === true && noThrow(() => m.settingsOf(hostCtx)) === true && noThrow(() => m.getPluginManager(hostCtx)) === true)
const hostSrc = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8')
const ctxProps = Array.from(new Set(Array.from(hostSrc.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g), (x) => x[1]))).sort()
/* llm / settings 允许出现在源码里（注释与错误文案会提到它们）；它们的**直读**是否安全
   由上面的注入式 proxy 运行时断言保证（裸读会当场抛错）。白名单外的任何新字段都会让这条变红。 */
check('宿主 ctx 守卫：没有白名单之外的新上下文裸读（llm/settings 由运行时断言保证）', ctxProps.every((p) => ['effect', 'get', 'inject', 'llm', 'logger', 'settings'].includes(p)), ctxProps.join(','))
check('宿主 ctx 守卫：臆造的 includeExternalSkills 不再被读取（文档里的案例保留）', !/ctx\.includeExternalSkills/.test(hostSrc) && !/includeExternal\s*=/.test(hostSrc))
check('宿主 ctx 守卫：llm / settings 的直读统一走 ctxProp 安全入口', hostSrc.includes("ctxProp(ctx, 'llm')") && hostSrc.includes("ctxProp(ctx, 'settings')"))
/* 归一：路由 catch 会把注入错误写成裸英文 message，客户端只能照抄 —— 归类后才有可执行的下一步。 */
const hostFail = typeof m.classifyHostFailure === 'function' ? m.classifyHostFailure({ ok: false, message: 'cannot get property "includeExternalSkills" without inject' }) : null
check('宿主错误归一：未注入字段被归类为 host-inject 且带中文原因', !!hostFail && hostFail.code === 'host-inject' && hostFail.reason.includes('includeExternalSkills'), JSON.stringify(hostFail))
const hostFail2 = typeof m.classifyHostFailure === 'function' ? m.classifyHostFailure({ ok: false, code: 'ambiguous-install', message: 'cannot get property "z" without inject' }) : null
check('宿主错误归一：已有失败码的响应不被改写', !!hostFail2 && hostFail2.code === 'ambiguous-install', JSON.stringify(hostFail2))
const hostFail3 = typeof m.classifyHostFailure === 'function' ? m.classifyHostFailure({ ok: false, message: 'plain' }) : null
check('宿主错误归一：普通失败原样返回（不误伤）', !!hostFail3 && hostFail3.code === undefined && hostFail3.message === 'plain', JSON.stringify(hostFail3))

const bundleRows = m.collectStatus([sandbox])
const bundleRow = bundleRows.find((r) => r.pkg === 'pkg-with-exports')
check('插件 package.json repository/homepage 映射到来源链接并脱敏',
  !!bundleRow && bundleRow.sourceUrl === 'https://gitlab.example.com:8443/team/pkg-with-exports' && bundleRow.sourceLabel === '远端 Git 仓库', JSON.stringify(bundleRow))
process.env.DSH_HOME = savedHome6
process.env.DSH_AGENTS_HOME = savedAgentsHome
fs.rmSync(skillRoot, { recursive: true, force: true })

// ─────────────────────── A13 技能更新（git 快进；只碰临时仓库） ───────────────────────
console.log(String.fromCharCode(10) + 'A13 技能更新（git 快进）')
const NL13 = String.fromCharCode(10)
const gitOk = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()
if (gitOk !== true) {
  check('git 不可用 —— 跳过技能更新用例（不谎报通过）', true)
} else {
  const gitEnv13 = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' })
  const run = (args, cwd) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t'].concat(args), { cwd, env: gitEnv13, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  const base13 = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-git-'))
  const root13 = path.join(base13, 'agents')
  const skills13 = path.join(root13, 'skills')
  fs.mkdirSync(skills13, { recursive: true })
  // 每个技能一个独立远端：seed -> bare -> clone/pusher，互不干扰
  const mkRepo = (skillName) => {
    const seed = path.join(base13, skillName + '-seed')
    const bare = path.join(base13, skillName + '.git')
    const clone = path.join(skills13, skillName)
    const pusher = path.join(base13, skillName + '-pusher')
    fs.mkdirSync(seed, { recursive: true })
    fs.writeFileSync(path.join(seed, 'SKILL.md'), ['---', 'name: ' + skillName, 'description: v1', '---', '', 'body v1'].join(NL13))
    fs.writeFileSync(path.join(seed, 'NOTES.md'), 'v1' + NL13)
    run(['init', '-b', 'master'], seed)
    run(['add', '-A'], seed)
    run(['commit', '-m', 'v1'], seed)
    run(['clone', '--bare', seed, bare], base13)
    run(['clone', bare, clone], base13)
    run(['clone', bare, pusher], base13)
    return { seed, bare, clone, pusher }
  }
  const gFast = mkRepo('demo-git')
  const gDirty = mkRepo('demo-dirty')
  const gFork = mkRepo('demo-fork')
  fs.mkdirSync(path.join(skills13, 'demo-plain'), { recursive: true })
  fs.writeFileSync(path.join(skills13, 'demo-plain', 'SKILL.md'), ['---', 'name: demo-plain', 'description: 本地目录', '---', '', 'body'].join(NL13))
  const savedHome13 = process.env.DSH_HOME
  const savedAgents13 = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = path.join(base13, 'no-dsh-home')
  process.env.DSH_AGENTS_HOME = root13
  const baseSha = run(['rev-parse', 'HEAD'], gFast.clone)
  const info = m.skillRepoInfo(gFast.clone)
  check('git：识别仓库根 / 分支 / 远端 / 未提交数', info.isGit === true && info.branch === 'master' && info.dirty === 0 && info.owned === true && info.url !== '')
  check('git：非仓库目录如实 isGit=false', m.skillRepoInfo(path.join(base13, 'nope')).isGit === false)
  const rows0 = m.collectSkills({ get: () => undefined, includeExternalSkills: true })
  const rowGit = rows0.find((r) => r.pkg === 'demo-git')
  const rowPlain = rows0.find((r) => r.pkg === 'demo-plain')
  check('git：技能行带上仓库事实（HEAD 与仓库根归属）', !!rowGit && rowGit.isGit === true && rowGit.localSha === baseSha && rowGit.repoOwned === true)
  check('git：非 git 技能行如实标注', !!rowPlain && rowPlain.isGit === false && rowPlain.repoUrl === '' && rowPlain.dirty === 0)
  const en0 = await m.enrichSkillUpdates(rows0, true)
  const eGit0 = en0.find((r) => r.pkg === 'demo-git')
  check('git：远端与本地一致 -> hasUpdate=false 且给出远端 sha', !!eGit0 && eGit0.hasUpdate === false && eGit0.remoteSha === baseSha)
  check('git：非 git 技能 hasUpdate=null（不猜）', (en0.find((r) => r.pkg === 'demo-plain') || {}).hasUpdate === null)
  fs.writeFileSync(path.join(gFast.pusher, 'NOTES.md'), 'v2' + NL13)
  run(['add', '-A'], gFast.pusher)
  run(['commit', '-m', 'v2'], gFast.pusher)
  run(['push', 'origin', 'master'], gFast.pusher)
  const newSha = run(['rev-parse', 'HEAD'], gFast.pusher)
  const en1 = await m.enrichSkillUpdates(m.collectSkills({ get: () => undefined, includeExternalSkills: true }), true)
  const eGit1 = en1.find((r) => r.pkg === 'demo-git')
  check('git：远端前进 -> hasUpdate=true 且带远端 sha', !!eGit1 && eGit1.hasUpdate === true && eGit1.remoteSha === newSha)
  const upd1 = await m.updateSkillRepos(['demo-git'], { includeExternalSkills: true })
  check('git：更新做真快进并汇报 from -> to', upd1.length === 1 && upd1[0].state === 'updated' && upd1[0].from === baseSha && upd1[0].to === newSha, JSON.stringify(upd1))
  check('git：快进后工作区真的拿到新内容', fs.readFileSync(path.join(gFast.clone, 'NOTES.md'), 'utf8').trim() === 'v2')
  const upd1b = await m.updateSkillRepos(['demo-git'], { includeExternalSkills: true })
  check('git：再更新一次 -> unchanged（幂等）', upd1b[0].state === 'unchanged', JSON.stringify(upd1b))
  const updPlain = await m.updateSkillRepos(['demo-plain'], { includeExternalSkills: true })
  check('git：非 git 技能拒绝更新且给得出理由', updPlain[0].state === 'failed' && updPlain[0].message.includes('不是 git 仓库'))
  const updMissing = await m.updateSkillRepos(['not-a-skill'])
  check('git：不存在的技能如实报失败', updMissing[0].state === 'failed' && updMissing[0].message.includes('不存在'))
  fs.writeFileSync(path.join(gDirty.clone, 'NOTES.md'), '我的未提交改动' + NL13)
  const beforeDirty = fs.readFileSync(path.join(gDirty.clone, 'NOTES.md'), 'utf8')
  fs.writeFileSync(path.join(gDirty.pusher, 'NOTES.md'), 'v2' + NL13)
  run(['add', '-A'], gDirty.pusher)
  run(['commit', '-m', 'v2'], gDirty.pusher)
  run(['push', 'origin', 'master'], gDirty.pusher)
  const updDirty = await m.updateSkillRepos(['demo-dirty'], { includeExternalSkills: true })
  check('git：本地未提交改动与远端冲突 -> 拒绝快进', updDirty[0].state === 'failed')
  check('git：拒绝理由点明「未提交修改」而非含糊失败', /未提交修改|local changes|would be overwritten/i.test(updDirty[0].message), JSON.stringify(updDirty))
  check('git：拒绝后本地未提交改动逐字节未被动过', fs.readFileSync(path.join(gDirty.clone, 'NOTES.md'), 'utf8') === beforeDirty)
  fs.writeFileSync(path.join(gFork.clone, 'MINE.md'), 'local only' + NL13)
  run(['add', '-A'], gFork.clone)
  run(['commit', '-m', 'local'], gFork.clone)
  fs.writeFileSync(path.join(gFork.pusher, 'NOTES.md'), 'v2' + NL13)
  run(['add', '-A'], gFork.pusher)
  run(['commit', '-m', 'v2'], gFork.pusher)
  run(['push', 'origin', 'master'], gFork.pusher)
  const updFork = await m.updateSkillRepos(['demo-fork'], { includeExternalSkills: true })
  check('git：本地分叉 -> 拒绝（不产生合并提交）', updFork[0].state === 'failed' && /分叉|fast-forward/.test(updFork[0].message), JSON.stringify(updFork))
  check('git：拒绝后本地提交仍在（没有回退工作）', run(['log', '--oneline', '-1'], gFork.clone).includes('local'))
  process.env.DSH_HOME = savedHome13
  process.env.DSH_AGENTS_HOME = savedAgents13
  fs.rmSync(base13, { recursive: true, force: true })
}
check('客户端：插件与技能合并为一页（只注册一个 settings.section）', (clientSrc.match(/name: 'settings\.section'/g) || []).length === 1 && clientSrc.includes("'插件与技能审查'"))
check('客户端：合并页用页内切换区分 插件/技能（页签与标题同处一行头部）',
  clientSrc.includes('function Merged') && clientSrc.includes("tab('plugin'") && clientSrc.includes("tab('skill'") &&
  clientSrc.includes('var segEl = h(') && clientSrc.includes('das-seg') &&
  clientSrc.includes('h(Panel, { key: mode, target: mode, seg: segEl })') &&
  clientSrc.includes('props && props.seg ? props.seg : null'))
check('客户端：行内按钮一律走 aria-label，不用原生 title 浮层（含状态列的展开 chip）',
  clientSrc.includes("'aria-label': title === undefined || title === null ? label : title") &&
  clientSrc.includes("'aria-label': '只为当前插件生成并应用中文名称与说明'") &&
  clientSrc.includes("'aria-label': title === undefined || title === null ? text : title") &&
  !clientSrc.includes("disabled: busyNow, title: '只为当前插件生成并应用中文名称与说明'") &&
  !clientSrc.includes("title: '在当前表格行下展开审查发现与处理建议'"))
check('客户端：悬停详情用锚定浮层（fixed + 钳制视口），不再占用表格下方的槽位',
  /\.das-hover \{[^}]*position: fixed/.test(clientSrc) && !/\.das-hover \{[^}]*min-height: 52px/.test(clientSrc) &&
  clientSrc.includes('function placeCard(') && clientSrc.includes('function boxFromEvent(') &&
  clientSrc.includes('onMouseLeave'))
check('客户端：随 DSH 提供的对象默认隐藏，但给出数量与显示开关（不静默隐藏）',
  clientSrc.includes("var bundledList = (rows || []).filter(function (r) { return r.bundled === true; });") &&
  clientSrc.includes("'随 DSH 提供'") && clientSrc.includes('setShowBundled(!showBundled)') &&
  clientSrc.includes("r.bundled !== true"))
check('客户端：技能视图如实声明会写入 SKILL.md（含备份与还原）', clientSrc.includes('技能改写会真实写入 SKILL.md') && clientSrc.includes('.dsh-skill.backup') && clientSrc.includes('行为变更'))
check('客户端：技能视图把 优化状态 与 描述语言 分栏如实呈现',
  (clientSrc.match(/name: 'settings\.section'/g) || []).length === 1 &&
  clientSrc.includes("'技能与中文说明'") && clientSrc.includes("'随 DSH'") &&
  clientSrc.includes('r.descriptionLang') && clientSrc.includes('r.bundled !== true'))
check('客户端：技能侧不再把 needsText 当成「描述为空」', !clientSrc.includes("'描述为空'"))
check('客户端：技能视图不继承插件批量状态，两页各自渲染自己的更新结果',
  clientSrc.includes('if (IS_SKILL) return;') && !clientSrc.includes('!IS_SKILL && batch &&') &&
  clientSrc.includes("(IS_SKILL ? '技能更新' : '插件更新')") && clientSrc.includes("call('update-skills'"))
check('客户端：技能页有与插件页同一套一键更新/行内更新',
  clientSrc.includes("call('update-all'") && clientSrc.includes("call('update-skills'") &&
  clientSrc.includes("opBtn('all'") && clientSrc.includes("opBtn('u'"))
check('客户端：技能侧如实显示 远端 sha / 最新 / 未比对 与本地改动（都进 version title）',
  clientSrc.includes("h('th', null, '版本')") && clientSrc.includes('function shortShaOf') &&
  clientSrc.includes("'远端 ' + shortShaOf") && clientSrc.includes('本地改动 '))
check('客户端：加载中的占位文案按视图区分',
  clientSrc.includes("'正在读取技能状态…'") && clientSrc.includes("'正在读取插件状态…'"))
check('客户端：版本不一致时同时报出两个版本与各自修法',
  clientSrc.includes('var CLIENT_REV = ') && clientSrc.includes('compareRev(hostRev, CLIENT_REV)') &&
  clientSrc.includes('请重启 DSH。') && clientSrc.includes('请刷新页面。'))
const clientRevLit = (clientSrc.match(/var CLIENT_REV = '([0-9]+\.[0-9]+\.[0-9]+)'/) || [])[1]
const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version
check('客户端半体版本字面量与 package.json 一致（防漂移）', clientRevLit === pkgVersion, clientRevLit + ' vs ' + pkgVersion)

// ─────────────────────── A12 技能改写（直接动 SKILL.md，必须最严格） ───────────────────────
console.log(String.fromCharCode(10) + 'A12 技能改写与还原')
check('enforceSkillName 强制「原名（中文）」', m.enforceSkillName('demo', '完全无关') === 'demo（完全无关）')
check('enforceSkillName 已合规则保留', m.enforceSkillName('demo', 'demo（甲）') === 'demo（甲）')
check('enforceSkillName 空值退回原名', m.enforceSkillName('demo', '') === 'demo')
check('parseGeneratedSkill 解析正常', (function () { const g = m.parseGeneratedSkill('{"zhName":"a（甲）","description":"触发 → 说明"}'); return !!g && g.zhName === 'a（甲）' })())
check('parseGeneratedSkill 字段缺失返回 undefined', m.parseGeneratedSkill('{"zhName":"a"}') === undefined)
check('skillBaseName 去掉本插件附加的中文名', m.skillBaseName('ponytail（YAGNI 极简）') === 'ponytail' && m.skillBaseName('plain') === 'plain')
const skRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'skillw-'))
const dshH = path.join(skRoot2, 'dsh')
const agH = path.join(skRoot2, 'agents')
const hi2 = path.join(dshH, 'skills')
const oneSrc = ['---', 'name: demo-one', 'description: Use when X happens', 'license: MIT', 'argument-hint: "[a|b]"', '---', '', '# Body', 'text here'].join(String.fromCharCode(10))
const blkSrc = ['---', 'name: demo-block', 'description: |', '  第一行说明', '  第二行说明', 'metadata:', '  version: "1.0.0"', '---', '', '# Block Body'].join(String.fromCharCode(10))
const noFmSrc = 'no frontmatter at all'
fs.mkdirSync(path.join(hi2, 'demo-one'), { recursive: true })
fs.writeFileSync(path.join(hi2, 'demo-one', 'SKILL.md'), oneSrc)
fs.mkdirSync(path.join(hi2, 'demo-block'), { recursive: true })
fs.writeFileSync(path.join(hi2, 'demo-block', 'SKILL.md'), blkSrc)
fs.mkdirSync(path.join(hi2, 'demo-nofm2'), { recursive: true })
fs.writeFileSync(path.join(hi2, 'demo-nofm2', 'SKILL.md'), noFmSrc)
const savedH7 = process.env.DSH_HOME
const savedA7 = process.env.DSH_AGENTS_HOME
process.env.DSH_HOME = dshH
process.env.DSH_AGENTS_HOME = agH
const wEntries = [
  { pkg: 'demo-one', zh: { name: 'demo-one（甲）', description: 'Use when X、触发词X → 做什么与不做 什么的精炼说明' } },
  { pkg: 'demo-block', zh: { name: 'demo-block（乙）', description: '触发乙 → 乙的说明' } },
]
m.upsertSkillOverlay('demo-one', wEntries[0].zh)
m.upsertSkillOverlay('demo-block', wEntries[1].zh)
check('技能文案写入覆盖层后可读回', m.readSkillCatalog().some((e) => e.pkg === 'demo-one'))
const applied1 = m.applySkillLocale([])
check('应用：两个技能都成功', applied1.filter((r) => r.state === 'applied').length === 2, JSON.stringify(applied1))
const oneAfter = fs.readFileSync(path.join(hi2, 'demo-one', 'SKILL.md'), 'utf8')
check('改写：稳定 name 保持原名，中文名只在展示层', oneAfter.includes('name: demo-one') && !oneAfter.includes('name: demo-one（甲）'))
check('改写：description 被替换为中文', oneAfter.indexOf('description: ') >= 0 && oneAfter.indexOf('Use when X happens') < 0)
check('改写：其他 frontmatter 字段逐字保留', oneAfter.includes('license: MIT') && oneAfter.includes('argument-hint: "[a|b]"'))
check('改写：正文逐字保留', oneAfter.includes('# Body') && oneAfter.includes('text here'))
const blkAfter = fs.readFileSync(path.join(hi2, 'demo-block', 'SKILL.md'), 'utf8')
check('块标量 description 被整体吃掉（无残行）', blkAfter.indexOf('第一行说明') < 0 && blkAfter.indexOf('第二行说明') < 0)
check('块标量后的 metadata 段被完整保留', blkAfter.includes('metadata:') && blkAfter.includes('version: "1.0.0"'))
const rowsAfter = m.collectSkills({ get: () => undefined, includeExternalSkills: true })
check('版本读取支持 metadata.version', (rowsAfter.find((r) => r.pkg === 'demo-block') || {}).version === '1.0.0')
check('应用后仍以原名成行（稳定标识）', rowsAfter.some((r) => r.pkg === 'demo-one'))
check('应用后判定为已优化', (rowsAfter.find((r) => r.pkg === 'demo-one') || {}).localized === true)
check('应用后 displayName 是带中文名的形态', (rowsAfter.find((r) => r.pkg === 'demo-one') || {}).displayName === 'demo-one（甲）')
const applied2 = m.applySkillLocale([])
check('二次应用幂等（仍能找到目标）', applied2.filter((r) => r.state === 'applied').length === 2, JSON.stringify(applied2))
m.upsertSkillOverlay('demo-nofm2', { name: 'x（x）', description: 'y' })
const badWrite = m.applySkillLocale([])
check('无 frontmatter 时拒绝改写且不动文件', (function () { const r0 = badWrite.find((x) => x.pkg === 'demo-nofm2'); return !!r0 && r0.state === 'failed' && fs.readFileSync(path.join(hi2, 'demo-nofm2', 'SKILL.md'), 'utf8') === noFmSrc })())
const reverted = m.revertSkillLocale([])
check('还原：两项均为 restored', reverted.filter((r) => r.state === 'restored').length === 2, JSON.stringify(reverted))
check('还原：单行文件与原文逐字节一致', fs.readFileSync(path.join(hi2, 'demo-one', 'SKILL.md'), 'utf8') === oneSrc)
check('还原：块标量文件与原文逐字节一致', fs.readFileSync(path.join(hi2, 'demo-block', 'SKILL.md'), 'utf8') === blkSrc)
process.env.DSH_HOME = savedH7
process.env.DSH_AGENTS_HOME = savedA7
fs.rmSync(skRoot2, { recursive: true, force: true })
check('客户端：技能页已启用翻译优化与还原翻译', clientSrc.includes("call('apply-skills'") && clientSrc.includes("call('revert-skills'") && clientSrc.includes("call('generate-skill'"))
check('客户端：技能优化也跳过已优化', clientSrc.includes('个技能均已优化，无需处理'))

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
