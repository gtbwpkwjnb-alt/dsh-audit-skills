/* dsh-audit-skills — 客户端半体
 *
 * 形态要求（v1.2.1 事故结论，不可违反）：
 * DSH 以传统 <script> 加载 client.js，因此本文件**不得出现顶层 import/export**，
 * 必须用 window.__ModuleLoader__.load({ id, factory: (require) => ... }) 注册，
 * 依赖通过 factory 收到的 require 获取。
 *
 * 三个入口全部经 ErrorBoundary 隔离：渲染失败只影响本插件，不拖垮设置页/插件页。
 * 客户端不直接读磁盘，所有动作经宿主半体 /api/dsh-audit-skills。
 */
window.__ModuleLoader__.load({
  id: 'dsh-audit-skills',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var react = require('react');
    var h = react.createElement;
    var Component = react.Component;
    var useCallback = react.useCallback;
    var useEffect = react.useEffect;
    var useState = react.useState;

    var BRIDGE = '/api/dsh-audit-skills';
    var LABEL = '技能审查';

    async function call(action) {
      try {
        var res = await fetch(BRIDGE + '/' + action, { method: 'POST' });
        if (!res.ok) return { ok: false, message: 'HTTP ' + res.status };
        return await res.json();
      } catch (error) {
        return { ok: false, message: String((error && error.message) || error) };
      }
    }

    class Boundary extends Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error };
      }
      render() {
        if (this.state.error) {
          var msg = String((this.state.error && this.state.error.message) || this.state.error);
          return h('div', { style: { padding: '10px 12px', fontSize: '12px', opacity: 0.75 } },
            'dsh-audit-skills 渲染失败，已隔离：' + msg);
        }
        return this.props.children;
      }
    }

    var S = {
      box: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' },
      bar: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      note: { fontSize: '12px', opacity: 0.8 },
      table: { fontSize: '12px', width: '100%', borderCollapse: 'collapse' },
      th: { textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid currentColor', opacity: 0.6, fontWeight: 500 },
      td: { padding: '4px 6px', borderBottom: '1px solid rgba(128,128,128,0.2)' },
      dim: { opacity: 0.45 },
    };

    function Panel() {
      var rowsState = useState(null);
      var rows = rowsState[0];
      var setRows = rowsState[1];
      var busyState = useState('');
      var busy = busyState[0];
      var setBusy = busyState[1];
      var noteState = useState('');
      var note = noteState[0];
      var setNote = noteState[1];

      var refresh = useCallback(async function () {
        setBusy('status');
        var r = await call('status');
        setBusy('');
        if (r && r.ok && Array.isArray(r.value)) setRows(r.value);
        else setNote('状态读取失败：' + ((r && r.message) || 'unknown'));
      }, []);

      useEffect(function () {
        refresh();
      }, [refresh]);

      var act = useCallback(async function (action, label) {
        setBusy(action);
        var r = await call(action);
        setBusy('');
        if (r && r.ok && Array.isArray(r.value)) {
          var n = r.value.filter(function (x) { return x.state === 'applied' || x.state === 'restored'; }).length;
          setNote(label + '完成：' + n + ' 项');
          await refresh();
        } else {
          setNote(label + '失败：' + ((r && r.message) || 'unknown'));
        }
      }, [refresh]);

      var head = h('div', { style: S.bar },
        h('button', { type: 'button', disabled: !!busy, onClick: function () { act('apply', '应用翻译精炼'); } }, '应用翻译精炼'),
        h('button', { type: 'button', disabled: !!busy, onClick: function () { act('revert', '还原翻译'); } }, '还原翻译'),
        h('button', { type: 'button', disabled: !!busy, onClick: refresh }, busy === 'status' ? '读取中…' : '刷新状态'));

      var body = rows === null
        ? h('div', { style: S.note }, '正在读取插件状态…')
        : h('table', { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, '插件'),
              h('th', { style: S.th }, '启用'),
              h('th', { style: S.th }, '精炼'),
              h('th', { style: S.th }, '插件页当前标题'))),
            h('tbody', null, rows.map(function (r) {
              return h('tr', { key: r.profileDir + '|' + r.pkg, style: r.installed ? undefined : S.dim },
                h('td', { style: S.td }, r.pkg),
                h('td', { style: S.td }, r.enabled ? '开' : '关'),
                h('td', { style: S.td }, r.needsText ? '待补文案' : (r.localized ? '已精炼' : '待精炼')),
                h('td', { style: S.td }, r.title || '—'));
            })));

      return h('div', { style: S.box },
        head,
        h('div', { style: S.note }, '命名约定：标题保留原包名，中文名以（）附加。本表只列已安装插件，与插件页口径一致。'),
        note ? h('div', { style: S.note }, note) : null,
        body,
        h('div', { style: S.note }, '更新检查 / 推荐 / 崩溃守护 已委托生态既有插件，本插件不重复实现。'));
    }

    function safe(what, fn) {
      try {
        fn();
      } catch (error) {
        var msg = String((error && error.message) || error);
        if (typeof console !== 'undefined' && console.warn) console.warn('dsh-audit-skills: ' + what + ' 注册失败: ' + msg);
      }
    }

    function apply(ctx) {
      safe('settings.section', function () {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-audit-skills',
            order: 200,
            label: function () { return LABEL; },
          }, function () { return h(Boundary, null, h(Panel)); });
        });
      });

      safe('plugins.row.config', function () {
        ctx.slots.inject('plugins.row.config', function () {
          return ctx.slots.register({
            name: 'plugins.row.config',
            key: 'dsh-audit-skills#dsh-audit-skills',
          }, function (slotProps) {
            return (slotProps && slotProps.view === 'summary')
              ? '插件说明中文化 · 状态汇总'
              : h(Boundary, null, h(Panel));
          });
        });
      });

      safe('betterSidebar.registerTab', function () {
        ctx.inject(['betterSidebar'], function (sctx) {
          var svc = sctx.get('betterSidebar');
          if (!svc || typeof svc.registerTab !== 'function') return;
          sctx.effect(function () {
            return svc.registerTab({
              id: 'dsh-audit-skills',
              title: LABEL,
              component: function () { return h(Boundary, null, h(Panel)); },
            });
          });
        });
      });
    }

    exports.name = 'dsh-audit-skills';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
