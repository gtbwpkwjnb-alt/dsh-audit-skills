/* dsh-audit-skills — 客户端半体
 *
 * 形态要求（不可违反）：DSH 以传统 <script> 加载 client.js，
 * 不得有顶层 import/export，必须用 window.__ModuleLoader__.load({ id, factory }) 注册。
 * 依赖只有 react —— 动效一律用 CSS，不引入 GSAP 或任何构建链：
 * scripts/crash-rehearsal.mjs 会断言本文件在传统脚本沙箱里可解析、可执行、apply() 绝不外抛。
 * 改动后必须通过 scripts/preflight-client.mjs 与 scripts/crash-rehearsal.mjs 才能发布。
 *
 * ── 单一快照原则（本文件最重要的不变量） ──
 * 表格行只有**一个**来源：snapshot() → POST /updates（插件）或 /skills（技能）。
 * 任何操作的返回值（/apply、/revert、/update、/update-skills、/generate*）**一律不得进入表格**，
 * 只用于「本轮结果」与汇总文案。
 *
 * ── 「本轮结果」与行锁的口径（修用户报告的「状态栏说完成、行里还能点更新」） ──
 * 一次动作（批量更新 / 单行更新 / 翻译优化 / 还原）的返回值只进两处：
 *   · results —— 逐项结果的**记录**：永久保留、标注时间，是可追溯的日志；
 *   · done    —— 逐行的**锁**：被锁的行按钮暗下去，未变化/失败也不可重复点击。
 * 锁有保鲜期 LOCK_MS（与宿主半体 BATCH_STALE_MS 同值）。超期后：
 *   · 记录照旧显示（并写明「来自 N 分钟前」）；
 *   · 锁全部释放，下表回到「按当前快照判定」。
 * 页面必须**主动把这个差异讲出来**（见 lockNote()）—— 否则用户会看到
 * 「记录已完成」与「行里还能点更新」并存，并把它们当成自相矛盾的 bug。
 * 触发锁置位的三处必须一致：批量更新、单行更新、技能更新。
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
    /* 轮询「批量状态」失败时的退避重试次数上限：批量可能仍在宿主侧跑 pnpm，
       一次网络抖动就放开按钮会让用户并发触发第二次安装。 */
    var POLL_RETRY_MAX = 8;
    /* 本客户端半体的版本，必须等于 package.json 的 version —— regression.mjs 会断言。
       宿主半体只在 DSH 进程启动时加载一次，客户端半体会热更新；只有把两边的版本摆在一起，
       「按钮是新的、接口是旧的」才自解释，否则用户只能看到一个没头没尾的 404。 */
    var CLIENT_REV = '2.8.0';
    /* 行锁保鲜期。必须与宿主半体的 BATCH_STALE_MS 同值（10 分钟）：
       宿主用这个窗口判「批量是否还在跑」，客户端用同一个窗口判「这批结果还算不算数」。
       超期后记录仍如实显示，但不再锁定下表，并在页面上写明原因。 */
    var LOCK_MS = 10 * 60 * 1000;

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

    /**
     * 失败码 → 一句「你能做什么」。
     * 用户报告的正是这个缺口：状态栏只有红色和一句看不懂的话，「功能状态未知」。
     * 因此每一个失败码都必须给出下一步动作，不允许落到「未知」。
     */
    function fixOf(code) {
      var c = String(code === undefined || code === null ? '' : code);
      if (c === 'manager-unavailable') return '插件管理器服务未就绪，重启 DSH 后可重试。'
      if (c === 'unsupported-spec') return '该包是内置或本地依赖，请在插件页处理。'
      if (/^http-4/.test(c)) return '宿主半体没有这个接口（运行的是启动时加载的旧代码）→ 请重启 DSH。'
      if (c === 'llm-unavailable') return 'LLM 服务不可用或未注册，重启 DSH 后重试。'
      if (c === 'no-model') return '找不到默认模型，请先在设置里选定默认模型再重试。'
      if (c === 'bad-output') return '模型输出不是约定 JSON，可重试；反复失败请手动补录。'
      if (c === 'generate-failed') return '生成请求失败（常见原因：宿主半体太旧，代码直接读了 ctx.llm）→ 重启 DSH 后重试。'
      if (c === 'not-found') return '该对象已不存在（可能被移除或改名），刷新状态即可对齐。'
      if (c === 'not-installed') return '该包未安装或不是 DSH bundle，无法生成文案。'
      if (c === 'invalid-pkg' || c === 'missing-pkg') return '参数非法，已被宿主拒绝。'
      if (c === 'timeout') return '超时：可能仍在后台执行，稍后点「刷新状态」查看结果。'
      if (c === 'update-failed') return '安装失败，原因见左侧说明；可重试。'
      if (c === 'batch-running') return '批量更新正在进行，等它结束后再更新这一项（避免两条 pnpm 并发安装）。'
      if (c === 'network') return '连不上宿主半体，确认 DSH 仍在运行后刷新页面。'
      return '可重试；若反复失败请「刷新状态」重新判定。'
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

    /* ── 样式 ──
       全部命名空间化（das-），只用 DSH 自己的 token，缺失时回落到固定值 —— 因此亮/暗主题自动跟随。
       刻意内联而不是走构建：客户端半体必须是传统脚本、零依赖。
       动效全部为 CSS（Hover Physics / 卡层层叠入场），并尊重 prefers-reduced-motion。 */
    var CSS = [
      '.das-root{',
      '  --das-l1: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06));',
      '  --das-l2: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.10));',
      '  --das-line: var(--dsw-alias-border-l1, rgba(128,128,128,.30));',
      '  --das-line2: var(--dsw-alias-border-l2, rgba(128,128,128,.16));',
      '  --das-dim: var(--dsw-alias-label-tertiary, rgba(127,127,127,.95));',
      '  --das-dimmer: var(--dsw-alias-label-quaternary, rgba(127,127,127,.7));',
      '  --das-ok: var(--dsw-alias-state-success-primary, #2a9d54);',
      '  --das-warn: var(--dsw-alias-state-warn-primary, #c07f00);',
      '  --das-err: var(--dsw-alias-label-error, #d3402f);',
      '  --das-info: var(--dsw-alias-brand-primary, #4c6ef5);',
      '  --das-mono: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);',
      '  --das-r: var(--dsw-radius-md, 8px);',
      '  font-family: Satoshi, var(--dsw-font-family, system-ui), -apple-system, "Segoe UI", "Microsoft YaHei UI", sans-serif;',
      '  font-size: var(--dsw-font-xs-13-font-size, 13px);',
      '  line-height: var(--dsw-font-xs-13-line-height, 20px);',
      '  color: var(--dsw-alias-label-primary, inherit);',
      '  display: flex; flex-direction: column; gap: 12px; width: 100%;',
      '}',
      '.das-root *, .das-root *::before, .das-root *::after { box-sizing: border-box; }',
      '.das-root p { margin: 0; }',
      '.das-root h3 { margin: 0; }',
      /* 命令头（原 Hero 位）：居中、单行、行内版本 chip */
      '.das-head { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; padding-top: 2px; }',
      '.das-title { display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap;',
      '  font-size: var(--dsw-font-l-20-font-size, 20px); line-height: var(--dsw-font-l-20-line-height, 28px);',
      '  font-weight: var(--dsw-font-l-20-font-weight, 600); letter-spacing: -.01em; }',
      '.das-sub { font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: var(--dsw-font-xxs-12-line-height, 18px);',
      '  color: var(--das-dim); max-width: 92ch; }',
      /* 分段控件 */
      '.das-seg { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--das-line); border-radius: 999px; background: var(--das-l1); }',
      '.das-seg-btn { appearance: none; border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit;',
      '  font-size: var(--dsw-font-xxs-12-font-size, 12px); padding: 4px 16px; border-radius: 999px; opacity: .6;',
      '  transition: opacity .2s ease, background .2s ease, transform .18s cubic-bezier(.16,1,.3,1); }',
      '.das-seg-btn:hover { opacity: .92; transform: translateY(-1px); }',
      '.das-seg-btn[aria-selected="true"] { opacity: 1; background: var(--dsw-alias-fill-l2, rgba(127,127,127,.18)); font-weight: 600; cursor: default; }',
      /* 按钮：不可用一律「暗下去 + 不可点」，不允许「看起来能点、点了没事发生」 */
      '.das-btn { appearance: none; font: inherit; font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 16px;',
      '  padding: 5px 12px; border-radius: var(--dsw-radius-sm, 6px); border: 1px solid var(--das-line);',
      '  background: var(--das-l1); color: inherit; cursor: pointer; white-space: nowrap;',
      '  transition: transform .18s cubic-bezier(.16,1,.3,1), background .18s ease, border-color .18s ease, opacity .18s ease, box-shadow .18s ease; }',
      '.das-btn:hover:not(:disabled) { background: var(--das-l2); border-color: var(--dsw-alias-border-l3, rgba(128,128,128,.5));',
      '  transform: translateY(-1px); box-shadow: 0 2px 10px rgba(0,0,0,.10); }',
      '.das-btn:active:not(:disabled) { transform: translateY(0); box-shadow: none; }',
      '.das-btn[disabled] { opacity: .42; cursor: default; }',
      '.das-btn.das-primary { background: var(--dsw-alias-button-primary-fill, #3a6ff7); border-color: transparent;',
      '  color: var(--dsw-alias-label-primary-foreground, #fff); font-weight: 600; }',
      '.das-btn.das-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #2f61e0); }',
      '.das-btn.das-mini { padding: 2px 8px; font-size: var(--dsw-font-xxxs-11-font-size, 11px); line-height: 15px; }',
      '.das-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: center; }',
      /* KPI 数据带：1px 露线法，格子铺满无空洞 */
      '.das-kpi { display: grid; grid-template-columns: repeat(auto-fit, minmax(94px, 1fr)); gap: 1px;',
      '  background: var(--das-line2); border: 1px solid var(--das-line); border-radius: var(--das-r); overflow: hidden; }',
      '.das-kpi-cell { background: var(--dsw-alias-bg-base, rgba(127,127,127,.04)); padding: 7px 10px;',
      '  display: flex; flex-direction: column; gap: 1px; min-width: 0; text-align: left; border: 0; font: inherit; color: inherit; }',
      'button.das-kpi-cell { cursor: pointer; appearance: none; transition: background .18s ease; }',
      'button.das-kpi-cell:hover { background: var(--dsw-alias-interactive-bg-hover, var(--das-l1)); }',
      '.das-kpi-n { font-family: var(--das-mono); font-variant-numeric: tabular-nums;',
      '  font-size: var(--dsw-font-base-strong-16-font-size, 16px); font-weight: 600; line-height: 21px; }',
      '.das-kpi-l { font-size: var(--dsw-font-xxxs-11-font-size, 11px); line-height: 15px; color: var(--das-dim);',
      '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.das-kpi-cell.is-warn .das-kpi-n { color: var(--das-warn); }',
      '.das-kpi-cell.is-err .das-kpi-n { color: var(--das-err); }',
      '.das-kpi-cell.is-ok .das-kpi-n { color: var(--das-ok); }',
      '.das-kpi-cell.is-dim .das-kpi-n { color: var(--das-dimmer); }',
      /* 卡片 + 层叠入场（Card Stacking 的 CSS 等价物） */
      '.das-card { border: 1px solid var(--das-line); border-radius: var(--das-r); background: var(--dsw-alias-settings-card-fill, var(--das-l1)); overflow: hidden; }',
      '.das-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 7px 12px;',
      '  background: var(--das-l2); border-bottom: 1px solid var(--das-line2); }',
      '.das-card-title { font-weight: 600; font-size: var(--dsw-font-xs-strong-13-font-size, 13px); }',
      '.das-card-note { padding: 7px 12px 0; font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px; color: var(--das-dim); }',
      '.das-spacer { flex: 1 1 auto; }',
      '.das-rise { animation: das-rise .34s cubic-bezier(.16,1,.3,1) both; }',
      '@keyframes das-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }',
      /* 表格 */
      '.das-wrap { overflow-x: auto; border: 1px solid var(--das-line); border-radius: var(--das-r);',
      '  background: var(--dsw-alias-bg-base, transparent); }',
      '.das-table { width: 100%; border-collapse: separate; border-spacing: 0;',
      '  font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px; }',
      '.das-table th { position: sticky; top: 0; z-index: 1; text-align: left; padding: 6px 10px;',
      '  font-size: var(--dsw-font-xxxs-11-font-size, 11px); font-weight: 600; letter-spacing: .02em;',
      '  color: var(--das-dim); background: var(--dsw-alias-bg-layer-2, var(--das-l2));',
      '  border-bottom: 1px solid var(--das-line); white-space: nowrap; }',
      '.das-table td { padding: 6px 10px; border-bottom: 1px solid var(--das-line2); vertical-align: top; }',
      '.das-table tbody tr { transition: background .18s ease, box-shadow .18s ease; }',
      '.das-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover, var(--das-l1));',
      '  box-shadow: inset 2px 0 0 0 var(--das-info); }',
      '.das-table tbody tr:last-child td { border-bottom: 0; }',
      '.das-table tr.is-dim td { opacity: .5; }',
      '.das-name { font-family: var(--das-mono); font-size: var(--dsw-font-xxs-12-font-size, 12px); word-break: break-all; }',
      '.das-name small { display: block; font-family: inherit; color: var(--das-dim); font-size: var(--dsw-font-xxxs-11-font-size, 11px); }',
      '.das-mono { font-family: var(--das-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }',
      '.das-num { font-family: var(--das-mono); font-variant-numeric: tabular-nums; }',
      '.das-desc { color: var(--das-dim); max-width: 52ch; }',
      '.das-act { white-space: nowrap; }',
      '.das-act > * + * { margin-left: 6px; }',
      '.das-wrapd { white-space: normal; }',
      /* chip 与严重度徽章 */
      '.das-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border: 1px solid var(--das-line);',
      '  border-radius: 999px; background: var(--das-l1); font-size: var(--dsw-font-xxxs-11-font-size, 11px); line-height: 15px;',
      '  color: var(--das-dim); white-space: nowrap; }',
      '.das-chip.is-ok { color: var(--das-ok); }',
      '.das-chip.is-err { color: var(--das-err); }',
      '.das-chip.is-warn { color: var(--das-warn); }',
      '.das-chip.is-info { color: var(--das-info); }',
      '.das-chip.is-mono { font-family: var(--das-mono); }',
      '.das-sev { font-family: var(--das-mono); font-size: var(--dsw-font-xxxs-11-font-size, 11px); padding: 0 4px;',
      '  border: 1px solid currentColor; border-radius: 3px; }',
      '.das-sev.is-high { color: var(--das-err); }',
      '.das-sev.is-medium { color: var(--das-warn); }',
      '.das-sev.is-low { color: var(--das-dim); }',
      /* 状态提示行 */
      '.das-note { display: flex; align-items: flex-start; gap: 8px; padding: 7px 10px; border-radius: var(--das-r);',
      '  border: 1px solid var(--das-line2); background: var(--das-l1); font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px; }',
      '.das-note.is-err { border-color: var(--das-err); }',
      '.das-note.is-ok { border-color: var(--das-ok); }',
      '.das-note-text { min-width: 0; }',
      '.das-detail { display: flex; flex-direction: column; gap: 8px; margin-top: -2px; }',
      '.das-detail .das-card { box-shadow: 0 -6px 18px -12px rgba(0,0,0,.35); }',
      '.das-kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; align-items: baseline; }',
      '.das-kv dt { color: var(--das-dim); font-size: var(--dsw-font-xxxs-11-font-size, 11px); white-space: nowrap; }',
      '.das-kv dd { margin: 0; font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px; }',
      '.das-body { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; }',
      '.das-foot { font-size: var(--dsw-font-xxxs-11-font-size, 11px); line-height: 16px; color: var(--das-dimmer); }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .das-rise { animation: none; }',
      '  .das-btn, .das-seg-btn, .das-table tbody tr, .das-kpi-cell { transition: none; }',
      '  .das-btn:hover:not(:disabled), .das-seg-btn:hover { transform: none; }',
      '}',
    ].join('\n');

    /* 少量内联样式：只有 opBtn 的禁用态需要（regression.mjs 把这条规则当契约锁死）。 */
    var S = {
      off: { opacity: 0.45, cursor: 'default' },
      dim: { opacity: 0.5 },
    };

    var SEV = { high: '高', medium: '中', low: '低' };
    var SEV_CLASS = { high: 'is-high', medium: 'is-medium', low: 'is-low' };

    /* ── 功能性按钮的统一规则（插件页与技能页共用同一套，两页只有「对象」不同） ──
     * 「不可用」一律表现为**暗下去**（disabled + 降透明度），不允许出现「看起来能点、点了没事发生」。
     * 判定只有两种：① 有操作在跑；② 此刻无待办（更新：无可更新；优化：无待优化；还原：无已优化条目）。 */
    var OUTCOME = { ok: '已更新', updated: '已更新', unchanged: '未变化', fail: '更新失败', failed: '更新失败', done: '已完成' };

    /* 「本轮结果」里逐项状态的措辞与色调（比 OUTCOME 更全，覆盖生成/应用/还原）。 */
    var STATE_TEXT = {
      ok: '成功', done: '已完成', updated: '已更新', unchanged: '未变化',
      failed: '失败', fail: '失败', applied: '已应用', generated: '已生成',
      restored: '已还原', 'no-backup': '无备份', 'skipped-not-installed': '未安装',
      pending: '排队中', running: '执行中',
    };
    var STATE_TONE = {
      ok: 'ok', done: 'ok', updated: 'ok', applied: 'ok', generated: 'ok', restored: 'ok',
      unchanged: 'dim', pending: 'dim', running: 'dim',
      failed: 'err', fail: 'err', 'no-backup': 'warn', 'skipped-not-installed': 'warn',
    };
    var ACTION_TEXT = { update: '更新', generate: '生成文案', apply: '应用', revert: '还原' };

    function stateText(state) { return STATE_TEXT[state] || String(state === undefined || state === null ? '未知' : state); }
    function isBad(state) { return state === 'failed' || state === 'fail'; }

    /** 提交号短写（宿主给的是全量 sha）。 */
    function shortShaOf(sha) {
      return typeof sha === 'string' && sha.length >= 8 ? sha.slice(0, 8) : (typeof sha === 'string' && sha !== '' ? sha : '—');
    }

    function outcomeLabel(entry) {
      var k = entry && entry.state;
      return OUTCOME[k] || '已完成';
    }

    /** 秒级时间差 → 「刚刚 / N 分钟前 / N 小时前」。用于给记录打时间戳，避免被误读成现状。 */
    function agoText(at) {
      if (typeof at !== 'number' || at <= 0) return '时间未知';
      var min = Math.round((Date.now() - at) / 60000);
      if (min < 1) return '刚刚';
      if (min < 60) return min + ' 分钟前';
      var hour = Math.round(min / 60);
      if (hour < 48) return hour + ' 小时前';
      return Math.round(hour / 24) + ' 天前';
    }

    /**
     * 统一按钮：off 为真即暗下去且不可点击（onClick 直接摘掉，避免只靠 disabled 属性）。
     * @param key - React key
     * @param label - 按钮文字
     * @param off - 是否暗下去
     * @param onClick - 可用时的动作
     * @param title - 悬停说明（暗下去时用来说明为什么不可用）
     * @param mini - 行内小按钮
     * @param tone - 'primary' 主按钮 / 其他为默认
     */
    function opBtn(key, label, off, onClick, title, mini, tone) {
      var cls = 'das-btn' + (mini === true ? ' das-mini' : '') + (tone === 'primary' ? ' das-primary' : '');
      return h('button', {
        key: key,
        type: 'button',
        className: cls,
        disabled: !!off,
        title: title === undefined || title === null ? undefined : title,
        style: off ? S.off : undefined,
        onClick: off ? undefined : onClick,
      }, label);
    }

    function chip(key, text, tone, title, mono) {
      return h('span', {
        key: key,
        className: 'das-chip' + (tone ? ' is-' + tone : '') + (mono === true ? ' is-mono' : ''),
        title: title === undefined || title === null ? undefined : title,
      }, text);
    }

    function kpiCell(key, n, label, title, tone) {
      return h('div', { key: key, className: 'das-kpi-cell' + (tone ? ' is-' + tone : ''), title: title },
        h('span', { className: 'das-kpi-n' }, String(n)),
        h('span', { className: 'das-kpi-l' }, label));
    }

    function kpiButton(key, n, label, title, tone, onClick) {
      return h('button', { key: key, type: 'button', className: 'das-kpi-cell' + (tone ? ' is-' + tone : ''), title: title, onClick: onClick },
        h('span', { className: 'das-kpi-n' }, String(n)),
        h('span', { className: 'das-kpi-l' }, label));
    }

    /**
     * 技能没有 npm 式版本号 —— 这里给出「到底拿什么当版本」的三种来源，不让表格停在「—」上。
     * 用户报告的原话是「技能版本号不清晰」，所以每一格都必须能说清它是什么。
     */
    function skillRevision(r) {
      if (r.bundled === true) return { text: '随 DSH', title: '随 DSH 提供（在 app.asar 内），不参与优化与更新' };
      if (typeof r.version === 'string' && r.version !== '') {
        return { text: 'v' + r.version, title: 'SKILL.md 的 frontmatter 声明了 version: ' + r.version };
      }
      if (r.isGit === true && typeof r.localSha === 'string' && r.localSha !== '') {
        return { text: 'git ' + shortShaOf(r.localSha), title: 'SKILL.md 未声明 version；此处回落到本地 git 提交号（' + r.localSha + '）' };
      }
      return { text: '未声明', title: 'SKILL.md 的 frontmatter 没有 version 字段，且该技能不是 git 仓库 —— 技能没有 npm 式版本号，只能靠提交历史或人工维护' };
    }

    /** 技能来源里的根目录压短成 .dsh/skills、.agents/skills，省掉整条 Windows 路径。 */
    function shortRoot(source) {
      return String(source === undefined || source === null ? '' : source).replace(/[A-Za-z]:\\[^·]*[\\/](\.dsh|\.agents)[\\/]skills/, '$1/skills');
    }

    function summarize(rows, isSkill) {
      var total = rows.length;
      /* 技能侧：随 DSH 提供的技能在 app.asar 里，没有可写路径 —— 只入表并标注来源，
         不计入「待应用 / 待生成」，否则那几项永远是待办、还会在优化时去写写不了的文件。 */
      var active = isSkill ? rows.filter(function (r) { return r.bundled !== true; }) : rows;
      var refined = active.filter(function (r) { return r.localized === true; }).length;
      var pending = active.filter(function (r) { return r.needsText === true; }).length;
      var toApply = active.filter(function (r) { return r.localized !== true; }).length;
      var upd = rows.filter(function (r) { return r.hasUpdate === true; }).length;
      /* 技能侧：非 git 目录压根没有远端可比 —— 那是「本地目录」，不是「比对失败」。
         两者必须分开计数，否则 8 个本地技能会被说成 8 个「无法比对」。 */
      var unk = rows.filter(function (r) { return r.hasUpdate === null && (isSkill !== true || r.isGit === true); }).length;
      var noRepo = isSkill === true ? active.filter(function (r) { return r.isGit !== true; }).length : 0;
      /* 技能页专有的两个可用性指标：有未提交改动、描述是英文。 */
      var dirty = isSkill === true ? rows.filter(function (r) { return typeof r.dirty === 'number' && r.dirty > 0; }).length : 0;
      var english = isSkill === true ? rows.filter(function (r) { return r.descriptionLang === '英文'; }).length : 0;
      var flagged = rows.filter(function (r) { return (r.findings || []).length > 0 || (r.issues || []).length > 0; }).length;
      return {
        total: total, refined: refined, pending: pending, toApply: toApply, upd: upd,
        unk: unk, noRepo: noRepo, bundled: total - active.length,
        dirty: dirty, english: english, flagged: flagged,
      };
    }

    function FindingCard(props) {
      var all = props.findings || [];
      if (all.length === 0) return null;
      var facts = all.filter(function (f) { return f.confidence === 'fact'; });
      var inferred = all.filter(function (f) { return f.confidence !== 'fact'; });
      var render = function (f) {
        return h('div', { key: f.id, style: { display: 'flex', flexDirection: 'column', gap: '2px', paddingBottom: '4px' } },
          h('div', null,
            h('span', { className: 'das-sev ' + (SEV_CLASS[f.severity] || 'is-low') }, SEV[f.severity] || f.severity),
            ' ' + f.title),
          h('div', { className: 'das-foot', style: { paddingLeft: '10px' } }, '证据：' + f.evidence),
          h('div', { style: { fontSize: '11px', paddingLeft: '10px' } }, '建议：' + f.remedy),
          h('div', { style: { paddingLeft: '10px' } },
            h('button', { type: 'button', className: 'das-btn das-mini', disabled: !!props.busy, onClick: function () { props.onIgnore(f.id); } }, '忽略此条')));
      };
      return h('div', { className: 'das-card das-rise' },
        h('div', { className: 'das-card-head' }, h('span', { className: 'das-card-title' }, props.pkg), chip('fc', '事实 ' + facts.length + ' · 推断 ' + inferred.length, 'dim')),
        h('div', { className: 'das-body' },
          facts.map(render),
          inferred.length
            ? h('details', null,
                h('summary', { style: { opacity: 0.7, cursor: 'pointer', fontSize: '11px' } }, '另有 ' + inferred.length + ' 条推断（仅供知悉）'),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '4px' } }, inferred.map(render)))
            : null));
    }

    function IssueCard(props) {
      var issues = props.issues || [];
      if (issues.length === 0) return null;
      return h('div', { className: 'das-card das-rise' },
        h('div', { className: 'das-card-head' }, h('span', { className: 'das-card-title' }, props.pkg), chip('ic', '问题 ' + issues.length, 'warn')),
        h('div', { className: 'das-body' }, issues.map(function (issue, i) {
          return h('div', { key: String(i), style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            h('div', null, '· ' + issue.reason),
            h('div', { className: 'das-desc' }, '→ 解决办法：' + issue.remedy),
            issue.action && issue.action.kind === 'retry'
              ? h('button', { type: 'button', className: 'das-btn das-mini', onClick: props.onRetry }, issue.action.label)
              : null);
        })));
    }

    /**
     * 「本轮结果」：一次动作的逐项结果与口径。
     *
     * 这是修「状态栏说完成、行里还能点更新」的核心 —— 记录与锁分开讲：
     *   · 记录永久保留（并标时间），所以它可能比锁旧；
     *   · 锁只在 LOCK_MS 内有效；
     *   · 两者不一致时，页面必须写明「记录不约束下表」，否则用户只能看到矛盾。
     */
    function ResultsPanel(props) {
      var results = props.results || [];
      var batch = props.batch || null;
      var running = !!(batch && batch.running === true);
      if (results.length === 0 && running !== true) return null;
      var IS_SKILL = props.isSkill === true;
      var locked = props.locked === true;
      /* 记录条数 ≠ 被锁行数：翻译优化会往记录里加「应用」条目，但它不锁任何行。
         两个数字混用会让「已锁定 N 行」虚报，所以分别取。 */
      var lockedCount = typeof props.lockedCount === 'number' ? props.lockedCount : 0;
      var batchCount = batch && Array.isArray(batch.items) ? batch.items.length : results.length;
      /* 没有 finishedAt 的批量记录 = 宿主判为「超过 10 分钟无进展」而中断的那一批。
         它不能被说成「已完成」—— 那正是这次要修的那类不诚实措辞。 */
      var interrupted = batch !== null && running !== true && typeof batch.finishedAt !== 'number';
      var onRetryOne = props.onRetryOne;
      var badCount = results.filter(function (r) { return isBad(r.state); }).length;
      var batchChip = batch
        ? chip('bc', (IS_SKILL ? '技能更新' : '批量更新') + ' · ' + (running
            ? '进行中 ' + (Number(batch.index || 0) + 1) + '/' + Number(batch.total || 0)
            : (interrupted ? '已中断（未完成）' : '已完成 ' + batchCount + ' 项')),
          running ? 'info' : (interrupted ? 'warn' : (badCount > 0 ? 'err' : 'ok')),
          batch.message || undefined)
        : chip('bc', '单行动作 · ' + results.length + ' 项', 'dim', '这些结果来自单行操作，不涉及批量记录');
      var progress = running && typeof batch.total === 'number'
        ? h('div', { className: 'das-kpi' }, kpiCell('p1', Number(batch.index || 0) + 1, '进行中', '宿主侧串行执行，逐项落盘'),
            kpiCell('p2', batch.total, '总数'), kpiCell('p3', batchCount, '已出结果'))
        : null;
      return h('section', { className: 'das-card das-rise' },
        h('div', { className: 'das-card-head' },
          h('span', { className: 'das-card-title' }, '本轮结果'),
          batchChip,
          h('span', { className: 'das-spacer' }),
          chip('lock', locked ? '下表已按本轮结果锁定 ' + lockedCount + ' 行' : '记录不约束下表', locked ? 'ok' : 'dim',
            locked ? '被锁的行按钮已暗下去，未变化/失败也不可重复点击；点「刷新状态」可重新判定'
              : '记录比锁旧：锁定只保鲜 ' + Math.round(LOCK_MS / 60000) + ' 分钟，超期后下表回到「按当前快照判定」')),
        h('p', { className: 'das-card-note' }, lockNote(batch, locked, lockedCount, IS_SKILL, props.lockReason, Number(props.lockedAt) || 0)),
        progress,
        h('div', { className: 'das-wrap', style: { border: 0, borderRadius: 0 } },
          h('table', { className: 'das-table' },
            h('thead', null, h('tr', null,
              h('th', null, '对象'), h('th', null, '动作'), h('th', null, '结果'),
              h('th', null, '说明与人话'), h('th', null, '操作'))),
            h('tbody', null, results.map(function (entry) {
              var tone = STATE_TONE[entry.state] || 'dim';
              return h('tr', { key: entry.action + '|' + entry.pkg },
                h('td', { className: 'das-name' }, entry.pkg),
                h('td', null, ACTION_TEXT[entry.action] || String(entry.action || '—')),
                h('td', null, chip('st', stateText(entry.state), tone)),
                h('td', { className: 'das-desc' },
                  h('div', null, entry.message || '—'),
                  isBad(entry.state) && entry.fix ? h('div', { className: 'das-foot' }, '→ ' + entry.fix) : null),
                h('td', { className: 'das-act' },
                  isBad(entry.state) && typeof onRetryOne === 'function'
                    ? h('button', { type: 'button', className: 'das-btn das-mini', title: '只重试这一项', onClick: function () { onRetryOne(entry); } }, '重试')
                    : null,
                  h('span', { className: 'das-foot' }, entry.at ? agoText(entry.at) : '')));
            })))));
    }

    /**
     * 记录与锁的口径说明。写的是「为什么记录说完成、下表却还能点更新」——
     * 这正是用户报的「逻辑不清晰」，必须由页面自己解释，不能留给用户猜。
     *
     * reason 由 Panel 显式判定后传入。**绝不能靠「有没有 finishedAt」反推是不是超期**：
     * 刷新状态会主动释放行锁（记录仍在保鲜期内），靠反推就会输出
     * 「这是 1 分钟前的记录，已超出 10 分钟的锁定保鲜期」这种自相矛盾的话。
     * @param reason - running | locked | expired | released | interrupted | noitems | session
     * @param lockedAt - 行锁是什么时候上的（与批量记录的完成时间无关）
     */
    function lockNote(batch, locked, count, isSkill, reason, lockedAt) {
      var mins = Math.round(LOCK_MS / 60000);
      if (reason === 'running') {
        return '宿主侧正在串行执行（' + (Number(batch.index || 0) + 1) + '/' + Number(batch.total || 0) + '）。完成后按结果锁定下表对应行；未变化/失败的行也不会允许重复点击。';
      }
      if (reason === 'locked') {
        // 时间取行锁自己的时间：批量记录的时间可能属于更早那一轮，混用就是归因错误。
        return '下表已按本轮结果锁定 ' + count + ' 行（' + (lockedAt > 0 ? agoText(lockedAt) : '刚刚') + '）：未变化 / 失败的行同样不可重复点击 —— 要重试先点「刷新状态」重新判定。';
      }
      if (reason === 'released') {
        return '这条记录本来还在 ' + mins + ' 分钟的保鲜期内，是你点了「刷新状态」主动释放了行锁 —— 下表按最新快照判定，因此可能重新显示「更新」。这不是超期，也不是记录出错。';
      }
      if (reason === 'interrupted') {
        return '这条批量记录没有完成时间：宿主判为「超过 ' + mins + ' 分钟无进展」而中断。下面的逐项结果只是中断前跑完的部分，它不锁定下表；要点「刷新状态」让宿主重新判定。';
      }
      if (reason === 'noitems') {
        return '这条批量记录里没有任何逐项结果（可能刚启动就断了），它不锁定下表；下表按当前快照判定。';
      }
      if (reason === 'expired') {
        return '这是 ' + agoText(batch.finishedAt) + ' 的记录，已超出 ' + mins + ' 分钟的锁定保鲜期，因此不再约束下表：下表按当前快照（状态 + 版本 + 更新检查）判定，仍可能显示「更新」。记录与现状的差异是正常的，不是矛盾 —— 想确认就点「刷新状态」。';
      }
      return '这些是本次会话内执行过的动作结果（' + (isSkill ? '技能' : '插件') + '侧）。结果只是记录；下表始终由最近一次快照决定。';
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
      /* 本轮结果：逐项记录（永久保留 + 标时间），是本页唯一的「做了什么」的事实来源。 */
      var resultsState = useState([]); var results = resultsState[0]; var setResults = resultsState[1];
      /* 本次会话内已处理完的动作：把按钮**按结果暗下去**，而不是让它消失。
         消失会让人以为功能没了，也让「未变化 / 失败」这种仍然显示可更新的行看不出已经处理过。
         「刷新状态」= 重新判定，会清空这些标记，于是可以重试。
         不变量：done 非空 ⇔ batchSettled 为真（三处置位：批量更新 / 单行更新 / 技能更新）。 */
      var doneState = useState({}); var done = doneState[0]; var setDone = doneState[1];
      var settledState = useState(false); var batchSettled = settledState[0]; var setBatchSettled = settledState[1];
      /* 行锁是什么时候上的 —— 必须自己记。早先 lockNote 用「批量记录的完成时间」代指锁的时间，
         于是「刷新后单行更新」会把刚上的锁说成 5 分钟前那批批量的完成（归因错误）；而批量被
         中断时（没有 finishedAt）更会退化成「刚刚完成」。两个错都出自同一个偷懒。 */
      var lockedAtState = useState(0); var lockedAt = lockedAtState[0]; var setLockedAt = lockedAtState[1];

      var absorb = useCallback(function (r) {
        if (r && typeof r.rev === 'string' && r.rev !== '') setHostRev(r.rev);
        else if (r && r.ok === false && /^http-4/.test(String(r.code))) setStale(true);
        return r;
      }, []);

      /**
       * 记一批逐项结果。同一个对象只保留**最近一次**结果（后写的覆盖先写的），
       * 其余按包名排序 —— 这样「本轮结果」既是日志，也不会因为重复动作而重复行。
       * 生命周期：随本视图挂载存在（与两页各自独立取快照同一取舍）；插件页的批量记录
       * 另有一份落在宿主的 update-batch.json，重新挂载时会自动恢复。
       */
      var absorbResults = useCallback(function (action, items) {
        var list = (Array.isArray(items) ? items : []).filter(function (it) { return it && typeof it.pkg === 'string' && it.pkg !== ''; });
        if (list.length === 0) return;
        var at = Date.now();
        setResults(function (prev) {
          var map = {};
          for (var i = 0; i < prev.length; i += 1) map[prev[i].pkg] = prev[i];
          for (var j = 0; j < list.length; j += 1) {
            var it = list[j];
            /* 说明列必须非空：状态为「已应用」却什么都不写，用户就只剩一个看不懂的绿点。 */
            var why = it.message || (it.note === 'unchanged' ? '内容已与覆盖层一致，未改写文件' : (it.path ? '已写入 ' + it.path : ''));
            map[it.pkg] = {
              pkg: it.pkg, action: action, state: it.state,
              message: why, fix: it.fix || (isBad(it.state) ? fixOf(it.code) : ''),
              from: it.from, to: it.to, at: at,
            };
          }
          return Object.keys(map).sort().map(function (k) { return map[k]; });
        });
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

      // 批量更新由宿主侧串行执行，客户端只轮询 —— 因此本插件被重新加载后仍能看到进度与结果。
      //
      // 轮询失败不能静默退出：批量可能仍在宿主侧跑 pnpm，一旦按钮恢复可点，用户就能再点一次
      // 「一键更新」或某行的「更新」，从而并发触发第二次安装。所以失败要退避重试，
      // 重试期间 busy 保持置位（按钮就不会放开）；重试耗尽才如实报「状态未知」。
      var pollBatch = useCallback(function (attempt) {
        var tries = typeof attempt === 'number' ? attempt : 0
        return call('update-all-status').then(absorb).then(function (r) {
          if (!r || !r.ok) {
            if (tries < POLL_RETRY_MAX) {
              return new Promise(function (resolve) { setTimeout(resolve, POLL_MS) }).then(function () { return pollBatch(tries + 1) })
            }
            setStale(true)
            setNote({ kind: 'err', text: '批量状态读取失败 ' + (tries + 1) + ' 次（' + ((r && r.message) || '未知') + '）：无法确认宿主侧是否仍在执行，已停止轮询。请刷新页面后重试（不要再点更新，以免并发执行）。' })
            return null
          }
          var b = r.batch
          setBatch(b)
          if (b && b.running === true) {
            return new Promise(function (resolve) { setTimeout(resolve, POLL_MS) }).then(function () { return pollBatch() })
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
        absorbResults('update', b.items);
      };

      // 挂载时恢复：上次批量若还在跑就继续显示，刚结束就把结果如实报出来。
      // 技能视图直接跳过 —— 批量更新是插件专属动作，两页不共用这份状态。
      //
      // 关键修正：记录**始终**显示，但只有新鲜（LOCK_MS 内）时才锁定下表。
      // 旧实现把「显示记录」与「锁定下表」都放在同一个 10 分钟分支里，超期后
      // 记录卡照样渲染（因为 setBatch 在此之前就执行了）、锁却悄悄失效 ——
      // 于是页面同时呈现「批量更新（已完成）」与可点的「更新」按钮，正是用户报告的矛盾。
      useEffect(function () {
        if (IS_SKILL) return;
        call('update-all-status').then(absorb).then(function (r) {
          var b = r && r.ok ? r.batch : null
          if (!b) return
          setBatch(b)
          if (b.running === true) {
            setBusy('update:all')
            pollBatch().then(function (bb) {
              setBusy('')
              /* 只有真拿到逐项结果才置位锁：否则会出现「一键更新已禁用、行锁却不存在」
                 —— 又变回同一类自相矛盾（宿主状态文件被外部删掉时就会走到这里）。 */
              if (bb && Array.isArray(bb.items) && bb.items.length > 0) { setBatchSettled(true); setLockedAt(Date.now()); absorbBatch(bb) } else { setBatch(b) }
              snapshot({ force: true })
            })
            return
          }
          if (!Array.isArray(b.items) || b.items.length === 0) return
          var finished = typeof b.finishedAt === 'number'
          var fresh = finished && Date.now() - b.finishedAt < LOCK_MS
          setBatchSettled(fresh)
          if (fresh) setLockedAt(Date.now())
          if (fresh) absorbBatch(b); else absorbResults('update', b.items)
          setNote({
            kind: finished ? (/失败 [1-9]/.test(String(b.message)) ? 'err' : (/未变化 [1-9]/.test(String(b.message)) ? 'note' : 'ok')) : 'err',
            text: finished
              ? ('上次批量执行（' + agoText(b.finishedAt) + '）：' + String(b.message) +
                (fresh ? '；下表已按该结果锁定，点「刷新状态」可重新判定。'
                  : '；该记录已超出锁定保鲜期，不再约束下表 —— 下表按当前快照判定，仍可能显示「更新」。'))
              : ('上次批量更新未跑完（' + String(b.message) + '）：' + b.items.length + ' 项里只有中断前完成的那些有结果，'
                + '它不锁定下表 —— 请点「刷新状态」让宿主重新判定后重试。'),
          });
        });
      }, [absorb, absorbResults, pollBatch, snapshot]);

      var refresh = useCallback(function () {
        setBusy('refresh');
        // 刷新 = 重新判定：清掉「本轮已完成」标记，让按钮按新数据重新决定可用性
        var lockCount = Object.keys(done).length
        setDone({});
        setBatchSettled(false);
        setLockedAt(0);
        setNote({ kind: 'note', text: '正在刷新（状态 + 版本 + 更新检查）…' });
        return snapshot({ force: true }).then(function (v) {
          setBusy('');
          if (v) {
            var s = summarize(v, IS_SKILL);
            setNote({ kind: s.upd || s.pending ? 'note' : 'ok',
              text: '刷新完成：已装 ' + s.total + '，已优化 ' + s.refined + '，待应用 ' + s.toApply + '，待生成文案 ' + s.pending + '，可更新 ' + s.upd + (s.unk ? '，无法比对 ' + s.unk : '') +
                (lockCount > 0 ? '；已释放上一轮的 ' + lockCount + ' 个行锁，下表按最新快照重新判定。' : '') });
          }
        });
      }, [done, snapshot]);

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
                  var items = ap && Array.isArray(ap.value) ? ap.value : [];
                  var applied = items.filter(function (x) { return x.state === 'applied'; }).length;
                  absorbResults('apply', items);
                  return snapshot({ force: true }).then(function (v) {
                    setBusy('');
                    if (!ap || !ap.ok) { setNote({ kind: 'err', text: '应用失败：' + ((ap && ap.message) || '未知') }); return; }
                    var ss = v ? summarize(v, true) : null;
                    setNote({ kind: gFail.length ? 'err' : 'ok',
                      text: '翻译优化（技能）：生成 ' + gOk + '/' + pend.length + ' · 应用 ' + applied + ' 项 · 跳过 ' + (cur.length - toApplyS.length) + ' 个（已优化或随 DSH 提供）' +
                        (ss ? '；当前已优化 ' + ss.refined + '/' + ss.total : '') +
                        (gFail.length ? ' · 生成失败 ' + gFail.length + ' 个 —— 逐项原因与重试入口见「本轮结果」' : '') });
                  });
                });
              }
              var pkg = pend[si].pkg;
              si += 1;
              setNote({ kind: 'note', text: '生成技能文案 ' + si + '/' + pend.length + '：' + pkg + ' …（调用模型，消耗 token）' });
              return call('generate-skill', { pkg: pkg }).then(absorb).then(function (g) {
                if (g && g.ok) {
                  gOk += 1;
                  absorbResults('generate', [{ pkg: pkg, state: 'generated', message: (g.entry && g.entry.zh && g.entry.zh.description) || '已写入覆盖层' }]);
                } else {
                  var why = (g && g.message) || '未知';
                  gFail.push(pkg + '（' + why + '）');
                  absorbResults('generate', [{ pkg: pkg, state: 'failed', code: g && g.code, message: why }]);
                }
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
                var items = ap && Array.isArray(ap.value) ? ap.value : [];
                var applied = items.filter(function (x) { return x.state === 'applied'; }).length;
                absorbResults('apply', items);
                return snapshot({ force: true }).then(function (v) {
                  setBusy('');
                  if (!ap || !ap.ok) { setNote({ kind: 'err', text: '应用失败：' + ((ap && ap.message) || '未知') }); return; }
                  var s = v ? summarize(v) : null;
                  setNote({ kind: genFail.length ? 'err' : 'ok',
                    text: '翻译优化完成：新生成 ' + genOk + '/' + pending.length + ' 条文案，应用 ' + applied + ' 项，跳过已优化 ' + skipped + ' 个' +
                      (s ? '；当前已优化 ' + s.refined + '/' + s.total : '') +
                      (genFail.length ? ' · 生成失败 ' + genFail.length + ' 个 —— 逐项原因与重试入口见「本轮结果」' : '') });
                });
              });
            }
            var pkg = pending[i].pkg;
            i += 1;
            setNote({ kind: 'note', text: '生成文案 ' + i + '/' + pending.length + '：' + pkg + ' …（调用模型，消耗 token）' });
            return call('generate', { pkg: pkg }).then(absorb).then(function (g) {
              if (g && g.ok) {
                genOk += 1;
                absorbResults('generate', [{ pkg: pkg, state: 'generated', message: (g.entry && g.entry.zh && g.entry.zh.description) || '已写入覆盖层' }]);
              } else {
                var why = (g && g.message) || '未知';
                genFail.push(pkg + '（' + why + '）');
                absorbResults('generate', [{ pkg: pkg, state: 'failed', code: g && g.code, message: why }]);
              }
              return stepGen();
            });
          };
          return stepGen();
        });
      }, [absorb, absorbResults, snapshot]);

      var revert = useCallback(function () {
        setBusy('revert');
        setNote({ kind: 'note', text: '正在还原…' });
        if (IS_SKILL) {
          return call('revert-skills').then(absorb).then(function (r) {
            var items = r && Array.isArray(r.value) ? r.value : [];
            var restored = items.filter(function (x) { return x.state === 'restored'; }).length;
            absorbResults('revert', items);
            return snapshot({ force: true }).then(function () {
              setBusy('');
              if (r && r.ok) setNote({ kind: 'ok', text: '技能还原完成：' + restored + ' 项（SKILL.md 已按备份恢复）' });
              else setNote({ kind: 'err', text: '还原失败：' + ((r && r.message) || '未知') });
            });
          });
        }
        return call('revert').then(absorb).then(function (r) {
          var items = r && Array.isArray(r.value) ? r.value : [];
          var restored = items.filter(function (x) { return x.state === 'restored'; }).length;
          absorbResults('revert', items);
          return snapshot({ force: true }).then(function (v) {
            setBusy('');
            var s = v ? summarize(v) : null;
            if (r && r.ok) setNote({ kind: 'ok', text: '还原完成：' + restored + ' 项' + (s ? '；当前已优化 ' + s.refined : '') });
            else setNote({ kind: 'err', text: '还原失败：' + ((r && r.message) || '未知') });
          });
        });
      }, [absorb, absorbResults, snapshot]);

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

      /**
       * 技能更新：宿主侧只做 git 快进，一个请求回来就是最终结果。
       * 与插件侧共用同一套收尾：完成态写进 done（按钮按结果暗下去）、结果进「本轮结果」、
       * 并且**必须**置位 batchSettled —— 否则会出现「行按钮已暗、一键更新却还能点」的自相矛盾。
       */
      var updateSkills = useCallback(function (pkgs) {
        setBusy('update:all');
        setNote({ kind: 'note', text: '正在更新技能（' + pkgs.length + ' 个，git 快进）…' });
        return call('update-skills', { pkgs: pkgs }).then(absorb).then(function (r) {
          setBusy('');
          if (!r || !r.ok) {
            setNote({ kind: 'err', text: '技能更新未执行：' + ((r && r.message) || '未知') + ' → ' + fixOf(r && r.code) });
            return null;
          }
          var items = Array.isArray(r.value) ? r.value : [];
          var nUpdated = items.filter(function (x) { return x.state === 'updated'; }).length;
          var nSame = items.filter(function (x) { return x.state === 'unchanged'; }).length;
          var nFail = items.filter(function (x) { return x.state === 'failed'; }).length;
          setDone(function (prev) {
            var n = Object.assign({}, prev);
            for (var i = 0; i < items.length; i += 1) n[items[i].pkg] = { state: items[i].state, message: items[i].message };
            return n;
          });
          setBatchSettled(true);
          setLockedAt(Date.now());
          setBatch({
            running: false, total: items.length, index: Math.max(0, items.length - 1),
            items: items, finishedAt: Date.now(),
            message: '：更新 ' + nUpdated + ' 个，未变化 ' + nSame + ' 个，失败 ' + nFail + ' 个',
          });
          absorbResults('update', items);
          /* 宿主会 filter(isSafePackageName)：技能名带空格/中文时会被静默丢掉，
             那样「我点了更新、什么都没发生」—— 必须替它补一条如实说明。 */
          var echo = {};
          for (var k = 0; k < items.length; k += 1) echo[items[k].pkg] = true;
          var silent = pkgs.filter(function (p) { return echo[p] !== true; });
          if (silent.length > 0) {
            absorbResults('update', silent.map(function (p) {
              return { pkg: p, state: 'failed', code: 'invalid-pkg', message: '宿主没有回应该技能（名称可能不符合包名规则，已在服务端被过滤）' };
            }));
          }
          return snapshot({ force: true }).then(function () {
            setNote({ kind: nFail > 0 ? 'err' : (nUpdated > 0 ? 'ok' : 'note'),
              text: '技能更新完成：更新 ' + nUpdated + ' 个，未变化 ' + nSame + ' 个，失败 ' + nFail + ' 个' +
                (nFail > 0 ? '（每项失败原因都在「本轮结果」里，可逐项重试）' : '') });
            return items;
          });
        });
      }, [absorb, absorbResults, snapshot]);

      var doUpdate = useCallback(function (pkg) {
        setBusy('update:' + pkg);
        setNote({ kind: 'note', text: '正在更新 ' + pkg + ' …' });
        // 技能走 git 快进（一个请求给最终结果）；插件走第一方 pluginManager + 轮询
        if (IS_SKILL) {
          return updateSkills([pkg]).then(function () { setBusy(''); });
        }
        // 单行更新也必须置位 batchSettled：否则会出现「行按钮已按结果暗下去、
        // 一键更新却仍然可点」—— 那是同一处矛盾的另一半。
        return updateOne(pkg).then(function (res) {
          setBusy('');
          setDone(function (prev) { var n = Object.assign({}, prev); n[pkg] = { state: res.ok ? 'ok' : 'fail', message: res.message }; return n; });
          setBatchSettled(true);
          setLockedAt(Date.now());
          return snapshot({ force: true }).then(function () {
            absorbResults('update', [{ pkg: pkg, state: res.ok ? 'updated' : 'failed', code: res.code, message: res.message }]);
            if (res.ok) setNote({ kind: 'ok', text: pkg + ' 更新完成，状态已刷新。' });
            else setNote({ kind: 'err', text: pkg + ' 更新失败：' + res.message + ' → ' + fixOf(res.code) });
          });
        });
      }, [absorbResults, snapshot, updateOne, updateSkills]);

      /** 逐项重试：动作不同走不同路径，但都复用已经验证过的调用链。 */
      var retryOne = useCallback(function (entry) {
        if (!entry || typeof entry.pkg !== 'string') return null;
        if (entry.action === 'update') return IS_SKILL ? updateSkills([entry.pkg]) : doUpdate(entry.pkg);
        return optimize();
      }, [doUpdate, optimize, updateSkills]);

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
            // 宿主逐个给出结果：按结果把每一行的按钮暗下去。未变化/失败的行虽然仍可更新，
            // 但这一轮已经处理过，不再允许重复点击 —— 要重试先「刷新状态」重新判定。
            // 只有真拿到逐项结果才置位锁，否则「一键更新已禁用」会没有对应的行锁。
            if (b && Array.isArray(b.items) && b.items.length > 0) { setBatchSettled(true); setLockedAt(Date.now()); absorbBatch(b); }
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
      var updatablePkgs = noRows ? [] : rows.filter(function (r) { return r.hasUpdate === true; }).map(function (r) { return r.pkg; });
      var lockedCount = Object.keys(done).length;
      var locked = lockedCount > 0;
      /* 口径原因由这里显式判定，不让 lockNote 去猜：
         - running    宿主侧正在跑
         - locked     行锁仍生效
         - released   记录还在保鲜期内、但已无行锁 → 只可能是用户点了「刷新状态」
         - interrupted 没有 finishedAt（宿主判为无进展而中断）
         - noitems    记录里没有任何逐项结果
         - expired    记录确实超出了保鲜期
         - session    没有批量记录，只有本次会话的单行动作
         先判 released/interrupted 再判 expired —— 反过来就会把「主动释放」说成「超期」。 */
      var lockReason = 'session';
      if (batch !== null) {
        if (batch.running === true) lockReason = 'running';
        else if (locked) lockReason = 'locked';
        else if (!Array.isArray(batch.items) || batch.items.length === 0) lockReason = 'noitems';
        else if (typeof batch.finishedAt !== 'number') lockReason = 'interrupted';
        else if (Date.now() - batch.finishedAt < LOCK_MS) lockReason = 'released';
        else lockReason = 'expired';
      }

      var head = h('div', { className: 'das-bar' },
        opBtn('opt', busy === 'optimize' ? '优化中…' : '翻译优化', busyNow || noOptimize, optimize,
          noOptimize ? (noRows ? '状态尚未读取完成' : '全部条目均已优化，无待办') : '生成缺失文案并应用全部改写'),
        opBtn('rev', busy === 'revert' ? '还原中…' : '还原翻译', busyNow || noRevert, revert,
          noRevert ? (noRows ? '状态尚未读取完成' : '当前没有处于「已优化」状态的条目，无需还原') : '撤销全部已应用的改写'),
        opBtn('ref', busy === 'refresh' ? '刷新中…' : '刷新状态', busyNow, refresh,
          '重新取一次完整快照（状态 + 版本 + 更新检查），并释放本轮行锁'),
        opBtn('all', busy === 'update:all' ? (IS_SKILL ? '技能更新中…' : '批量更新中…') : '一键更新（' + updatable + '）',
          busyNow || noUpdate,
          function () {
            if (IS_SKILL) updateSkills(updatablePkgs);
            else updateAll(rows);
          },
          noRows ? '状态尚未读取完成'
            : (updatable === 0
              ? (IS_SKILL ? '当前没有可更新的技能（非 git 目录没有远端可比）' : '当前没有可更新的插件')
              : (batchSettled ? '本轮已处理过更新（未变化 / 失败也不重复执行）；点「刷新状态」可重新判定'
                : (IS_SKILL ? '按顺序 git 快进全部可更新技能' : '按顺序更新全部可更新插件'))),
          false, 'primary'));

      var revGap = hostRev !== '' && hostRev !== CLIENT_REV;
      var staleEl = (stale || revGap)
        ? h('div', { className: 'das-note is-err' },
            chip('sg', '版本不一致', 'err'),
            h('span', { className: 'das-note-text' }, revGap
              ? '客户端半体 v' + CLIENT_REV + ' 与运行中的宿主半体 v' + hostRev + ' 不一致：' +
                (compareRev(hostRev, CLIENT_REV) < 0
                  ? '宿主半体是旧的 —— 它只在 DSH 进程启动时加载一次，因此可能缺少本页需要的接口（例如 /skills）。请重启 DSH。'
                  : '客户端半体是旧的（页面来自缓存）。请刷新页面。')
              : '宿主半体版本过旧：运行中的是进程启动时加载的代码，因此缺少新接口。请重启 DSH 后重试。'))
        : null;

      var noteEl = note
        ? h('div', { className: 'das-note' + (note.kind === 'err' ? ' is-err' : (note.kind === 'ok' ? ' is-ok' : '')) },
            chip('nk', note.kind === 'err' ? '失败' : (note.kind === 'ok' ? '完成' : '进行中'), note.kind === 'err' ? 'err' : (note.kind === 'ok' ? 'ok' : 'info')),
            h('span', { className: 'das-note-text' }, note.text))
        : null;

      /* KPI 数据带：把汇总从「一行密文」拆成可扫读的格子，并给每格写明定义。 */
      var kpiCells = [];
      if (s) {
        kpiCells.push(kpiCell('k1', s.total, IS_SKILL ? '技能' : '插件', '本次快照里的条目总数'));
        kpiCells.push(kpiCell('k2', s.refined, '已优化', '文案已落盘（插件：locale 覆盖层；技能：SKILL.md 已改写）', s.refined > 0 ? 'ok' : null));
        kpiCells.push(kpiCell('k3', s.toApply, '待应用', '已有文案但未落盘；点「翻译优化」应用', s.toApply > 0 ? 'warn' : null));
        kpiCells.push(kpiCell('k4', s.pending, '待生成文案', '没有文案条目，需要调用模型生成（消耗 token）', s.pending > 0 ? 'warn' : null));
        kpiCells.push(kpiCell('k5', s.upd, '可更新', IS_SKILL ? '远端比本地新的 git 技能数' : 'npm 上比已装版本新的插件数', s.upd > 0 ? 'warn' : 'dim'));
        kpiCells.push(kpiCell('k6', s.unk, '无法比对', IS_SKILL ? '是 git 仓库但远端查不到（不可比）' : '最新版本查询失败（不可比）', s.unk > 0 ? 'dim' : null));
        if (IS_SKILL) {
          kpiCells.push(kpiCell('k7', s.noRepo, '本地目录', '不是 git 仓库，没有远端可比', s.noRepo > 0 ? 'dim' : null));
          kpiCells.push(kpiCell('k8', s.bundled, '随 DSH 提供', '在 app.asar 内、没有可写路径，只入表不参与优化', s.bundled > 0 ? 'dim' : null));
          kpiCells.push(kpiCell('k9', s.dirty, '有本地改动', 'git 工作区有未提交修改；快进会被 git 拒绝', s.dirty > 0 ? 'warn' : null));
          kpiCells.push(kpiCell('k10', s.english, '描述为英文', '中文可读性较低；改写 description 属行为变更', s.english > 0 ? 'warn' : null));
        }
        var findings = audit && audit.counts ? (audit.counts.fact + audit.counts.inferred) : 0;
        kpiCells.push(findings > 0
          ? kpiButton('k11', findings, '审查 ' + (onlyFlagged ? '· 仅看命中' : '· 点此筛选'),
              '事实 ' + audit.counts.fact + ' 条 / 推断 ' + audit.counts.inferred + ' 条；点一下只看命中行',
              audit.counts.fact > 0 ? 'warn' : 'dim',
              function () { setOnlyFlagged(!onlyFlagged); })
          : kpiCell('k11', 0, '审查无发现', '本轮审查没有命中任何规则', 'ok'));
      }
      var kpiEl = kpiCells.length > 0 ? h('div', { className: 'das-kpi' }, kpiCells) : null;

      // 两页各自渲染自己那一份：「本轮结果」由 results 承载，批量进度由 batch 承载
      var resultsEl = h(ResultsPanel, {
        results: results, batch: batch, isSkill: IS_SKILL, locked: locked, lockedCount: lockedCount,
        lockReason: lockReason, lockedAt: lockedAt, onRetryOne: retryOne,
      });

      /* 行按钮与「本轮结果」记录一致时不必再说；一旦行按钮不再代表那一轮（记录已超期、锁已释放），
         就把记录贴回该行 —— 这正是用户看到「状态栏说完成、行里还能点更新」时缺的那一句话。 */
      var recordByPkg = {};
      for (var ri = 0; ri < results.length; ri += 1) recordByPkg[results[ri].pkg] = results[ri];

      var visible = (onlyFlagged && rows) ? rows.filter(function (r) { return (r.issues || []).length > 0 || (r.findings || []).length > 0; }) : rows;

      var table = rows === null
        ? h('div', { className: 'das-note' }, h('span', { className: 'das-note-text' }, IS_SKILL ? '正在读取技能状态…' : '正在读取插件状态…'))
        : h('div', { className: 'das-wrap' },
            h('table', { className: 'das-table' },
              h('thead', null, h('tr', null,
                h('th', null, IS_SKILL ? '技能' : '插件'),
                h('th', null, IS_SKILL ? '优化 · 描述' : '优化'),
                h('th', null, IS_SKILL ? '版本 / 修订' : '版本'),
                h('th', null, IS_SKILL ? '来源 / 远端' : '最新'),
                h('th', null, '操作'))),
              h('tbody', null, visible.map(function (r) {
                var upd = r.hasUpdate === true;
                var job = jobs[r.pkg];
                var issues = r.issues || [];
                var findings = r.findings || [];
                var rev = IS_SKILL ? skillRevision(r) : null;
                var facts = findings.filter(function (f) { return f.confidence === 'fact'; });
                var sev = facts.some(function (f) { return f.severity === 'high'; }) ? 'high'
                  : (facts.some(function (f) { return f.severity === 'medium'; }) ? 'medium' : 'low');
                /* 事实级发现直接摊在行内（带严重度徽章 + 标题片段），
                   推断级只计数、留在「详情」里 —— 行内不塞噪音，但仍能一眼看到有没有真问题。 */
                var factTitle = facts.length > 0 ? String(facts[0].title) : '';
                var factLine = facts.length > 0
                  ? h('div', { title: facts.map(function (f) { return (SEV[f.severity] || f.severity) + ' · ' + f.title; }).join('\n') },
                      h('span', { className: 'das-sev ' + (SEV_CLASS[sev] || 'is-low') }, SEV[sev]),
                      h('span', { className: 'das-foot' }, ' ' + factTitle.slice(0, 38) + (factTitle.length > 38 ? '…' : '')))
                  : null;
                var stateTone = r.bundled === true ? 'dim' : (r.localized ? 'ok' : 'warn');
                var stateText2 = r.bundled === true ? '随 DSH 提供' : (r.localized ? '已优化' : (r.needsText ? '待生成文案' : '待应用'));
                var record = recordByPkg[r.pkg];
                var recordChip = (record && done[r.pkg] === undefined)
                  ? chip('rc', '本轮 · ' + stateText(record.state), STATE_TONE[record.state] || 'dim',
                      '这是「本轮结果」里针对本行的记录（' + agoText(record.at) + '，动作：' + (ACTION_TEXT[record.action] || record.action) + '）：' +
                      (record.message || '') + '。它不是当前状态：当前状态由版本列与「更新」按钮决定。')
                  : null;
                var latestCell = IS_SKILL
                  ? h('span', { className: 'das-desc' },
                      shortRoot(r.source) || '—',
                      r.isGit === true
                        ? ' · ' + (r.hasUpdate === true ? '↑ 远端 ' + shortShaOf(r.remoteSha)
                          : (r.hasUpdate === false ? '最新 ' + shortShaOf(r.localSha) : '未比对（' + (r.reason || '未知') + '）'))
                          + (r.dirty > 0 ? ' · 本地改动 ' + r.dirty + ' 个文件' : '')
                        : ' · 本地目录')
                  : h('span', { className: 'das-desc', title: r.reason || (r.latest ? 'npm registry 上的最新版本' : undefined) },
                      r.latest ? (upd ? '↑ ' + r.latest : r.latest) : (r.reason || '—'));
                var cells = [
                  h('td', { className: 'das-name' },
                    r.pkg,
                    r.displayName && r.displayName !== r.pkg ? h('small', null, r.displayName) : null),
                  h('td', null,
                    chip('lo', stateText2, stateTone,
                      r.bundled === true ? '在 app.asar 内，没有可写路径，不参与优化'
                        : (r.localized ? '文案已落盘' : (r.needsText ? '还没有文案条目，需要调用模型生成' : '已有文案但未落盘，点「翻译优化」应用'))),
                    IS_SKILL ? h('div', { className: 'das-foot' }, '描述语言 ' + (r.descriptionLang || '未知')) : null,
                    factLine),
                  h('td', { className: 'das-num' },
                    IS_SKILL ? h('span', { title: rev.title }, rev.text) : h('span', { title: 'package.json 里已安装的版本' }, r.version || '—')),
                  h('td', { className: 'das-wrapd' }, latestCell, recordChip),
                ];
                var op = [];
                var finished = done[r.pkg];
                if (job && !job.done) op.push(h('span', { key: 'j', className: 'das-foot' }, job.stage + '…'));
                // 本会话已处理过这一行：按结果暗下去（未变化/失败也不允许重复点击，重试先「刷新状态」）
                else if (finished) op.push(opBtn('u', outcomeLabel(finished), true, null,
                  (finished.message ? finished.message + ' · ' : '') + '本轮已处理；点「刷新状态」可重新判定'));
                else if (upd) op.push(opBtn('u', '更新', busyNow, function () { doUpdate(r.pkg); },
                  IS_SKILL ? 'git 快进到远端 ' + shortShaOf(r.remoteSha) : '更新到 ' + (r.latest || '最新版'), true));
                if (issues.length || findings.length) {
                  op.push(h('button', {
                    key: 'i', type: 'button', className: 'das-btn das-mini',
                    title: '查看该条的审查发现与问题说明',
                    onClick: function () { setOpenPkg(openPkg === r.pkg ? '' : r.pkg); },
                  }, (openPkg === r.pkg ? '收起详情' : '详情 ' + (issues.length + findings.length))));
                }
                cells.push(h('td', { className: 'das-act' }, op.length ? op : null));
                return h('tr', { key: r.profileDir + '|' + r.pkg, className: r.installed === false ? 'is-dim' : undefined }, cells);
              }))));

      var openRow = rows ? rows.filter(function (r) { return r.pkg === openPkg; })[0] : null;
      var detail = openRow
        ? h('div', { className: 'das-detail' },
            h(FindingCard, { pkg: openRow.pkg, findings: openRow.findings, onIgnore: ignore, busy: busy.indexOf('ignore:') === 0 }),
            (openRow.issues || []).length ? h(IssueCard, { pkg: openRow.pkg, issues: openRow.issues, onRetry: refresh }) : null)
        : null;

      return h('div', { className: 'das-root' },
        h('div', { className: 'das-head' },
          h('h3', { className: 'das-title' }, LABEL,
            chip('cr', 'v' + CLIENT_REV, 'dim', '客户端半体版本（随页面刷新热更新）', true),
            chip('hr', hostRev ? '宿主 v' + hostRev : '宿主未知', revGap ? 'err' : 'dim',
              '宿主半体只在 DSH 进程启动时加载一次；它与客户端版本不一致时，新接口可能不存在', true)),
          h('p', { className: 'das-sub' }, IS_SKILL
            ? '技能视图：一源数据、一套规则。技能不是 npm 包，因此没有可比的「最新版本」——「版本 / 修订」显示 SKILL.md 声明的 version，未声明就回落到 git 提交号。'
            : '插件视图：命名约定为标题保留原包名、中文名以（）附加。刷新即包含状态、版本与更新检查（同一份快照）。')),
        head,
        staleEl,
        kpiEl,
        noteEl,
        resultsEl,
        table,
        detail,
        h('p', { className: 'das-sub' }, IS_SKILL
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
          className: 'das-seg-btn',
          onClick: function () { setMode(key); },
        }, text);
      };
      return h('div', { className: 'das-root' },
        h('style', { key: 'das-css' }, CSS),
        h('div', { className: 'das-head' },
          h('div', { className: 'das-seg', role: 'tablist' },
            tab('plugin', '插件', '插件半体：翻译优化、版本与更新、冲突与兼容审查'),
            tab('skill', '技能', '技能 SKILL.md：翻译优化、来源与审查'))),
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
