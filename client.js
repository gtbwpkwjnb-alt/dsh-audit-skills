/* dsh-audit-skills — 客户端半体
 *
 * 形态要求（不可违反）：DSH 以传统 <script> 加载 client.js，
 * 不得有顶层 import/export，必须用 window.__ModuleLoader__.load({ id, factory }) 注册。
 * 改动后必须通过 scripts/preflight-client.mjs 才能发布。
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

    function call(action, body) {
      return fetch(BRIDGE + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then(function (res) {
          if (!res.ok) return { ok: false, message: 'HTTP ' + res.status };
          return res.json();
        })
        .catch(function (error) {
          return { ok: false, message: String((error && error.message) || error) };
        });
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
      warn: { fontSize: '12px', color: 'var(--dsw-alias-label-error, #d33)' },
      table: { fontSize: '12px', width: '100%', borderCollapse: 'collapse' },
      th: { textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid currentColor', opacity: 0.6, fontWeight: 500 },
      td: { padding: '4px 6px', borderBottom: '1px solid rgba(128,128,128,0.2)' },
      dim: { opacity: 0.45 },
      mini: { fontSize: '11px', padding: '2px 8px' },
    };

    function Panel() {
      var rowsState = useState(null); var rows = rowsState[0]; var setRows = rowsState[1];
      var busyState = useState(''); var busy = busyState[0]; var setBusy = busyState[1];
      var noteState = useState(''); var note = noteState[0]; var setNote = noteState[1];

      var refresh = useCallback(function () {
        setBusy('status');
        return call('status').then(function (r) {
          setBusy('');
          if (r && r.ok && Array.isArray(r.value)) setRows(r.value);
          else setNote('状态读取失败：' + ((r && r.message) || 'unknown'));
        });
      }, []);

      useEffect(function () { refresh(); }, [refresh]);

      var act = useCallback(function (action, label, body) {
        setBusy(action);
        return call(action, body).then(function (r) {
          setBusy('');
          if (r && r.ok && Array.isArray(r.value)) {
            var n = r.value.filter(function (x) { return x.state === 'applied' || x.state === 'restored'; }).length;
            setRows(r.value);
            setNote(label + '完成' + (action === 'status' ? '' : '：' + n + ' 项'));
          } else if (r && r.ok) {
            setNote(label + '完成');
          } else {
            setNote(label + '失败：' + ((r && r.message) || 'unknown'));
          }
          return r;
        });
      }, []);

      var checkUpdates = useCallback(function () {
        setBusy('updates');
        return call('updates').then(function (r) {
          setBusy('');
          if (r && r.ok && Array.isArray(r.value)) {
            setRows(r.value);
            var n = r.value.filter(function (x) { return x.hasUpdate === true; }).length;
            setNote('检查更新完成：' + r.value.length + ' 个已装插件，' + n + ' 个有新版本');
          } else setNote('检查更新失败：' + ((r && r.message) || 'unknown'));
        });
      }, []);

      var doUpdate = useCallback(function (pkg) {
        setBusy('update:' + pkg);
        setNote('正在更新 ' + pkg + ' …（由第一方插件管理器执行，可能触发重新加载）');
        return call('update', { pkg: pkg }).then(function (r) {
          setBusy('');
          if (r && r.ok) { setNote(pkg + ' 更新已提交，稍后请刷新页面'); refresh(); }
          else setNote(pkg + ' 更新失败：' + ((r && r.message) || 'unknown'));
        });
      }, [refresh]);

      var head = h('div', { style: S.bar },
        h('button', { type: 'button', disabled: !!busy, onClick: function () { act('apply', '应用翻译精炼'); } }, '应用翻译精炼'),
        h('button', { type: 'button', disabled: !!busy, onClick: function () { act('revert', '还原翻译'); } }, '还原翻译'),
        h('button', { type: 'button', disabled: !!busy, onClick: refresh }, busy === 'status' ? '读取中…' : '刷新状态'),
        h('button', { type: 'button', disabled: !!busy, onClick: checkUpdates }, busy === 'updates' ? '检查中…' : '检查更新'));

      var body = rows === null
        ? h('div', { style: S.note }, '正在读取插件状态…')
        : h('table', { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, '插件'),
              h('th', { style: S.th }, '启用'),
              h('th', { style: S.th }, '精炼'),
              h('th', { style: S.th }, '版本'),
              h('th', { style: S.th }, '最新'),
              h('th', { style: S.th }, '操作'))),
            h('tbody', null, rows.map(function (r) {
              var upd = r.hasUpdate === true;
              return h('tr', { key: r.profileDir + '|' + r.pkg, style: r.installed === false ? S.dim : undefined },
                h('td', { style: S.td }, r.pkg),
                h('td', { style: S.td }, r.enabled ? '开' : '关'),
                h('td', { style: S.td }, r.needsText ? '待补文案' : (r.localized ? '已精炼' : '待精炼')),
                h('td', { style: S.td }, r.version || '—'),
                h('td', { style: S.td }, r.latest ? (upd ? '↑ ' + r.latest : r.latest) : (r.reason || '—')),
                h('td', { style: S.td }, upd
                  ? h('button', { type: 'button', style: S.mini, disabled: !!busy, onClick: function () { doUpdate(r.pkg); } }, '更新')
                  : null));
            })));

      return h('div', { style: S.box },
        head,
        h('div', { style: S.note }, '命名约定：标题保留原包名，中文名以（）附加。本表数据源与插件页一致（第一方 pluginManager）。'),
        note ? h('div', { style: S.warn }, note) : null,
        body,
        h('div', { style: S.note }, '更新由第一方插件管理器执行（自带锁与回滚）；推荐与崩溃守护仍委托生态既有插件。'));
    }

    function safe(what, fn) {
      try {
        return fn();
      } catch (error) {
        var msg = String((error && error.message) || error);
        if (typeof console !== 'undefined' && console.warn) console.warn('dsh-audit-skills: ' + what + ' 注册失败: ' + msg);
        return undefined;
      }
    }

    function registerAll(sctx) {
      safe('settings.section', function () {
        sctx.slots.inject('settings.section', function () {
          return sctx.slots.register({
            name: 'settings.section',
            id: 'dsh-audit-skills',
            order: 200,
            label: function () { return LABEL; },
          }, function () { return h(Boundary, null, h(Panel)); });
        });
      });
      safe('plugins.row.config', function () {
        sctx.slots.inject('plugins.row.config', function () {
          return sctx.slots.register({
            name: 'plugins.row.config',
            key: 'dsh-audit-skills#dsh-audit-skills',
          }, function (slotProps) {
            return (slotProps && slotProps.view === 'summary')
              ? '插件说明中文化 · 状态与更新'
              : h(Boundary, null, h(Panel));
          });
        });
      });
    }

    function apply(ctx) {
      // 关键：经 ctx.inject 等待 slots 服务就绪再注册。
      // 之前直接访问 ctx.slots，若服务尚未挂载会被静默吞掉 —— 表现就是「按钮时有时无」。
      safe('inject:slots', function () {
        ctx.inject(['slots'], function (sctx) {
          registerAll(sctx);
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
