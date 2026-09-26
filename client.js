/* dsh-audit-skills — 客户端半体
 *
 * 形态要求（不可违反）：DSH 以传统 <script> 加载 client.js，
 * 不得有顶层 import/export，必须用 window.__ModuleLoader__.load({ id, factory }) 注册。
 * 改动后必须通过 scripts/preflight-client.mjs 与 scripts/crash-rehearsal.mjs 才能发布。
 *
 * ── 单一快照原则（本文件最重要的不变量） ──
 * 表格行只有**一个**来源：snapshot() → POST /updates（含 状态 + 已装版本 + 最新版本 + 问题）。
 * 任何操作的返回值（/apply、/revert、/update）**一律不得进入表格**，只用于汇总文案。
 * 这样才不会出现「应用后数量 ≠ 刷新后数量」「点更新后状态回退」这类不一致。
 *
 * 按钮职责：
 *   翻译优化 = 生成缺失文案 + 应用全部精炼 + snapshot
 *   还原翻译 = 撤销 + snapshot
 *   刷新     = 重新取一次完整快照（状态 + 版本 + 更新检查，三者本就是一体的）
 *   一键更新 = 串行更新所有有更新的插件 + snapshot
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
    var POLL_MS = 1500;
    var POLL_MAX = 240;

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

    function fixOf(code) {
      if (code === 'manager-unavailable') return '插件管理器服务未就绪，重启 DSH 后可重试。'
      if (code === 'unsupported-spec') return '该包是内置或本地依赖，请在插件页处理。'
      if (/^http-4/.test(String(code))) return '宿主半体没有这个接口（运行的是启动时加载的旧代码）→ 请重启 DSH。'
      if (code === 'llm-unavailable') return 'LLM 服务不可用，请确认 DSH 已挂载 llm 服务。'
      if (code === 'no-model') return '找不到默认模型，请先在设置中选定默认模型。'
      if (code === 'bad-output') return '模型输出不是约定 JSON，可重试；若反复失败请手动补录。'
      return '可重试，或到插件页处理。'
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
      sum: { fontSize: '12px', opacity: 0.9, display: 'flex', gap: '12px', flexWrap: 'wrap' },
      table: { fontSize: '12px', width: '100%', borderCollapse: 'collapse' },
      th: { textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid currentColor', opacity: 0.6, fontWeight: 500 },
      td: { padding: '4px 6px', borderBottom: '1px solid rgba(128,128,128,0.2)' },
      dim: { opacity: 0.45 },
      mini: { fontSize: '11px', padding: '2px 8px' },
      card: { border: '1px solid rgba(128,128,128,0.3)', borderRadius: '6px', padding: '8px 10px', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' },
    };

    function summarize(rows) {
      var total = rows.length;
      var refined = rows.filter(function (r) { return r.localized === true; }).length;
      var pending = rows.filter(function (r) { return r.needsText === true; }).length;
      var toApply = rows.filter(function (r) { return r.localized !== true; }).length;
      var upd = rows.filter(function (r) { return r.hasUpdate === true; }).length;
      var unk = rows.filter(function (r) { return r.hasUpdate === null; }).length;
      return { total: total, refined: refined, pending: pending, toApply: toApply, upd: upd, unk: unk };
    }

    var SEV = { high: '高', medium: '中', low: '低' };

    function FindingCard(props) {
      var all = props.findings || [];
      if (all.length === 0) return null;
      var facts = all.filter(function (f) { return f.confidence === 'fact'; });
      var inferred = all.filter(function (f) { return f.confidence !== 'fact'; });
      var render = function (f) {
        return h('div', { key: f.id, style: { display: 'flex', flexDirection: 'column', gap: '2px', paddingBottom: '4px' } },
          h('div', null, '[' + f.kind + ' · ' + (f.confidence === 'fact' ? '事实' : '推断') + ' · ' + (SEV[f.severity] || f.severity) + '] ' + f.title),
          h('div', { style: { fontSize: '11px', opacity: 0.6, paddingLeft: '10px' } }, '证据：' + f.evidence),
          h('div', { style: { fontSize: '11px', paddingLeft: '10px' } }, '建议：' + f.remedy),
          h('div', { style: { paddingLeft: '10px' } },
            h('button', { type: 'button', style: S.mini, disabled: !!props.busy, onClick: function () { props.onIgnore(f.id); } }, '忽略此条')));
      };
      return h('div', { style: S.card },
        h('div', { style: { fontWeight: 600 } }, props.pkg),
        facts.length ? h('div', { style: { fontSize: '11px', opacity: 0.7 } }, '事实（' + facts.length + '）') : null,
        facts.map(render),
        inferred.length
          ? h('details', { style: { fontSize: '11px' } },
              h('summary', { style: { opacity: 0.7, cursor: 'pointer' } }, '另有 ' + inferred.length + ' 条推断（仅供知悉）'),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '4px' } }, inferred.map(render)))
          : null);
    }

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

    function Panel(props) {
      var TARGET = (props && props.target) || 'plugin';
      var IS_SKILL = TARGET === 'skill';
      var rowsState = useState(null); var rows = rowsState[0]; var setRows = rowsState[1];
      var busyState = useState(''); var busy = busyState[0]; var setBusy = busyState[1];
      var noteState = useState(null); var note = noteState[0]; var setNote = noteState[1];
      var jobsState = useState({}); var jobs = jobsState[0]; var setJobs = jobsState[1];
      var openState = useState(''); var openPkg = openState[0]; var setOpenPkg = openState[1];
      var revState = useState(''); var hostRev = revState[0]; var setHostRev = revState[1];
      var staleState = useState(false); var stale = staleState[0]; var setStale = staleState[1];
      var batchState = useState(null); var batch = batchState[0]; var setBatch = batchState[1];
      var auditState = useState(null); var audit = auditState[0]; var setAudit = auditState[1];
      var onlyState = useState(false); var onlyFlagged = onlyState[0]; var setOnlyFlagged = onlyState[1];

      var absorb = useCallback(function (r) {
        if (r && typeof r.rev === 'string' && r.rev !== '') setHostRev(r.rev);
        else if (r && r.ok === false && /^http-4/.test(String(r.code))) setStale(true);
        return r;
      }, []);

      // 唯一的数据入口：完整快照（状态 + 已装版本 + 最新版本 + 问题）
      var snapshot = useCallback(function (opts) {
        return call(IS_SKILL ? 'skills' : 'updates', opts || {}).then(absorb).then(function (r) {
          if (r && r.ok && Array.isArray(r.value)) { setRows(r.value); if (r.audit) setAudit(r.audit); return r.value; }
          setNote({ kind: 'err', text: '读取失败：' + ((r && r.message) || '未知') });
          return null;
        });
      }, [absorb]);

      useEffect(function () { snapshot(); }, [snapshot]);

      // 批量更新由宿主侧串行执行，客户端只轮询 —— 因此本插件被重新加载后仍能看到进度与结果
      var pollBatch = useCallback(function () {
        return call('update-all-status').then(absorb).then(function (r) {
          var b = r && r.ok ? r.batch : null
          setBatch(b)
          if (b && b.running === true) {
            return new Promise(function (resolve) { setTimeout(resolve, POLL_MS) }).then(pollBatch)
          }
          return b
        })
      }, [absorb]);

      // 挂载时恢复：上次批量若还在跑就继续显示，刚结束就把结果如实报出来
      useEffect(function () {
        call('update-all-status').then(absorb).then(function (r) {
          var b = r && r.ok ? r.batch : null
          if (!b) return
          setBatch(b)
          if (b.running === true) {
            setBusy('update:all')
            pollBatch().then(function () { setBusy(''); snapshot({ force: true }); });
          } else if (typeof b.finishedAt === 'number' && Date.now() - b.finishedAt < 10 * 60 * 1000) {
            setNote({ kind: /失败 [1-9]|未变化 [1-9]/.test(String(b.message)) ? 'note' : 'ok', text: '上次批量更新：' + String(b.message) });
          }
        });
      }, [absorb, pollBatch, snapshot]);

      var refresh = useCallback(function () {
        setBusy('refresh');
        setNote({ kind: 'note', text: '正在刷新（状态 + 版本 + 更新检查）…' });
        return snapshot({ force: true }).then(function (v) {
          setBusy('');
          if (v) {
            var s = summarize(v);
            setNote({ kind: s.upd || s.pending ? 'note' : 'ok',
              text: '刷新完成：已装 ' + s.total + '，已优化 ' + s.refined + '，待应用 ' + s.toApply + '，待生成文案 ' + s.pending + '，可更新 ' + s.upd + (s.unk ? '，无法比对 ' + s.unk : '') });
          }
        });
      }, [snapshot]);

      // 翻译优化：生成缺失文案（内置能力）→ 应用全部精炼 → 重新取快照
      var optimize = useCallback(function () {
        setBusy('optimize');
        setNote({ kind: 'note', text: '正在读取状态…' });
        return snapshot().then(function (cur) {
          if (!cur) { setBusy(''); return; }
          // 跳过已优化的：needsText = 压根没有文案（要生成）；未 localized = 有文案但未落盘（要应用）
          var pending = cur.filter(function (r) { return r.needsText === true; });
          var toApply = cur.filter(function (r) { return r.localized !== true; });
          var skipped = cur.length - toApply.length;
          if (toApply.length === 0) {
            setBusy('');
            setNote({ kind: 'ok', text: '全部 ' + cur.length + ' 个插件均已优化，无需处理。' });
            return;
          }
          var genOk = 0;
          var genFail = [];
          var i = 0;
          var stepGen = function () {
            if (i >= pending.length) {
              setNote({ kind: 'note', text: '文案就绪，正在应用（' + toApply.length + ' 个，跳过已优化 ' + skipped + ' 个）…' });
              // 只对这些包应用，已优化的一律不碰
              return call('apply', { pkgs: toApply.map(function (r) { return r.pkg; }) }).then(absorb).then(function (ap) {
                var applied = ap && Array.isArray(ap.value) ? ap.value.filter(function (x) { return x.state === 'applied'; }).length : 0;
                return snapshot({ force: true }).then(function (v) {
                  setBusy('');
                  if (!ap || !ap.ok) { setNote({ kind: 'err', text: '应用失败：' + ((ap && ap.message) || '未知') }); return; }
                  var s = v ? summarize(v) : null;
                  setNote({ kind: genFail.length ? 'err' : 'ok',
                    text: '翻译优化完成：新生成 ' + genOk + ' 条文案，应用 ' + applied + ' 项，跳过已优化 ' + skipped + ' 个' +
                      (s ? '；当前已优化 ' + s.refined + '/' + s.total : '') +
                      (genFail.length ? '；生成失败 ' + genFail.length + ' 个：' + genFail.join('、') : '') });
                });
              });
            }
            var pkg = pending[i].pkg;
            i += 1;
            setNote({ kind: 'note', text: '生成文案 ' + i + '/' + pending.length + '：' + pkg + ' …（调用模型，消耗 token）' });
            return call('generate', { pkg: pkg }).then(absorb).then(function (g) {
              if (g && g.ok) genOk += 1; else genFail.push(pkg);
              return stepGen();
            });
          };
          return stepGen();
        });
      }, [absorb, snapshot]);

      var revert = useCallback(function () {
        setBusy('revert');
        setNote({ kind: 'note', text: '正在还原…' });
        return call('revert').then(absorb).then(function (r) {
          var restored = r && Array.isArray(r.value) ? r.value.filter(function (x) { return x.state === 'restored'; }).length : 0;
          return snapshot({ force: true }).then(function (v) {
            setBusy('');
            var s = v ? summarize(v) : null;
            if (r && r.ok) setNote({ kind: 'ok', text: '还原完成：' + restored + ' 项' + (s ? '；当前已优化 ' + s.refined : '') });
            else setNote({ kind: 'err', text: '还原失败：' + ((r && r.message) || '未知') });
          });
        });
      }, [absorb, snapshot]);

      // 更新单个插件，返回一个在完成/失败时 resolve 的 Promise
      var updateOne = useCallback(function (pkg) {
        setJobs(function (prev) { var n = Object.assign({}, prev); n[pkg] = { stage: 'installing', message: '已提交…', done: false }; return n; });
        return call('update', { pkg: pkg }).then(absorb).then(function (r) {
          if (!r || !r.ok) {
            setJobs(function (prev) { var n = Object.assign({}, prev); delete n[pkg]; return n; });
            return { ok: false, pkg: pkg, code: (r && r.code) || 'unknown', message: (r && r.message) || '未知' };
          }
          return new Promise(function (resolve) {
            var n = 0;
            var tick = function () {
              n += 1;
              call('update-status', { token: r.token }).then(absorb).then(function (s) {
                var job = s && s.ok ? s.job : null;
                if (job) {
                  setJobs(function (prev) { var x = Object.assign({}, prev); x[pkg] = job; return x; });
                  if (job.done) {
                    setJobs(function (prev) { var x = Object.assign({}, prev); delete x[pkg]; return x; });
                    resolve({ ok: job.ok === true, pkg: pkg, code: job.ok ? null : 'update-failed', message: job.message });
                    return;
                  }
                }
                if (n < POLL_MAX) setTimeout(tick, POLL_MS);
                else { setJobs(function (prev) { var x = Object.assign({}, prev); delete x[pkg]; return x; }); resolve({ ok: false, pkg: pkg, code: 'timeout', message: '超时（可能仍在后台执行）' }); }
              });
            };
            tick();
          });
        });
      }, [absorb]);

      var doUpdate = useCallback(function (pkg) {
        setBusy('update:' + pkg);
        setNote({ kind: 'note', text: '正在更新 ' + pkg + ' …' });
        return updateOne(pkg).then(function (res) {
          setBusy('');
          return snapshot({ force: true }).then(function () {
            if (res.ok) setNote({ kind: 'ok', text: pkg + ' 更新完成，状态已刷新。' });
            else setNote({ kind: 'err', text: pkg + ' 更新失败：' + res.message + ' → ' + fixOf(res.code) });
          });
        });
      }, [snapshot, updateOne]);

      var updateAll = useCallback(function (list) {
        var pend = (list || []).filter(function (r) { return r.hasUpdate === true; }).map(function (r) { return r.pkg; });
        if (pend.length === 0) { setNote({ kind: 'ok', text: '没有可更新的插件。' }); return; }
        setBusy('update:all');
        setNote({ kind: 'note', text: '已提交批量更新（' + pend.length + ' 个），由宿主侧串行执行…' });
        return call('update-all', { pkgs: pend }).then(absorb).then(function (r) {
          if (!r || !r.ok) {
            setBusy('');
            setNote({ kind: 'err', text: '批量更新未启动：' + ((r && r.message) || '未知') + ' → ' + fixOf(r && r.code) });
            return;
          }
          return pollBatch().then(function (b) {
            setBusy('');
            return snapshot({ force: true }).then(function () {
              if (!b) { setNote({ kind: 'err', text: '批量更新状态丢失，请刷新状态查看结果。' }); return; }
              setNote({ kind: /失败 [1-9]/.test(String(b.message)) ? 'err' : (/未变化 [1-9]/.test(String(b.message)) ? 'note' : 'ok'), text: '批量更新' + String(b.message) });
            });
          });
        });
      }, [absorb, pollBatch, snapshot]);

      var ignore = useCallback(function (id) {
        setBusy('ignore:' + id);
        return call('ignore', { id: id }).then(absorb).then(function (r) {
          setBusy('');
          if (!r || !r.ok) { setNote({ kind: 'err', text: '忽略失败：' + ((r && r.message) || '未知') }); return; }
          setNote({ kind: 'ok', text: '已忽略该条，刷新后不再显示。' });
          return snapshot({ force: true });
        });
      }, [absorb, snapshot]);

      var s = rows ? summarize(rows) : null;

      var head = h('div', { style: S.bar },
        IS_SKILL
          ? h('button', { type: 'button', disabled: !!busy, onClick: refresh }, busy === 'refresh' ? '刷新中…' : '刷新状态')
          : h('button', { type: 'button', disabled: !!busy, onClick: optimize }, busy === 'optimize' ? '优化中…' : '翻译优化'),
        IS_SKILL
          ? null
          : h('button', { type: 'button', disabled: !!busy, onClick: revert }, busy === 'revert' ? '还原中…' : '还原翻译'),
        IS_SKILL
          ? null
          : h('button', { type: 'button', disabled: !!busy, onClick: refresh }, busy === 'refresh' ? '刷新中…' : '刷新状态'),
        (!IS_SKILL && s && s.upd > 0)
          ? h('button', { type: 'button', disabled: !!busy, onClick: function () { updateAll(rows); } },
              busy === 'update:all' ? '批量更新中…' : '一键更新（' + s.upd + '）')
          : null);

      var staleEl = stale
        ? h('div', { style: S.err }, '⚠ 宿主半体版本过旧：运行中的是进程启动时加载的代码，因此缺少新接口。请重启 DSH 后重试。')
        : null;

      var noteEl = note
        ? h('div', { style: note.kind === 'err' ? S.err : note.kind === 'ok' ? S.ok : S.note }, note.text)
        : null;

      var summaryEl = s
        ? h('div', { style: S.sum },
            h('span', null, '已装 ' + s.total),
            h('span', null, '已优化 ' + s.refined),
            h('span', null, '待应用 ' + s.toApply),
            h('span', null, '待生成文案 ' + s.pending),
            h('span', null, '可更新 ' + s.upd),
            s.unk ? h('span', null, '无法比对 ' + s.unk) : null,
            audit && (audit.counts.fact + audit.counts.inferred) > 0
              ? h('button', { type: 'button', style: S.mini, onClick: function () { setOnlyFlagged(!onlyFlagged); } },
                  onlyFlagged ? '显示全部' : ('审查 ⚠' + audit.counts.fact + ' 事实 / ' + audit.counts.inferred + ' 推断'))
              : h('span', null, '审查 无发现'))
        : null;

      var batchEl = batch && Array.isArray(batch.items) && batch.items.length > 0
        ? h('div', { style: S.card },
            h('div', { style: { fontWeight: 600 } },
              '批量更新' + (batch.running === true ? '（进行中 ' + (batch.index + 1) + '/' + batch.total + '）' : '（已完成）')),
            batch.items.map(function (it) {
              var line = '· ' + it.pkg + '  [' + it.state + ']' + (it.message ? '  ' + it.message : '') + (it.refined === true ? '  精炼已保持' : '')
              var d = it.delta
              var deltaLine = null
              if (d) {
                if (d.source === 'changelog') deltaLine = '变更日志：' + String(d.text).slice(0, 200)
                else if (d.source === 'structure') {
                  deltaLine = (d.details && d.details.length)
                    ? '结构性变化（推断）：' + d.details.join('；')
                    : '未检出结构性变化（依赖与说明均未变）；该包无变更日志，无法判定是修复还是新增'
                  if (d.repoUrl) deltaLine += '  仓库：' + d.repoUrl
                } else deltaLine = '变更信息不可得'
              }
              return h('div', { key: it.pkg, style: { display: 'flex', flexDirection: 'column', gap: '1px' } },
                h('div', { style: S.note }, line),
                deltaLine ? h('div', { style: { fontSize: '11px', opacity: 0.65, paddingLeft: '12px' } }, deltaLine) : null)
            }))
        : null;

      var table = rows === null
        ? h('div', { style: S.note }, '正在读取插件状态…')
        : h('table', { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, IS_SKILL ? '技能' : '插件'),
              h('th', { style: S.th }, IS_SKILL ? '描述' : '优化'),
              h('th', { style: S.th }, '版本'),
              h('th', { style: S.th }, IS_SKILL ? '来源' : '最新'),
              h('th', { style: S.th }, '操作'))),
            h('tbody', null, (onlyFlagged
              ? rows.filter(function (r) { return (r.issues || []).length > 0 || (r.findings || []).length > 0; })
              : rows).map(function (r) {
              var upd = r.hasUpdate === true;
              var job = jobs[r.pkg];
              var issues = r.issues || [];
              var cells = [
                h('td', { style: S.td }, r.pkg),
                // 三态：已优化 / 待应用（有文案未落盘）/ 待优化（压根没有文案）
                h('td', { style: S.td },
                  (IS_SKILL
                    ? (r.needsText ? '描述为空' : r.descriptionLang)
                    : (r.localized ? '已优化' : (r.needsText ? '待优化' : '待应用'))) + (function () {
                    var fs2 = r.findings || [];
                    var facts = fs2.filter(function (f) { return f.confidence === 'fact'; });
                    if (facts.length === 0) return '';
                    var sev = facts.some(function (f) { return f.severity === 'high'; }) ? '高'
                      : (facts.some(function (f) { return f.severity === 'medium'; }) ? '中' : '低');
                    return '  ⚠' + sev;
                  })()),
                h('td', { style: S.td }, r.version || '—'),
                h('td', { style: S.td }, IS_SKILL
                  ? (r.source || '—') + (r.isGit ? ' · git 来源' : ' · 本地目录')
                  : (r.latest ? (upd ? '↑ ' + r.latest : r.latest) : (r.reason || '—'))),
              ];
              var op = [];
              if (job && !job.done) op.push(h('span', { key: 'j', style: S.note }, job.stage + '…'));
              else if (upd) op.push(h('button', { key: 'u', type: 'button', style: S.mini, disabled: !!busy, onClick: function () { doUpdate(r.pkg); } }, '更新'));
              if (issues.length || (r.findings || []).length) op.push(h('button', { key: 'i', type: 'button', style: S.mini, onClick: function () { setOpenPkg(openPkg === r.pkg ? '' : r.pkg); } }, '⚠ 详情'));
              cells.push(h('td', { style: S.td }, op.length ? op : null));
              return h('tr', { key: r.profileDir + '|' + r.pkg, style: r.installed === false ? S.dim : undefined }, cells);
            })));

      var openRow = rows ? rows.filter(function (r) { return r.pkg === openPkg; })[0] : null;
      var detail = openRow
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h(FindingCard, { pkg: openRow.pkg, findings: openRow.findings, onIgnore: ignore, busy: busy.indexOf('ignore:') === 0 }),
            (openRow.issues || []).length ? h(IssueCard, { pkg: openRow.pkg, issues: openRow.issues, onRetry: refresh }) : null)
        : null;

      return h('div', { style: S.box },
        head,
        h('div', { style: S.note }, IS_SKILL
          ? '技能页与插件页同构：一源数据、一套规则。技能不是 npm 包，因此没有可比的「最新版本」——「来源」列显示它来自哪个根目录与优先级。'
          : '命名约定：标题保留原包名，中文名以（）附加。刷新即包含状态、版本与更新检查（同一份快照）。'),
        staleEl,
        summaryEl,
        noteEl,
        batchEl,
        table,
        detail,
        h('div', { style: S.note }, IS_SKILL
          ? '技能页**只读**：技能的 description 是模型选择技能的依据，改写它属于行为变更而非展示变更，因此本页不代你改写 SKILL.md（如需翻译，用「技能翻译精炼」类技能或直接编辑）。' + (hostRev ? '  宿主半体 v' + hostRev : '')
          : '翻译优化会调用模型为缺失文案的插件生成中文（消耗 token），结果存入覆盖层，重装不丢；更新经第一方插件管理器执行，会真实运行 pnpm 并可能触发重载。' + (hostRev ? '  宿主半体 v' + hostRev : '')));
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
          return [
            sctx.slots.register({
              name: 'settings.section',
              id: 'dsh-audit-skills',
              order: 200,
              label: function () { return '插件审查'; },
            }, function () { return h(Boundary, null, h(Panel, { target: 'plugin' })); }),
            sctx.slots.register({
              name: 'settings.section',
              id: 'dsh-audit-skills-skills',
              order: 201,
              label: function () { return '技能审查'; },
            }, function () { return h(Boundary, null, h(Panel, { target: 'skill' })); }),
          ];
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
