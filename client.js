/* dsh-audit-skills — 客户端半体
 *
 * 形态要求（不可违反）：DSH 以传统 <script> 加载 client.js，
 * 不得有顶层 import/export，必须用 window.__ModuleLoader__.load({ id, factory }) 注册。
 * 改动后必须通过 scripts/preflight-client.mjs 与 scripts/regression.mjs 才能发布。
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
    var useRef = react.useRef;
    var useState = react.useState;

    var BRIDGE = '/api/dsh-audit-skills';
    var LABEL = '技能审查';
    var POLL_MS = 1500;
    var POLL_MAX = 240;

    function call(action, body) {
      return fetch(BRIDGE + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then(function (res) {
          if (!res.ok) return { ok: false, code: 'http-' + res.status, message: 'HTTP ' + res.status };
          return res.json();
        })
        .catch(function (error) {
          return { ok: false, code: 'network', message: '无法连接宿主半体：' + String((error && error.message) || error) };
        });
    }

    class Boundary extends Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error: error }; }
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
      err: { fontSize: '12px', color: 'var(--dsw-alias-label-error, #d33)' },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-label-success, #2a2)' },
      table: { fontSize: '12px', width: '100%', borderCollapse: 'collapse' },
      th: { textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid currentColor', opacity: 0.6, fontWeight: 500 },
      td: { padding: '4px 6px', borderBottom: '1px solid rgba(128,128,128,0.2)' },
      dim: { opacity: 0.45 },
      mini: { fontSize: '11px', padding: '2px 8px' },
      prog: { height: '4px', background: 'rgba(128,128,128,0.25)', borderRadius: '2px', overflow: 'hidden' },
      progBar: { height: '100%', width: '35%', background: 'currentColor', opacity: 0.5 },
      card: { border: '1px solid rgba(128,128,128,0.3)', borderRadius: '6px', padding: '8px 10px', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' },
    };

    function IssueCard(props) {
      var issues = props.issues || [];
      if (issues.length === 0) return null;
      return h('div', { style: S.card },
        h('div', { style: { fontWeight: 600 } }, props.pkg),
        issues.map(function (issue, i) {
          return h('div', { key: String(i), style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            h('div', null, '⚠ ' + issue.reason),
            h('div', { style: S.note }, '→ 解决办法：' + issue.remedy),
            issue.action
              ? (issue.action.kind === 'retry'
                  ? h('button', { type: 'button', style: S.mini, onClick: props.onRetry }, issue.action.label)
                  : h('span', { style: S.note }, '[ ' + issue.action.label + (issue.action.path ? '：' + issue.action.path : '') + ' ]'))
              : null);
        }));
    }

    function Panel() {
      var rowsState = useState(null); var rows = rowsState[0]; var setRows = rowsState[1];
      var busyState = useState(''); var busy = busyState[0]; var setBusy = busyState[1];
      var noteState = useState(null); var note = noteState[0]; var setNote = noteState[1];
      var jobsState = useState({}); var jobs = jobsState[0]; var setJobs = jobsState[1];
      var openState = useState(''); var openPkg = openState[0]; var setOpenPkg = openState[1];
      var timers = useRef({});

      var refresh = useCallback(function () {
        setBusy('status');
        return call('status').then(function (r) {
          setBusy('');
          if (r && r.ok && Array.isArray(r.value)) { setRows(r.value); return r.value; }
          setNote({ kind: 'err', text: '状态读取失败：' + ((r && r.message) || '未知') + '；若插件刚被重装，请刷新页面。' });
          return null;
        });
      }, []);

      useEffect(function () { refresh(); }, [refresh]);

      // 轮询更新进度：页面不冻结，阶段变化实时可见
      var watch = useCallback(function (pkg, token) {
        var n = 0;
        var tick = function () {
          n += 1;
          call('update-status', { token: token }).then(function (r) {
            var job = r && r.ok ? r.job : null;
            if (job) {
              setJobs(function (prev) { var next = Object.assign({}, prev); next[pkg] = job; return next; });
              if (job.done) {
                setNote(job.ok
                  ? { kind: 'ok', text: pkg + ' 更新完成。' + job.message }
                  : { kind: 'err', text: pkg + ' 更新失败：' + job.message + ' —— 可在插件页重试，或手动执行 pnpm install。' });
                refresh();
                return;
              }
            }
            if (n < POLL_MAX) timers.current[pkg] = setTimeout(tick, POLL_MS);
            else setNote({ kind: 'err', text: pkg + ' 更新超时，仍在后台执行；稍后点「刷新状态」查看版本是否变化。' });
          });
        };
        tick();
      }, [refresh]);

      var doUpdate = useCallback(function (pkg) {
        setNote({ kind: 'note', text: '正在提交更新 ' + pkg + ' …' });
        call('update', { pkg: pkg }).then(function (r) {
          if (!r || !r.ok) {
            var code = r && r.code ? r.code : 'unknown';
            var fix = code === 'manager-unavailable'
              ? '插件管理器服务未就绪，重启 DSH 后可重试。'
              : code === 'unsupported-spec'
                ? '该包是内置或本地依赖，请在插件页处理。'
                : '请在插件页重试，或手动执行 pnpm install。';
            setNote({ kind: 'err', text: pkg + ' 更新未启动：' + ((r && r.message) || '未知') + ' → ' + fix });
            return;
          }
          var plan = r.plan || {};
          setNote({ kind: 'note', text: pkg + ' 更新已启动（' + plan.kind + '：' + plan.spec + '），正在执行…' });
          setJobs(function (prev) { var next = Object.assign({}, prev); next[pkg] = { stage: 'installing', message: '已提交，等待安装…', done: false }; return next; });
          watch(pkg, r.token);
        });
      }, [watch]);

      var act = useCallback(function (action, label) {
        setBusy(action);
        return call(action).then(function (r) {
          setBusy('');
          if (r && r.ok && Array.isArray(r.value)) {
            setRows(r.value);
            var n = r.value.filter(function (x) { return x.state === 'applied' || x.state === 'restored'; }).length;
            var skipped = r.value.filter(function (x) { return x.state === 'needs-catalog'; });
            setNote({ kind: 'ok', text: label + '完成：' + n + ' 项' + (skipped.length ? '；' + skipped.length + ' 项缺文案（见下表 ⚠）' : '') });
          } else {
            setNote({ kind: 'err', text: label + '失败：' + ((r && r.message) || '未知') });
          }
        });
      }, []);

      var checkUpdates = useCallback(function () {
        setBusy('updates');
        setNote({ kind: 'note', text: '正在查询 npm 最新版本…' });
        return call('updates').then(function (r) {
          setBusy('');
          if (r && r.ok && Array.isArray(r.value)) {
            setRows(r.value);
            var n = r.value.filter(function (x) { return x.hasUpdate === true; }).length;
            var unk = r.value.filter(function (x) { return x.hasUpdate === null; }).length;
            setNote({ kind: n ? 'note' : 'ok', text: '检查更新完成：' + r.value.length + ' 个已装插件，' + n + ' 个有新版本' + (unk ? '，' + unk + ' 个无法比对（详见 ⚠）' : '') });
          } else setNote({ kind: 'err', text: '检查更新失败：' + ((r && r.message) || '未知') });
        });
      }, []);

      var head = h('div', { style: S.bar },
        h('button', { type: 'button', disabled: !!busy, onClick: function () { act('apply', '应用翻译精炼'); } }, '应用翻译精炼'),
        h('button', { type: 'button', disabled: !!busy, onClick: function () { act('revert', '还原翻译'); } }, '还原翻译'),
        h('button', { type: 'button', disabled: !!busy, onClick: refresh }, busy === 'status' ? '读取中…' : '刷新状态'),
        h('button', { type: 'button', disabled: !!busy, onClick: checkUpdates }, busy === 'updates' ? '检查中…' : '检查更新'));

      var noteEl = note
        ? h('div', { style: note.kind === 'err' ? S.err : note.kind === 'ok' ? S.ok : S.note }, note.text)
        : null;

      var table = rows === null
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
              var job = jobs[r.pkg];
              var issues = r.issues || [];
              var cells = [
                h('td', { style: S.td }, r.pkg),
                h('td', { style: S.td }, r.enabled ? '开' : '关'),
                h('td', { style: S.td }, r.needsText ? '待补文案' : (r.localized ? '已精炼' : '待精炼')),
                h('td', { style: S.td }, r.version || '—'),
                h('td', { style: S.td }, r.latest ? (upd ? '↑ ' + r.latest : r.latest) : (r.reason || '—')),
              ];
              var op = [];
              if (job && !job.done) op.push(h('span', { key: 'j', style: S.note }, job.stage + '…'));
              else if (upd) op.push(h('button', { key: 'u', type: 'button', style: S.mini, disabled: !!busy, onClick: function () { doUpdate(r.pkg); } }, '更新'));
              if (issues.length) op.push(h('button', { key: 'i', type: 'button', style: S.mini, onClick: function () { setOpenPkg(openPkg === r.pkg ? '' : r.pkg); } }, '⚠ 问题'));
              cells.push(h('td', { style: S.td }, op.length ? op : null));
              var tr = h('tr', { key: r.profileDir + '|' + r.pkg, style: r.installed === false ? S.dim : undefined }, cells);
              if (job && !job.done) {
                return [tr, h('tr', { key: r.pkg + '-prog' }, h('td', { colSpan: 6, style: S.td }, h('div', { style: S.prog }, h('div', { style: S.progBar }))))];
              }
              return tr;
            })));

      var openRow = rows ? rows.filter(function (r) { return r.pkg === openPkg; })[0] : null;
      var detail = openRow && (openRow.issues || []).length
        ? h(IssueCard, { pkg: openRow.pkg, issues: openRow.issues, onRetry: checkUpdates })
        : null;

      return h('div', { style: S.box },
        head,
        h('div', { style: S.note }, '命名约定：标题保留原包名，中文名以（）附加。数据源与插件页一致（第一方 pluginManager）。'),
        noteEl,
        table,
        detail,
        h('div', { style: S.note }, '更新经第一方插件管理器执行（自带锁与回滚），会真实运行 pnpm 并可能触发重载；推荐与崩溃守护仍委托生态既有插件。'));
    }

    function safe(what, fn) {
      try { return fn(); } catch (error) {
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
      safe('inject:slots', function () {
        ctx.inject(['slots'], function (sctx) { registerAll(sctx); });
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
