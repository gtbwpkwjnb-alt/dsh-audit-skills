/**
 * dsh-audit-skills — 客户端半体【源码，尚不可直接加载】
 *
 * ⚠️ 重要（v1.2.1 事故结论）：
 * DSH 的客户端半体必须是被打包成**传统脚本**的产物（rolldown/tsdown 输出），
 * 加载方式等同 <script>，没有 type="module"。
 * 直接以裸 ESM（含顶层 import）作为 client.js 会抛
 *   Uncaught SyntaxError: Cannot use import statement outside a module
 * 且该失败是**致命**的：web 端 "1 entry did not activate" → web-boot 崩溃，
 * 整个 GUI 起不来（宿主半体失败只是 warning，两者严重度不同）。
 *
 * 因此本文件默认不随包发布、也不在 package.json 里声明 dsh.client。
 * 恢复路径：引入 rolldown/tsdown 构建链，产出 bundle 后的 lib/client.js，
 * 再在 package.json 声明
 *   "dsh.client": { "platform": "web", "inject": [...] }
 * 与 "exports": { "./client": "./lib/client.js" }。
 *
 * 原始设计：
 * 三个入口，全部经 ErrorBoundary 隔离：渲染失败只影响本插件，不拖垮设置页/插件页。
 * - settings.section  → 设置页「技能审查」分区（按钮组 + 状态表）
 * - plugins.row.config → 插件页本插件行的卡片（同一面板）
 * - betterSidebar      → 可选依赖；存在时额外注册一个侧边栏卡片
 *
 * 客户端不直接读磁盘：所有动作经宿主半体的 /api/dsh-audit-skills bridge。
 */
import { createElement as h, Component, useCallback, useEffect, useState } from 'react'

export const name = 'dsh-audit-skills'
export const inject = ['slots']

const BRIDGE = '/api/dsh-audit-skills'
const LABEL = '技能审查'

async function call(action) {
  try {
    const res = await fetch(BRIDGE + '/' + action, { method: 'POST' })
    if (!res.ok) return { ok: false, message: 'HTTP ' + res.status }
    return await res.json()
  } catch (error) {
    return { ok: false, message: String((error && error.message) || error) }
  }
}

/** 渲染隔离：任何子组件抛错都只在本插件范围内显示一行提示。 */
class Boundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      const msg = String((this.state.error && this.state.error.message) || this.state.error)
      return h('div', { style: { padding: '10px 12px', fontSize: '12px', opacity: 0.75 } }, 'dsh-audit-skills 渲染失败，已隔离：' + msg)
    }
    return this.props.children
  }
}

const S = {
  box: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' },
  bar: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
  note: { fontSize: '12px', opacity: 0.8 },
  table: { fontSize: '12px', width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid currentColor', opacity: 0.6, fontWeight: 500 },
  td: { padding: '4px 6px', borderBottom: '1px solid rgba(128,128,128,0.2)' },
  dim: { opacity: 0.45 },
}

function Panel() {
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  const refresh = useCallback(async () => {
    setBusy('status')
    const r = await call('status')
    setBusy('')
    if (r && r.ok && Array.isArray(r.value)) setRows(r.value)
    else setNote('状态读取失败：' + ((r && r.message) || 'unknown'))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const act = useCallback(
    async (action, label) => {
      setBusy(action)
      const r = await call(action)
      setBusy('')
      if (r && r.ok && Array.isArray(r.value)) {
        const n = r.value.filter((x) => x.state === 'applied' || x.state === 'restored').length
        setNote(label + '完成：' + n + ' 项')
        await refresh()
      } else {
        setNote(label + '失败：' + ((r && r.message) || 'unknown'))
      }
    },
    [refresh],
  )

  const head = h('div', { style: S.bar },
    h('button', { type: 'button', disabled: !!busy, onClick: () => act('apply', '应用翻译精炼') }, '应用翻译精炼'),
    h('button', { type: 'button', disabled: !!busy, onClick: () => act('revert', '还原翻译') }, '还原翻译'),
    h('button', { type: 'button', disabled: !!busy, onClick: refresh }, busy === 'status' ? '读取中…' : '刷新状态'),
  )

  const body = rows === null
    ? h('div', { style: S.note }, '正在读取插件状态…')
    : h('table', { style: S.table },
        h('thead', null, h('tr', null,
          h('th', { style: S.th }, '插件'),
          h('th', { style: S.th }, '状态'),
          h('th', { style: S.th }, '插件页当前标题'))),
        h('tbody', null, rows.map((r) => h('tr', { key: r.profileDir + '|' + r.pkg, style: r.installed ? undefined : S.dim },
          h('td', { style: S.td }, r.pkg),
          h('td', { style: S.td }, !r.installed ? '未安装' : (r.localized ? '已精炼' : '待精炼')),
          h('td', { style: S.td }, r.title || '—')))),
      )

  return h('div', { style: S.box },
    head,
    h('div', { style: S.note }, '命名约定：标题保留原包名，中文名以（）附加，避免认不出原插件。'),
    note ? h('div', { style: S.note }, note) : null,
    body,
    h('div', { style: S.note }, '更新检查 / 推荐 / 崩溃守护 已委托生态既有插件，本插件不重复实现。'),
  )
}

function safe(what, fn) {
  try {
    fn()
  } catch (error) {
    /* 注册失败只影响本插件入口，绝不影响设置页/插件页 */
    const msg = String((error && error.message) || error)
    if (typeof console !== 'undefined' && console.warn) console.warn('dsh-audit-skills: ' + what + ' 注册失败: ' + msg)
  }
}

export function apply(ctx) {
  safe('settings.section', () => {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'dsh-audit-skills',
      order: 200,
      label: () => LABEL,
    }, () => h(Boundary, null, h(Panel))))
  })

  safe('plugins.row.config', () => {
    ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
      name: 'plugins.row.config',
      key: 'dsh-audit-skills#dsh-audit-skills',
    }, (slotProps) => (slotProps && slotProps.view === 'summary'
      ? '插件说明中文化 · 状态汇总'
      : h(Boundary, null, h(Panel)))))
  })

  safe('betterSidebar.registerTab', () => {
    ctx.inject(['betterSidebar'], (sctx) => {
      const svc = sctx.get('betterSidebar')
      if (!svc || typeof svc.registerTab !== 'function') return
      sctx.effect(() => svc.registerTab({
        id: 'dsh-audit-skills',
        title: LABEL,
        component: () => h(Boundary, null, h(Panel)),
      }))
    })
  })
}
