#!/usr/bin/env node
/**
 * tdd-improve-reliability.mjs — 针对「优化翻译 / 一键更新失败率高」的改动用例。
 *
 * 先跑红（当前实现必失败），改完后再跑绿。只写临时沙箱，不碰真实 profile。
 * 用法：node scripts/tdd-improve-reliability.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')))
const PROFILE = 'C:/Users/Administrator/.dsh/profiles/desktop'
let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  PASS  ' + name) }
  else { fail += 1; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')) }
}

function ensureScheme() {
  const target = path.join(REPO, 'node_modules', '@deepseek-ai', 'schemastery')
  const source = path.join(PROFILE, 'node_modules', '@deepseek-ai', 'schemastery')
  if (fs.existsSync(target) || !fs.existsSync(source)) return false
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.symlinkSync(source, target, 'junction')
  return true
}
ensureScheme()
const m = await import('../index.js')

/** 造一个沙箱 profile：pkg-a 已装 1.0.0。 */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-tdd-'))
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg-a'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg-a', 'package.json'), JSON.stringify({ name: 'pkg-a', version: '1.0.0' }))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sb', dependencies: { 'pkg-a': '1.0.0' } }, null, 2))
  return dir
}

/* ───────────────── T1：已装包的更新必须先卸载再安装 ───────────────── */
console.log('\nT1 已装包走「先卸载、再安装」')
{
  const dir = makeSandbox()
  const calls = []
  const pm = {
    listBundles: async () => [{ name: 'pkg-a', installed: true, removable: true, enabled: true }],
    removeBundle: async (name) => {
      calls.push('remove:' + name)
      fs.rmSync(path.join(dir, 'node_modules', name), { recursive: true, force: true })
      const doc = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      delete doc.dependencies[name]
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(doc, null, 2))
      return { ok: true }
    },
    installBundle: async (spec) => {
      calls.push('install:' + spec)
      const doc = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      doc.dependencies['pkg-a'] = '1.0.0'
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(doc, null, 2))
      fs.mkdirSync(path.join(dir, 'node_modules', 'pkg-a'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'node_modules', 'pkg-a', 'package.json'), JSON.stringify({ name: 'pkg-a', version: '2.0.0' }))
      return { application: 'applied', changed: true }
    },
  }
  const r = await m.installAndWait({ get: (n) => (n === 'pluginManager' ? pm : undefined) }, dir, 'pkg-a', 8000)
  check('T1.1 先调 removeBundle 再调 installBundle', calls.length === 2 && calls[0] === 'remove:pkg-a', JSON.stringify(calls))
  check('T1.2 安装规格是 pkg-a@latest', calls[1] === 'install:pkg-a@latest', JSON.stringify(calls))
  check('T1.3 结果为 updated 且 to=2.0.0', r.ok === true && r.state === 'updated' && r.to === '2.0.0', JSON.stringify(r))
}

/* ───────────────── T2：安装失败时按原依赖规格回滚 ───────────────── */
console.log('\nT2 安装失败自动回滚原版本')
{
  const dir = makeSandbox()
  const calls = []
  const pm = {
    listBundles: async () => [{ name: 'pkg-a', installed: true, removable: true, enabled: true }],
    removeBundle: async (name) => {
      calls.push('remove:' + name)
      fs.rmSync(path.join(dir, 'node_modules', name), { recursive: true, force: true })
      const doc = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      delete doc.dependencies[name]
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(doc, null, 2))
      return { ok: true }
    },
    installBundle: async (spec) => {
      calls.push('install:' + spec)
      if (spec === 'pkg-a@latest') return { application: 'failed', error: { code: 'incompatible-version' } }
      // 回滚：装回原版本
      const doc = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      doc.dependencies['pkg-a'] = '1.0.0'
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(doc, null, 2))
      fs.mkdirSync(path.join(dir, 'node_modules', 'pkg-a'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'node_modules', 'pkg-a', 'package.json'), JSON.stringify({ name: 'pkg-a', version: '1.0.0' }))
      return { application: 'applied' }
    },
  }
  const r = await m.installAndWait({ get: (n) => (n === 'pluginManager' ? pm : undefined) }, dir, 'pkg-a', 8000)
  check('T2.1 失败后按 pkg-a@1.0.0 回滚', calls.includes('install:pkg-a@1.0.0'), JSON.stringify(calls))
  check('T2.2 回滚后包已恢复到 1.0.0', m.installedVersion(dir, 'pkg-a') === '1.0.0', String(m.installedVersion(dir, 'pkg-a')))
  check('T2.3 结果仍是 failed（不假装成功）', r.ok === false && r.state === 'failed', JSON.stringify({ ok: r.ok, state: r.state }))
  check('T2.4 结果说明写了已装回原版本', /装回|回滚/.test(String(r.message)), String(r.message))
}

/* ───────────────── T3：自我更新跳过，不调安装 ───────────────── */
console.log('\nT3 dsh-audit-skills 自身跳过')
{
  const dir = makeSandbox()
  let touched = 0
  const pm = {
    listBundles: async () => [{ name: 'dsh-audit-skills', installed: true, removable: true, enabled: true }],
    removeBundle: async () => { touched += 1; return { ok: true } },
    installBundle: async () => { touched += 1; return {} },
  }
  const r = await m.installAndWait({ get: (n) => (n === 'pluginManager' ? pm : undefined) }, dir, 'dsh-audit-skills', 3000)
  check('T3.1 自我更新被拒绝并给出 self-update 码', r.ok === false && r.code === 'self-update', JSON.stringify({ ok: r.ok, code: r.code }))
  check('T3.2 完全没有触碰管理器', touched === 0, String(touched))
  const batch = m.startUpdateAll({ get: (n) => (n === 'pluginManager' ? pm : undefined) }, dir, ['dsh-audit-skills', 'pkg-a'])
  await new Promise((r2) => setTimeout(r2, 1200))
  const st = m.updateAllStatus()
  const self = (st?.items || []).find((x) => x.pkg === 'dsh-audit-skills')
  check('T3.3 批量里自我包标为 skipped-self 而不是 failed', !!self && self.state === 'skipped-self', JSON.stringify(self))
  check('T3.4 自我包提示去官方插件页', /官方插件页/.test(String(self?.message)), String(self?.message))
  check('T3.5 批量启动仍成功', batch.ok === true, JSON.stringify(batch))
}

/* ───────────────── T4：翻译按 finish.failure 归因 ───────────────── */
console.log('\nT4 模型流失败按真实原因归因')
{
  const makeCtx = (failureCode, calls) => {
    const llm = {
      stream: () => {
        calls.n += 1
        return (async function* () {
          yield { type: 'text-delta', text: '{"en"' }
          yield { type: 'finish', reason: { kind: 'error', failure: { code: failureCode, message: failureCode + ' from provider' } } }
        })()
      },
    }
    const settings = { read: async () => ({ provider: 'p', model: 'm' }) }
    return { get: (n) => (n === 'settings' ? settings : (n === 'llm' ? llm : undefined)) }
  }
  const rateCalls = { n: 0 }
  const rate = await m.generateRefinement(makeCtx('RATE_LIMIT', rateCalls), 'pkg-a', { en: { title: 'a', description: 'b' } })
  check('T4.1 限流归因为 llm-rate-limit', rate.ok === false && rate.code === 'llm-rate-limit', JSON.stringify({ code: rate.code, message: rate.message }))
  check('T4.2 限流可重试（调用次数>1 且<=3）', rateCalls.n > 1 && rateCalls.n <= 3, String(rateCalls.n))
  check('T4.3 限流文案不再是「输出无法解析」', !/无法解析/.test(String(rate.message)), String(rate.message))

  const quotaCalls = { n: 0 }
  const quota = await m.generateRefinement(makeCtx('ACCOUNT_QUOTA', quotaCalls), 'pkg-a', { en: { title: 'a', description: 'b' } })
  check('T4.4 欠费归因为 llm-account-quota 且不重试', quota.ok === false && quota.code === 'llm-account-quota' && quotaCalls.n === 1, JSON.stringify({ code: quota.code, n: quotaCalls.n }))

  const credCalls = { n: 0 }
  const cred = await m.generateRefinement(makeCtx('MISSING_CREDENTIAL', credCalls), 'pkg-a', { en: { title: 'a', description: 'b' } })
  check('T4.5 缺凭据归因为 llm-credential 且不重试', cred.ok === false && cred.code === 'llm-credential' && credCalls.n === 1, JSON.stringify({ code: cred.code, n: credCalls.n }))

  const emptyCalls = { n: 0 }
  const ctxEmpty = {
    get: (n) => (n === 'settings' ? { read: async () => ({ provider: 'p', model: 'm' }) } : (n === 'llm' ? {
      stream: () => { emptyCalls.n += 1; return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })() },
    } : undefined)),
  }
  const empty = await m.generateRefinement(ctxEmpty, 'pkg-a', { en: { title: 'a', description: 'b' } })
  check('T4.6 空输出归因为 llm-empty-response', empty.ok === false && empty.code === 'llm-empty-response', JSON.stringify({ code: empty.code, message: empty.message }))
}

/* ───────────────── T5：超时通过 AbortController 真取消 ───────────────── */
console.log('\nT5 超时取消底层流')
{
  let signal = null
  let aborted = false
  const llm = {
    stream: (options) => {
      signal = options && options.signal
      return (async function* () {
        if (signal) signal.addEventListener('abort', () => { aborted = true })
        await new Promise(() => {}) // 永不产出 finish
      })()
    },
  }
  const settings = { read: async () => ({ provider: 'p', model: 'm' }) }
  const ctx = { get: (n) => (n === 'settings' ? settings : (n === 'llm' ? llm : undefined)) }
  const started = Date.now()
  // 旧实现没有 timeoutMs 参数，会等满 45s×2；这里加护栏，让红跑得出来也不挂住。
  const r = await Promise.race([
    m.generateRefinement(ctx, 'pkg-a', { en: { title: 'a', description: 'b' } }, { timeoutMs: 400, attempts: 1 }),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: 'test-hung', message: '旧实现没有超时/取消参数，8 秒内未返回' }), 8000)),
  ])
  const ms = Date.now() - started
  check('T5.1 超时有界返回（<6s）', ms < 6000, 'ms=' + ms)
  check('T5.2 超时归因为 llm-timeout', r.ok === false && r.code === 'llm-timeout', JSON.stringify({ code: r.code, message: r.message }))
  check('T5.3 传入了 signal', signal !== null && signal !== undefined, String(signal))
  await new Promise((r2) => setTimeout(r2, 50))
  check('T5.4 超时后底层流被 abort', aborted === true, String(aborted))
}

/* ───────────────── T6：留痕给出按包去重的数量 ───────────────── */
console.log('\nT6 留痕计数')
{
  const run = m.normalizeTranslateRun({ action: 'optimize', items: [
    { pkg: 'a', state: 'generated' },
    { pkg: 'a', state: 'applied' },
    { pkg: 'b', state: 'failed' },
  ] })
  check('T6.1 packages 为去重包数 2', run.packages === 2, JSON.stringify({ packages: run.packages, total: run.total }))
  check('T6.2 total 仍是条目数 3（向后兼容）', run.total === 3, String(run.total))
  check('T6.3 旧运行记录（无 packages 字段）也能读出', typeof m.normalizeTranslateRun({ items: [{ pkg: 'x', state: 'applied' }] }).packages === 'number')
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
