/* dsh-audit-skills — 客户端半体
 *
 * 形态要求（不可违反）：DSH 以传统 <script> 加载 client.js，
 * 不得有顶层 import/export，必须用 window.__ModuleLoader__.load({ id, factory }) 注册。
 * 改动后必须通过 scripts/preflight-client.mjs 与 scripts/regression.mjs 才能发布。
 *
 * 交互设计（三个按钮，职责互不重叠）：
 *   翻译优化 = 给缺文案的插件生成文案 + 应用全部精炼（生成是它的内置能力，不单独暴露）
 *   还原翻译 = 撤销已应用的精炼
 *   刷新     = 状态 + 版本比对（一次拿全，取代原先重复的「刷新状态」「检查更新」）
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
          if (!res.ok) return { ok: false, code: 'http-' + res.status, message: 'HTTP ' + res.status + '（接口 ' + action + ' 不存在？）' };
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
            issue.action && issue.action.kind === 'retry'
              ? h('button', { type: 'button', style: S.mini, onClick: props.onRetry }, issue.action.label)
              : null);
        }));
    }

    function Panel() {
      var rowsState = useState(null); var rows = rowsState[0]; var setRows = rowsState[1];
      var busyState = useState(''); var busy = busyState[0]; var setBusy = busyState[1];
      var noteState = useState(null); var note = noteState[0]; var setNote = noteState[1];
      var jobsState = useState({}); var jobs = jobsState[0]; var setJobs = jobsState[1];
      var openState = useState(''); var openPkg = openState[0]; var setOpenPkg = openState[1];
      var revState = useState(''); var hostRev = revState[0]; var setHostRev = revState[1];
      var staleState = useState(false); var stale = staleState[0]; var setStale = staleState[1];

      var absorb = useCallback(function (r) {
        if (r && typeof r.rev === 'string' && r.rev !== '') setHostRev(r.rev);
        else if (r && r.ok === false && /^http-4/.test(String(r.code))) setStale(true);
        return r;
      }, []);

      // 挂载时只取状态（快，不做 npm 比对）；需要版本比对请点「刷新」
      var loadStatus = useCallback(function () {
        return call('status').then(absorb).then(function (r) {
          if (r && r.ok && Array.isArray(r.value)) { setRows(r.value); return r.value; }
          setNote({ kind: 'err', text: '状态读取失败：' + ((r && r.message) || '未知') });
          return null;
        });
      }, [absorb]);

      useEffect(function () { loadStatus(); }, [loadStatus]);

      // 刷新 = 状态 + 版本比对，一次拿全
      var refresh = useCallback(function () {
        setBusy('refresh');
        setNote({ kind: 'note', text: '正在读取状态并比对 npm 版本…' });
        return call('updates').then(absorb).then(function (r) {
          setBusy('');
          if (r && r.ok && Array.isArray(r.value)) {
            setRows(r.value);
            var n = r.value.filter(function (x) { return x.hasUpdate === true; }).length;
            var unk = r.value.filter(function (x) { return x.hasUpdate === null; }).length;
            var pend = r.value.filter(function (x) { return x.needsText === true; }).length;
            setNote({ kind: n || pend ? 'note' : 'ok',
              text: '刷新完成：' + r.value.length + ' 个已装插件；' + n + ' 个有新版本；' + pend + ' 个缺文案' + (unk ? '；' + unk + ' 个无法比对' : '') });
          } else setNote({ kind: 'err', text: '刷新失败：' + ((r && r.message) || '未知') });
        });
      }, [absorb]);

      // 翻译优化：生成缺失文案（内置）→ 应用全部精炼 → 刷新
      var optimize = useCallback(function () {
        setBusy('optimize');
        setNote({ kind: 'note', text: '正在读取插件状态…' });
        return call('status').then(absorb).then(function (st) {
          if (!st || !st.ok || !Array.isArray(st.value)) {
            setBusy('');
            setNote({ kind: 'err', text: '状态读取失败，无法开始优化：' + ((st && st.message) || '未知') });
            return;
          }
          var pending = st.value.filter(function (r) { return r.needsText === true; });
          var genOk = 0;
          var genFail = [];
          var i = 0;
          var stepGen = function () {
            if (i >= pending.length) {
              setNote({ kind: 'note', text: '文案就绪，正在应用精炼…' });
              return call('apply').then(absorb).then(function (ap) {
                var applied = ap && Array.isArray(ap.value) ? ap.value.filter(function (x) { return x.state === 'applied'; }).length : 0;
                return loadStatus().then(function () {
                  setBusy('');
                  if (ap && ap.ok) {
                    setNote({ kind: genFail.length ? 'err' : 'ok',
                      text: '翻译优化完成：生成 ' + genOk + ' 条文案，应用 ' + applied + ' 项' +
                        (pending.length ? '（缺文案 ' + pending.length + ' 个）' : '') +
                        (genFail.length ? '；生成失败 ' + genFail.length + ' 个：' + genFail.join('、') : '') });
                  } else setNote({ kind: 'err', text: '应用精炼失败：' + ((ap && ap.message) || '未知') });
                });
              });
            }
            var pkg = pending[i].pkg;
            i += 1;
            setNote({ kind: 'note', text: '生成文案 ' + i + '/' + pending.length + '：' + pkg + ' …（调用模型，消耗 token）' });
            return call('generate', { pkg: pkg }).then(absorb).then(function (g) {
              if (g && g.ok) genOk += 1; else genFail.push(pkg + '（' + ((g && g.message) || '未知') + '）');
              return stepGen();
            });
          };
          return stepGen();
        });
      }, [absorb, loadStatus]);

      var revert = useCallback(function () {
        setBusy('revert');
        setNote({ kind: 'note', text: '正在还原…' });
        return call('revert').then(absorb).then(function (r) {
          var restored = r && Array.isArray(r.value) ? r.value.filter(function (x) { return x.state === 'restored'; }).length : 0;
          // 关键：绝不用 apply/revert 的返回值当表格行，必须重新取状态
          return loadStatus().then(function () {
            setBusy('');
            if (r && r.ok) setNote({ kind: 'ok', text: '还原完成：' + restored + ' 项' });
            else setNote({ kind: 'err', text: '还原失败：' + ((r && r.message) || '未知') });
          });
        });
      }, [absorb, loadStatus]);

      var doUpdate = useCallback(function (pkg) {
        setBusy('update:' + pkg);
        setJobs(function (prev) { var n = Object.assign({}, prev); n[pkg] = { stage: 'installing', message: '已提交，等待安装…', done: false }; return n; });
        setNote({ kind: 'note', text: '正在提交更新 ' + pkg + ' …' });
        return call('update', { pkg: pkg }).then(absorb).then(function (r) {
          if (!r || !r.ok) {
            setBusy('');
            setJobs(function (prev) { var n = Object.assign({}, prev); delete n[pkg]; return n; });
            var code = (r && r.code) || 'unknown';
            var fix = code === 'manager-unavailable'
              ? '插件管理器服务未就绪，重启 DSH 后可重试。'
              : code === 'unsupported-spec'
                ? '该包是内置或本地依赖，请在插件页处理。'
                : /^http-4/.test(String(code))
                  ? '宿主半体没有这个接口（运行的是启动时加载的旧代码）→ 请重启 DSH。'
                  : '可在插件页重试，或手动执行 pnpm install。';
            setNote({ kind: 'err', text: pkg + ' 更新未启动：' + ((r && r.message) || '未知') + ' → ' + fix });
            return;
          }
          var plan = r.plan || {};
          setNote({ kind: 'note', text: pkg + ' 更新已启动（' + plan.kind + '：' + plan.spec + '），正在执行 pnpm…' });
          var n = 0;
          var tick = function () {
            n += 1;
            call('update-status', { token: r.token }).then(absorb).then(function (s) {
              var job = s && s.ok ? s.job : null;
              if (job) {
                setJobs(function (prev) { var x = Object.assign({}, prev); x[pkg] = job; return x; });
                if (job.done) {
                  setBusy('');
                  setNote(job.ok
                    ? { kind: 'ok', text: pkg + ' 更新完成：' + job.message }
                    : { kind: 'err', text: pkg + ' 更新失败：' + job.message + ' → 可在插件页重试，或手动执行 pnpm install。' });
                  loadStatus();
                  return;
                }
              }
              if (n < 240) setTimeout(tick, 1500);
              else { setBusy(''); setNote({ kind: 'err', text: pkg + ' 更新超时，仍在后台执行；稍后点「刷新」看版本是否变化。' }); }
            });
          };
          tick();
        });
      }, [absorb, loadStatus]);

      var head = h('div', { style: S.bar },
        h('button', { type: 'button', disabled: !!busy, onClick: optimize }, busy === 'optimize' ? '优化中…' : '翻译优化'),
        h('button', { type: 'button', disabled: !!busy, onClick: revert }, busy === 'revert' ? '还原中…' : '还原翻译'),
        h('button', { type: 'button', disabled: !!busy, onClick: refresh }, busy === 'refresh' ? '刷新中…' : '刷新'));

      var staleEl = stale
        ? h('div', { style: S.err }, '⚠ 宿主半体版本过旧：运行中的是进程启动时加载的代码，因此缺少新接口。请重启 DSH 后重试。')
        : null;

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
              return h('tr', { key: r.profileDir + '|' + r.pkg, style: r.installed === false ? S.dim : undefined }, cells);
            })));

      var openRow = rows ? rows.filter(function (r) { return r.pkg === openPkg; })[0] : null;
      var detail = openRow && (openRow.issues || []).length
        ? h(IssueCard, { pkg: openRow.pkg, issues: openRow.issues, onRetry: refresh })
        : null;

      return h('div', { style: S.box },
        head,
        h('div', { style: S.note }, '命名约定：标题保留原包名，中文名以（）附加。数据源与插件页一致（第一方 pluginManager）。'),
        staleEl,
        noteEl,
        table,
        detail,
        h('div', { style: S.note }, '翻译优化会调用模型为缺失文案的插件生成中文（消耗 token），结果存入覆盖层，重装不丢；更新经第一方插件管理器执行，会真实运行 pnpm 并可能触发重载。' + (hostRev ? '  宿主半体 v' + hostRev : '')));
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
              ? '插件说明中文化 · 翻译优化 · 状态与更新'
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
