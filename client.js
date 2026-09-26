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
    var LABEL = '插件与技能审查';
    var POLL_MS = 1500;
    var POLL_MAX = 240;
    /* 本客户端半体的版本，必须等于 package.json 的 version —— regression.mjs 会断言。
       宿主半体只在 DSH 进程启动时加载一次，客户端半体会热更新；只有把两边的版本摆在一起，
       「按钮是新的、接口是旧的」才自解释，否则用户只能看到一个没头没尾的 404。 */
    var CLIENT_REV = '2.6.2';

    /** 比较点分版本号；非数字段按 0 算。 */
    function compareRev(a, b) {
      var pa = String(a === undefined || a === null ? '' : a).split('.');
      var pb = String(b === undefined || b === null ? '' : b).split('.');
      var n = Math.max(pa.length, pb.length);
      for (var i = 0; i < n; i += 1) {
        var x = parseInt(pa[i], 10); var y = parseInt(pb[i], 10);
        if (isNaN(x)) x = 0;
        if (isNaN(y)) y = 0;
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    }

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
      off: { opacity: 0.45, cursor: 'default' },
      card: { border: '1px solid rgba(128,128,128,0.3)', borderRadius: '6px', padding: '8px 10px', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' },
      tabs: { display: 'flex', gap: '2px', borderBottom: '1px solid rgba(128,128,128,0.25)' },
      tab: { fontSize: '12px', padding: '4px 12px', border: 'none', borderBottom: '2px solid transparent', background: 'none', color: 'inherit', opacity: 0.6, cursor: 'pointer' },
      tabOn: { fontSize: '12px', padding: '4px 12px', border: 'none', borderBottom: '2px solid currentColor', background: 'none', color: 'inherit', opacity: 1, fontWeight: 600, cursor: 'default' },
    };

    function summarize(rows, isSkill) {
      var total = rows.length;
      /* 技能侧：随 DSH 提供的技能在 app.asar 里，没有可写路径 —— 只入表并标注来源，
         不计入「待应用 / 待生成」，否则那几项永远是待办、还会在优化时去写写不了的文件。 */
      var active = isSkill ? rows.filter(function (r) { return r.bundled !== true; }) : rows;
      var refined = active.filter(function (r) { return r.localized === true; }).length;
      var pending = active.filter(function (r) { return r.needsText === true; }).length;
      var toApply = active.filter(function (r) { return r.localized !== true; }).length;
      var upd = rows.filter(function (r) { return r.hasUpdate === true; }).length;
      var unk = rows.filter(function (r) { return r.hasUpdate === null; }).length;
      return { total: total, refined: refined, pending: pending, toApply: toApply, upd: upd, unk: unk, bundled: total - active.length };
    }

    var SEV = { high: '高', medium: '中', low: '低' };

    /* ── 功能性按钮的统一规则（插件页与技能页共用同一套，两页只有「对象」不同） ──
     * 「不可用」一律表现为**暗下去**（disabled + 降透明度），不允许出现「看起来能点、点了没事发生」。
     * 判定只有两种：① 有操作在跑；② 此刻无待办（更新：无可更新；优化：无待优化；还原：无已优化条目）。 */
    var OUTCOME = { ok: '已更新', updated: '已更新', unchanged: '未变化', fail: '更新失败', failed: '更新失败', done: '已完成' };

    function outcomeLabel(entry) {
      var k = entry && entry.state;
      return OUTCOME[k] || '已完成';
    }

    /**
     * 统一按钮：off 为真即暗下去且不可点击（onClick 直接摘掉，避免只靠 disabled 属性）。
     * @param key - React key
     * @param label - 按钮文字
     * @param off - 是否暗下去
     * @param onClick - 可用时的动作
     * @param title - 悬停说明（暗下去时用来说明为什么不可用）
     * @param mini - 行内小按钮（S.mini）
     */
    function opBtn(key, label, off, onClick, title, mini) {
      var style = mini === true
        ? (off ? Object.assign({}, S.mini, S.off) : S.mini)
        : (off ? S.off : undefined);
      return h('button', {
        key: key,
        type: 'button',
        disabled: !!off,
        title: title === undefined || title === null ? undefined : title,
        style: style,
        onClick: off ? undefined : onClick,
      }, label);
    }

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
      /* 本次会话内已处理完的动作：把按钮**按结果暗下去**，而不是让它消失。
         消失会让人以为功能没了，也让「未变化 / 失败」这种仍然显示可更新的行看不出已经处理过。
         「刷新状态」= 重新判定，会清空这些标记，于是可以重试。 */
      var doneState = useState({}); var done = doneState[0]; var setDone = doneState[1];
      var settledState = useState(false); var batchSettled = settledState[0]; var setBatchSettled = settledState[1];

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

      /** 把宿主侧批量记录里的每一项结果记成「本轮已处理」，用于把对应行的按钮暗下去。 */
      var absorbBatch = function (b) {
        if (!b || !Array.isArray(b.items)) return;
        setDone(function (prev) {
          var n = Object.assign({}, prev);
          for (var i = 0; i < b.items.length; i += 1) {
            n[b.items[i].pkg] = { state: b.items[i].state, message: b.items[i].message };
          }
          return n;
        });
      };

      // 挂载时恢复：上次批量若还在跑就继续显示，刚结束就把结果如实报出来。
      // 技能视图直接跳过 —— 批量更新是插件专属动作，两页不共用这份状态。
      useEffect(function () {
        if (IS_SKILL) return;
        call('update-all-status').then(absorb).then(function (r) {
          var b = r && r.ok ? r.batch : null
          if (!b) return
          setBatch(b)
          if (b.running === true) {
            setBusy('update:all')
            pollBatch().then(function (bb) { setBusy(''); setBatchSettled(true); absorbBatch(bb); snapshot({ force: true }); });
          } else if (typeof b.finishedAt === 'number' && Date.now() - b.finishedAt < 10 * 60 * 1000) {
            // 上一轮批量已完成：按结果把按钮暗下去，直到用户「刷新状态」重新判定
            setBatchSettled(true);
            absorbBatch(b);
            setNote({ kind: /失败 [1-9]|未变化 [1-9]/.test(String(b.message)) ? 'note' : 'ok', text: '上次批量更新：' + String(b.message) });
          }
        });
      }, [absorb, pollBatch, snapshot]);

      var refresh = useCallback(function () {
        setBusy('refresh');
        // 刷新 = 重新判定：清掉「本轮已完成」标记，让按钮按新数据重新决定可用性
        setDone({});
        setBatchSettled(false);
        setNote({ kind: 'note', text: '正在刷新（状态 + 版本 + 更新检查）…' });
        return snapshot({ force: true }).then(function (v) {
          setBusy('');
          if (v) {
            var s = summarize(v, IS_SKILL);
            setNote({ kind: s.upd || s.pending ? 'note' : 'ok',
              text: '刷新完成：已装 ' + s.total + '，已优化 ' + s.refined + '，待应用 ' + s.toApply + '，待生成文案 ' + s.pending + '，可更新 ' + s.upd + (s.unk ? '，无法比对 ' + s.unk : '') });
          }
        });
      }, [snapshot]);

      // 翻译优化：生成缺失文案（内置能力）→ 应用全部精炼 → 重新取快照
      var optimize = useCallback(function () {
        setBusy('optimize');
        setNote({ kind: 'note', text: '正在读取状态…' });
        if (IS_SKILL) {
          return snapshot().then(function (cur) {
            if (!cur) { setBusy(''); return; }
            var pend = cur.filter(function (r) { return r.needsText === true; });
            // 随 DSH 提供的技能在 app.asar 内，没有可写路径：跳过，不算失败
            var toApplyS = cur.filter(function (r) { return r.bundled !== true && r.localized !== true; });
            if (toApplyS.length === 0) {
              setBusy('');
              setNote({ kind: 'ok', text: '全部 ' + cur.length + ' 个技能均已优化，无需处理。' });
              return;
            }
            var gOk = 0;
            var gFail = [];
            var si = 0;
            var stepSkill = function () {
              if (si >= pend.length) {
                setNote({ kind: 'note', text: '正在应用（' + toApplyS.length + ' 个，跳过 ' + (cur.length - toApplyS.length) + ' 个：已优化或随 DSH 提供）…' });
                return call('apply-skills', { pkgs: toApplyS.map(function (r) { return r.pkg; }) }).then(absorb).then(function (ap) {
                  var applied = ap && Array.isArray(ap.value) ? ap.value.filter(function (x) { return x.state === 'applied'; }).length : 0;
                  return snapshot({ force: true }).then(function (v) {
                    setBusy('');
                    if (!ap || !ap.ok) { setNote({ kind: 'err', text: '应用失败：' + ((ap && ap.message) || '未知') }); return; }
                    var ss = v ? summarize(v, true) : null;
                    setNote({ kind: gFail.length ? 'err' : 'ok',
                      text: '技能优化完成：新生成 ' + gOk + ' 条，应用 ' + applied + ' 项，跳过 ' + (cur.length - toApplyS.length) + ' 个（已优化或随 DSH 提供）' +
                        (ss ? '；当前已优化 ' + ss.refined + '/' + ss.total : '') +
                        (gFail.length ? '；生成失败 ' + gFail.length + ' 个：' + gFail.join('、') : '') });
                  });
                });
              }
              var pkg = pend[si].pkg;
              si += 1;
              setNote({ kind: 'note', text: '生成技能文案 ' + si + '/' + pend.length + '：' + pkg + ' …（调用模型，消耗 token）' });
              return call('generate-skill', { pkg: pkg }).then(absorb).then(function (g) {
                if (g && g.ok) gOk += 1; else gFail.push(pkg + '（' + ((g && g.message) || '未知') + '）');
                return stepSkill();
              });
            };
            return stepSkill();
          });
        }
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
        if (IS_SKILL) {
          return call('revert-skills').then(absorb).then(function (r) {
            var restored = r && Array.isArray(r.value) ? r.value.filter(function (x) { return x.state === 'restored'; }).length : 0;
            return snapshot({ force: true }).then(function () {
              setBusy('');
              if (r && r.ok) setNote({ kind: 'ok', text: '技能还原完成：' + restored + ' 项（SKILL.md 已按备份恢复）' });
              else setNote({ kind: 'err', text: '还原失败：' + ((r && r.message) || '未知') });
            });
          });
        }
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
          setDone(function (prev) {
            var n = Object.assign({}, prev);
            n[pkg] = { state: res.ok ? 'ok' : 'fail', message: res.message };
            return n;
          });
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
            setBatchSettled(true);
            // 宿主逐个给出结果：按结果把每一行的按钮暗下去。未变化/失败的行虽然仍可更新，
            // 但这一轮已经处理过，不再允许重复点击 —— 要重试先「刷新状态」重新判定。
            absorbBatch(b);
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

      var s = rows ? summarize(rows, IS_SKILL) : null;

      /* 两个页面共用同一套按钮规则：无待办即暗下去，且悬停说明原因。 */
      var busyNow = busy !== '';
      var noRows = s === null;
      var noOptimize = noRows || s.toApply === 0;          // 全部条目都已优化 → 无待办
      var noRevert = noRows || s.refined === 0;            // 没有处于已优化状态的条目 → 无待办
      var updatable = noRows ? 0 : s.upd;
      var noUpdate = noRows || updatable === 0 || batchSettled;

      var head = h('div', { style: S.bar },
        opBtn('opt', busy === 'optimize' ? '优化中…' : '翻译优化', busyNow || noOptimize, optimize,
          noOptimize ? (noRows ? '状态尚未读取完成' : '全部条目均已优化，无待办') : '生成缺失文案并应用全部改写'),
        opBtn('rev', busy === 'revert' ? '还原中…' : '还原翻译', busyNow || noRevert, revert,
          noRevert ? (noRows ? '状态尚未读取完成' : '当前没有处于「已优化」状态的条目，无需还原') : '撤销全部已应用的改写'),
        opBtn('ref', busy === 'refresh' ? '刷新中…' : '刷新状态', busyNow, refresh,
          '重新取一次完整快照（状态 + 版本 + 更新检查）'),
        !IS_SKILL
          ? opBtn('all', busy === 'update:all' ? '批量更新中…' : '一键更新（' + updatable + '）', busyNow || noUpdate,
              function () { updateAll(rows); },
              noRows ? '状态尚未读取完成'
                : (updatable === 0 ? '当前没有可更新的插件'
                  : (batchSettled ? '本轮批量更新已完成；点「刷新状态」可重新判定' : '按顺序更新全部可更新插件')))
          : null);

      var revGap = hostRev !== '' && hostRev !== CLIENT_REV;
      var staleEl = (stale || revGap)
        ? h('div', { style: S.err }, revGap
          ? '⚠ 客户端半体 v' + CLIENT_REV + ' 与运行中的宿主半体 v' + hostRev + ' 不一致：' +
            (compareRev(hostRev, CLIENT_REV) < 0
              ? '宿主半体是旧的 —— 它只在 DSH 进程启动时加载一次，因此可能缺少本页需要的接口（例如 /skills）。请重启 DSH。'
              : '客户端半体是旧的（页面来自缓存）。请刷新页面。')
          : '⚠ 宿主半体版本过旧：运行中的是进程启动时加载的代码，因此缺少新接口。请重启 DSH 后重试。')
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
            !IS_SKILL ? h('span', null, '可更新 ' + s.upd) : null,
            !IS_SKILL && s.unk ? h('span', null, '无法比对 ' + s.unk) : null,
            IS_SKILL && s.bundled > 0 ? h('span', null, '随 DSH 提供 ' + s.bundled) : null,
            audit && (audit.counts.fact + audit.counts.inferred) > 0
              ? h('button', { type: 'button', style: S.mini, onClick: function () { setOnlyFlagged(!onlyFlagged); } },
                  onlyFlagged ? '显示全部' : ('审查 ⚠' + audit.counts.fact + ' 事实 / ' + audit.counts.inferred + ' 推断'))
              : h('span', null, '审查 无发现'))
        : null;

      // 技能视图不渲染批量更新卡片（它是插件专属动作的状态，别让两页看起来共用一份状态）
      var batchEl = !IS_SKILL && batch && Array.isArray(batch.items) && batch.items.length > 0
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
        ? h('div', { style: S.note }, IS_SKILL ? '正在读取技能状态…' : '正在读取插件状态…')
        : h('table', { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, IS_SKILL ? '技能' : '插件'),
              h('th', { style: S.th }, IS_SKILL ? '优化 · 描述' : '优化'),
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
                // 三态：已优化 / 待应用（有文案未落盘）/ 待生成文案（压根没有文案）。
                // 技能侧此前误用 needsText 判「描述为空」—— 它在技能侧的语义是「没有文案条目」，
                // 于是每个技能都会被标成描述为空。技能侧另附描述语言，随 DSH 提供的只读。
                h('td', { style: S.td },
                  (r.bundled === true
                    ? '随 DSH 提供'
                    : (r.localized ? '已优化' : (r.needsText ? '待生成文案' : '待应用')) +
                      (IS_SKILL ? ' · ' + (r.descriptionLang || '未知') : '')) + (function () {
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
              var finished = done[r.pkg];
              if (job && !job.done) op.push(h('span', { key: 'j', style: S.off }, job.stage + '…'));
              // 本会话已处理过这一行：按结果暗下去（未变化/失败也不允许重复点击，重试先「刷新状态」）
              else if (finished) op.push(opBtn('u', outcomeLabel(finished), true, null,
                (finished.message ? finished.message + ' · ' : '') + '本轮已处理；点「刷新状态」可重新判定'));
              else if (upd) op.push(opBtn('u', '更新', false, function () { doUpdate(r.pkg); }, '更新到 ' + (r.latest || '最新版'), true));
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
          ? '技能视图与插件视图同构（用上方按钮切换）：一源数据、一套规则。技能不是 npm 包，因此没有可比的「最新版本」——「来源」列显示它来自哪个根目录与优先级。'
          : '插件视图（用上方按钮切到技能视图）：命名约定为标题保留原包名、中文名以（）附加。刷新即包含状态、版本与更新检查（同一份快照）。'),
        staleEl,
        summaryEl,
        noteEl,
        batchEl,
        table,
        detail,
        h('div', { style: S.note }, IS_SKILL
          ? '技能改写会真实写入 SKILL.md：name 保留原文、中文名以（）附加，description 替换为「触发词 → 精炼说明」；改写前留 .dsh-skill.backup 备份，「还原翻译」逐字节恢复原文件。注意 description 是模型选择技能的依据，改它属于行为变更而非展示变更，请自行确认生成内容。「随 DSH 提供」的技能在 app.asar 内、没有可写路径，只入表不参与优化。' + (hostRev ? '  宿主半体 v' + hostRev : '')
          : '翻译优化会调用模型为缺失文案的插件生成中文（消耗 token），结果存入覆盖层，重装不丢；更新经第一方插件管理器执行，会真实运行 pnpm 并可能触发重载。' + (hostRev ? '  宿主半体 v' + hostRev : '')));
    }

    /* 合并页：插件与技能共用一个设置页，切换按钮在页面上方。
     *
     * key={mode} 让被切走的视图卸载、切回的视图重新挂载 —— 于是**每个视图只读取自己那一份快照**，
     * 两个数据源不会互相污染（沿用单一快照原则）。
     * 批量更新的进度不依赖组件状态：它由宿主侧的 update-batch.json 承载，重新挂载时会自行恢复，
     * 因此切换标签页不会丢失正在进行的批量进度。 */
    function Merged() {
      var modeState = useState('plugin'); var mode = modeState[0]; var setMode = modeState[1];
      var tab = function (key, text, hint) {
        var on = mode === key;
        return h('button', {
          key: key,
          type: 'button',
          role: 'tab',
          'aria-selected': on ? 'true' : 'false',
          title: hint,
          style: on ? S.tabOn : S.tab,
          onClick: function () { setMode(key); },
        }, text);
      };
      return h('div', { style: { display: 'flex', flexDirection: 'column' } },
        h('div', { style: S.tabs, role: 'tablist' },
          tab('plugin', '插件', '插件半体：翻译优化、版本与更新、冲突与兼容审查'),
          tab('skill', '技能', '技能 SKILL.md：翻译优化、来源与审查')),
        h(Panel, { key: mode, target: mode }));
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
              label: function () { return '插件与技能审查'; },
            }, function () { return h(Boundary, null, h(Merged)); }),
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
              component: function () { return h(Boundary, null, h(Merged)); },
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
