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
    var CLIENT_REV = '2.10.7';
    /* 本插件自己的包名：客户端就是它自己，所以它自己的中文名不必等宿主提供
       （否则列表里 6 行是中文、唯独自己那一行是包名，看着像坏了）。 */
    var OWN_PKG = 'dsh-audit-skills';
    /* 行锁保鲜期。必须与宿主半体的 BATCH_STALE_MS 同值（10 分钟）：
       宿主用这个窗口判「批量是否还在跑」，客户端用同一个窗口判「这批结果还算不算数」。
       超期后记录仍如实显示，但不再锁定下表，并在页面上写明原因。 */
    var LOCK_MS = 10 * 60 * 1000;
    /* @catalog-snapshot:start（由 scripts/build-client-catalog.mjs 生成，勿手改） */
    /* 内置 catalog 的中文快照（8 条以内、约 1KB）：旧宿主（<2.9）不发 displayName/localizedDescription，
       而客户端半体是热更新的，所以用这份仓库数据兜底，让列表在旧宿主下也能直接显示优化结果。
       只含仓库内置条目；用户覆盖层（LLM 生成）不在其中，缺失时如实说明而不是编造。 */
    var CATALOG_ZH = {
      "@changfenhuang/dsh-annotation": ["@changfenhuang/dsh-annotation（划词批注）","选中助手回复中的文字即可批注，回车随消息一起发送；模型按编号逐条回应，回复里带可悬停的批注标签。只作用于对话输入，不改变模型能力。"],
      "@furongjun1999/dsh-memory": ["@furongjun1999/dsh-memory（灵枢记忆）","长期记忆与知识飞轮：对话自动沉淀为 md_cg 认知图，带自我认知与递归反思。会在每轮对话注入记忆上下文。"],
      "@linxin666/dsh-remote-web-ui": ["@linxin666/dsh-remote-web-ui（远程访问）","扫码把手机与电脑配对到同一个 Web GUI：一次性令牌、可撤销设备会话、局域网绑定开关与可选的 Cloudflare 隧道。"],
      "dsh-better-sidebar": ["dsh-better-sidebar（增强侧边栏）","右侧栏提供文件树、编辑器、文件变动、任务与侧边对话，每个会话独立。仅改变界面，不改变模型能力。"],
      "dsh-computer-use-win": ["dsh-computer-use-win（Windows 桌面操控）","让模型读取并操作真实 Windows 桌面应用：UI Automation 树、截图、键入、OCR 与窗口管理。经 MCP 桥接，需 @deepseek-ai/dsh-mcp-client；会真实操作桌面，注意授权范围。"],
      "dsh-context": ["dsh-context（上下文洞察）","上下文洞察与管理：仪表盘、上下文浏览器、上下文动态与 /context 命令，看清上下文的构成与演变。只做分析，不改写会话内容。"],
      "dsh-find-plugins": ["dsh-find-plugins（插件检索）","在全 DSH 插件生态里按能力检索：聚合多个社区目录 + GitHub/npm 实时搜索，按相关度×可信度×新鲜度排序。只做发现，不负责安装。"],
      "dsh-free-search": ["dsh-free-search（免费搜索）","接管内置 web_search：13 个引擎自动降级，默认免 API key，支持时间过滤与平台搜索。只负责搜索，不接管网页抓取。"],
      "dsh-plugin-marketplace": ["dsh-plugin-marketplace（DSH插件市场）","浏览并安装 GitHub 上标记为 topic:dsh-plugin 的 DSH 插件。插件来源完全依赖该 GitHub topic，只提供浏览与安装，安装操作会在本地新增插件。"],
      "dsh-web-fetch-playwright": ["dsh-web-fetch-playwright（浏览器抓取）","为 web_fetch 提供浏览器后端：真实浏览器渲染后经 Readability 去噪返回 Markdown。只负责抓取，不是搜索提供方。"],
      "dsh-whale-widget": ["dsh-whale-widget（余额小鲸鱼）","右下角挂件：显示 DeepSeek 余额、今日用量与峰谷定价，可自定义气泡、角色与音效。纯前端展示，不参与对话。"],
    };
/* @catalog-snapshot:end */

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
      /* 宿主上下文注入失败：属于「两端版本/未重启」，重试与刷新都没用，只有重启能解决。 */
      if (c === 'host-inject') return '插件与宿主半体能力不匹配（宿主半体版本过旧或未重启）→ 请重启 DSH。'
      if (c === 'unsupported-spec') return '该包是内置或本地依赖，请在插件页处理。'
      if (/^http-4/.test(c)) return '宿主半体没有这个接口（运行的是启动时加载的旧代码）→ 请重启 DSH。'
      if (c === 'llm-unavailable') return 'LLM 服务不可用或未注册；请确认模型服务已启用后重试。'
      /* 宿主插件管理器自己的失败码：以前页面上会出现裸的 ambiguous-install，用户既看不懂也不知道做什么。 */
      if (c === 'ambiguous-install') return '宿主管理器无法确认这次安装对应哪个包（git 直装依赖重装时依赖字符串不变就会出现）→ 已阻止，未做任何改动。'
      if (c === 'invalid-spec') return '宿主管理器不接受这个依赖规格，请检查 profile 里的依赖写法。'
      if (c === 'bundle-in-use') return '该 bundle 正在使用中，宿主拒绝在运行中替换；重启 DSH 后再试。'
      if (c === 'management-required' || c === 'unaddressable') return '该对象由宿主管理（或在 app.asar 内），没有可写路径，不能从这里更新。'
      if (c === 'stale-approval') return '安装审批已过期，请重新发起。'
      if (c === 'out-of-scope') return '该对象已归档或不属于 DSH 管理范围，已阻止误操作。'
      if (c === 'skill-overlay-write-failed' || c === 'overlay-write-failed') return '模型结果已生成，但写入翻译覆盖层失败；检查文件权限和磁盘空间后重试。'
      if (c === 'no-model') return '找不到默认模型，请先在设置里选定默认模型再重试。'
      if (c === 'bad-output') return '模型输出不是约定 JSON；系统已自动重试 1 次，可再次点击，反复失败请手动补录。'
      if (c === 'generate-failed') return '生成请求失败；当前行会显示宿主返回的具体原因，可按原因重试或检查模型服务。'
      if (c === 'not-found') return '该对象已不存在（可能被移除或改名），刷新状态即可对齐。'
      if (c === 'not-installed') return '该包未安装或不是 DSH bundle，无法生成文案。'
      if (c === 'invalid-pkg' || c === 'missing-pkg') return '参数非法，已被宿主拒绝。'
      if (c === 'timeout' || c === 'pending-check') return '待确认：安装请求已提交但宿主等待超时，先点「刷新状态」确认，不要重复点击更新。'
      if (c === 'confirmation-timeout') return '超过确认窗口仍没有最终回执；先重启 DSH，再点「刷新状态」核对版本，确认未变化后再重试。'
      if (c === 'recovered-after-restart') return '更新在 DSH 重启期间完成，已恢复为当前版本；刷新状态即可。'
      if (c === 'stale-after-restart') return '任务超过 24 小时未确认，已停止自动等待；刷新状态后重新发起更新。'
      if (c === 'restart-required') return '依赖已重新安装但宿主要求重启 DSH；重启后点「刷新状态」确认运行中的插件。'
      if (c === 'update-pending') return '已有安装请求在等待宿主确认；先点「刷新状态」，不要重复启动更新。'
      if (c === 'post-update-failed') return '安装可能已完成，但更新后的补回或变化摘要失败；先刷新状态，确认版本后再处理文案。'
      if (c === 'incompatible-version') return '目标版本与当前 DSH 运行时不兼容，管理器已自动恢复原版本；请查看当前行详情，等待兼容版本或升级 DSH。'
      if (c === 'update-failed') return '安装失败，原因见当前行；可先刷新状态，再重试。'
      if (c === 'unchanged') return '安装请求已执行，但已安装版本没有变化；请检查依赖来源、锁文件或插件管理器日志。'
      if (c === 'batch-running') return '批量更新正在进行，等它结束后再更新这一项（避免两条 pnpm 并发安装）。'
      if (c === 'network') return '连不上宿主半体，确认 DSH 仍在运行后刷新页面。'
      return '可重试；若反复失败请「刷新状态」重新判定。'
    }

    /* 同一失败原因只在状态栏汇总一次；逐行详情仍保留完整原因。 */
    function compactFailures(list) {
      var items = Array.isArray(list) ? list : [];
      if (!items.length) return '';
      var groups = {};
      for (var i = 0; i < items.length; i += 1) {
        var raw = String(items[i] || '未知');
        var m = /^(.*?)（(.*)）$/.exec(raw);
        var pkg = m ? m[1] : raw;
        var reason = m ? m[2] : '未知原因';
        var key = reason || '未知原因';
        if (!groups[key]) groups[key] = { reason: key, pkgs: [] };
        if (groups[key].pkgs.indexOf(pkg) < 0) groups[key].pkgs.push(pkg);
      }
      return Object.keys(groups).map(function (key) {
        var g = groups[key];
        var names = g.pkgs.slice(0, 3).join('、') + (g.pkgs.length > 3 ? ' 等 ' + g.pkgs.length + ' 项' : '');
        return g.pkgs.length + ' 项：' + g.reason + '（' + names + '）';
      }).join('；');
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
      /* 次级文字用 secondary 而不是 tertiary/quaternary：截图里「一片灰」的根因就是
         把说明文字放到了亮度最低的令牌上。quaternary 只留给时间戳这类附带信息。 */
      '  --das-text2: var(--dsw-alias-label-secondary, rgba(127,127,127,1));',
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
      /* 用户报「有横向拉条」：面板作为 flex 子项时 min-width 默认 auto = 由内容最小宽度决定，
         一旦某一行内容不可压（等宽包名/URL/长按钮），整页就会被撑出横向滚动条。
         显式 min-width:0 + 表格 max-width:100% 把溢出堵在源头，横向滚动条不再出现。 */
      '  min-width: 0;',
      '}',
      '.das-root *, .das-root *::before, .das-root *::after { box-sizing: border-box; }',
      /* 设置页的可见宽度取决于窗口与分区，视口宽度骗不了它 —— 用容器查询：
         窄的时候把次级包名收起来（包名仍在该行 title 与悬停槽里，不丢信息），
         宽的时候再展示。这是本轮「字体/内容/行数/信息容纳量」取舍的落点。 */
      '.das-root { container-type: inline-size; }',
      '@container (max-width: 820px) { .das-name-pkg { display: none; } }',
      '.das-root p { margin: 0; }',
      '.das-root h3 { margin: 0; }',
      /* 命令头（原 Hero 位）：居中、单行、行内版本 chip */
      /* 头部压成两行：第一行 = 页签 + 标题（版本 chip），第二行 = 一句话价值。
         页签从独立一行并进标题行，省下一整行高度给内容。 */
      '.das-head { display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap; padding-top: 2px; text-align: left; }',
      '.das-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: 1 1 auto; min-width: 0;',
      '  font-size: var(--dsw-font-l-20-font-size, 20px); line-height: var(--dsw-font-l-20-line-height, 28px);',
      '  font-weight: var(--dsw-font-l-20-font-weight, 600); letter-spacing: -.01em; }',
      '.das-sub { font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: var(--dsw-font-xxs-12-line-height, 18px);',
      '  color: var(--das-dim); max-width: 92ch; flex-basis: 100%; }',
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
      /* 指标带：一行紧凑文本（用户反馈原来的格子网格太占地方）。
         数字用等宽 + 主色，标签用次级色；每项都有 title 说明「这个数字是什么」。 */
      '.das-stats { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 14px; padding: 5px 10px;',
      '  border: 1px solid var(--das-line); border-radius: var(--das-r); background: var(--das-l1);',
      '  font-size: var(--dsw-font-xxxs-11-font-size, 11px); line-height: 16px; }',
      '.das-stat { display: inline-flex; align-items: baseline; gap: 4px; min-width: 0; padding: 0; border: 0;',
      '  background: transparent; color: inherit; font: inherit; text-align: left; }',
      'button.das-stat { cursor: pointer; }',
      'button.das-stat:hover .das-stat-l { text-decoration: underline; }',
      '.das-stat-n { font-family: var(--das-mono); font-variant-numeric: tabular-nums; font-size: 13px; font-weight: 600; line-height: 17px; }',
      '.das-stat-l { color: var(--das-dim); white-space: nowrap; }',
      '.das-stat.is-warn .das-stat-n { color: var(--das-warn); }',
      '.das-stat.is-err .das-stat-n { color: var(--das-err); }',
      '.das-stat.is-ok .das-stat-n { color: var(--das-ok); }',
      '.das-stat.is-dim .das-stat-n { color: var(--das-dimmer); }',
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
      '.das-wrap { overflow-x: hidden; border: 1px solid var(--das-line); border-radius: var(--das-r);',
      '  background: var(--dsw-alias-bg-base, transparent); }',
      '.das-table { width: 100%; max-width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 0;',
      '  font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px; }',
      '.das-table th { position: sticky; top: 0; z-index: 1; text-align: left; padding: 3px 8px;',
      '  font-size: var(--dsw-font-xxxs-11-font-size, 11px); font-weight: 600; letter-spacing: .02em;',
      '  color: var(--das-dim); background: var(--dsw-alias-bg-layer-2, var(--das-l2));',
      '  border-bottom: 1px solid var(--das-line); white-space: nowrap; }',
      /* 一行一项：行高由 CSS 定死 26px（11px 文字 + 19~21px 的 chip/按钮仍留呼吸感）。
         以前行高由「哪一列换了几行」决定 —— 状态列与版本列各自 flex-wrap 之后，
         一行被撑成 2~4 行，于是「每页能看的插件太少」（用户本轮反馈的根因）。 */
      '.das-table td { height: 26px; padding: 1px 8px; border-bottom: 1px solid var(--das-line2); vertical-align: middle; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      /* 四列宽度合计 100%，操作列给足预算，否则按钮换行又变成两行 */
      '.das-table th:nth-child(1), .das-table td:nth-child(1) { width: 34%; }',
      '.das-table th:nth-child(2), .das-table td:nth-child(2) { width: 25%; }',
      '.das-table th:nth-child(3), .das-table td:nth-child(3) { width: 24%; }',
      '.das-table th:nth-child(4), .das-table td:nth-child(4) { width: 17%; }',
      '.das-table tbody tr { transition: background .18s ease, box-shadow .18s ease; }',
      '.das-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover, var(--das-l1));',
      '  box-shadow: inset 2px 0 0 0 var(--das-info); }',
      '.das-table tbody tr:last-child td { border-bottom: 0; }',
      '.das-table tr.is-dim td { opacity: .5; }',
      '.das-name { font-family: var(--das-mono); font-size: var(--dsw-font-xxs-12-font-size, 12px); word-break: break-all; }',
      '.das-name small { display: block; font-family: inherit; color: var(--das-dim); font-size: var(--dsw-font-xxxs-11-font-size, 11px); }',
      '.das-name-main { display: inline-block; font-family: var(--dsw-font-family, system-ui), "Microsoft YaHei UI", sans-serif; font-weight: 600; max-width: 20ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: baseline; }',
      /* 原包名退为次级：等宽 + 11px，挤在一行内，超长省略 */
      '.das-name-pkg { font-family: var(--das-mono); font-size: var(--dsw-font-xxxs-11-font-size, 11px); color: var(--das-dim); margin-left: 6px; max-width: 16ch; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: inline-block; vertical-align: baseline; }',
      /* 优化结果直接展示：与中文名同一行，占满剩余宽度后省略号截断；完整版在 title 与悬停卡 */
      '.das-desc-line { font-size: var(--dsw-font-xxxs-11-font-size, 11px); line-height: 15px; color: var(--das-text2); max-width: 38ch; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.das-name-pkg { font-family: var(--das-mono); }',
      '.das-mono { font-family: var(--das-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }',
      '.das-num { font-family: var(--das-mono); font-variant-numeric: tabular-nums; }',
      '.das-desc { color: var(--das-text2); max-width: 52ch; }',
      '.das-optimized-copy { margin-top: 4px; max-width: 52ch; color: var(--das-text2); line-height: 17px; overflow-wrap: anywhere; }',
      '.das-problem { margin-top: 4px; max-width: 52ch; color: var(--das-err); line-height: 17px; overflow-wrap: anywhere; }',
      /* 操作列：永不分行（按钮一换行，行高立刻从一行变两行）。按钮可缩到省略号，
         aria-label 仍是完整说明；不给原生 title，避免遮挡行详情卡。 */
      '.das-act { white-space: nowrap; }',
      '.das-act .das-btn { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }',
      /* ── 单行单元格：每列内容都包在一个 .das-cell 里（不换行的 flex 行）──
         列内元素分两类：不缩的（chip / 按钮）与可缩的（.das-fit：包名、说明、来源、远端版本）。
         于是任何宽度下每列都只占一行，行高不会被某一列顶起来，也不会把整格文字切掉。 */
      '.das-cell { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; flex-wrap: nowrap; white-space: nowrap; overflow: hidden; }',
      '.das-cell > * { flex: 0 0 auto; }',
      '.das-fit { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }',
      '.das-status-cell .das-cell, .das-act .das-cell { gap: 4px; }',
      /* chip 允许自己缩：文字在 .das-chip-t 里，缩到极限是省略号，而不是整格被切掉 */
      '.das-status-cell .das-chip, .das-version-cell .das-chip { flex: 0 1 auto; min-width: 0; }',
      '.das-chip-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.das-wrapd { white-space: normal; }',
      '.das-guidance { display: grid; gap: 6px; }',
      '.das-guidance-item { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; padding: 6px 9px; border: 1px solid var(--das-line2); border-left: 3px solid var(--das-info); border-radius: var(--das-r); background: var(--das-l1); font-size: 12px; line-height: 17px; }',
      '.das-guidance-item.is-err { border-left-color: var(--das-err); }',
      '.das-guidance-item.is-warn { border-left-color: var(--das-warn); }',
      '.das-guidance-item.is-ok { border-left-color: var(--das-ok); }',
      '.das-guidance-copy { color: var(--das-text2); }',
      '.das-guidance-action { color: inherit; font-weight: 600; }',
      '.das-evidence-cell { min-width: 0; }',
      '.das-table-meta { padding: 7px 10px; border-bottom: 1px solid var(--das-line2); background: var(--das-l1); }',
      '.das-table-meta .das-note { border: 0; padding: 0; background: transparent; }',
      '.das-purpose { max-width: 42ch; margin-top: 3px; color: var(--das-text2); line-height: 17px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }',
      '.das-purpose strong { color: inherit; font-weight: 600; }',
      '.das-source-cell { display: flex; flex-direction: column; gap: 2px; min-width: 170px; }',
      '.das-source-link { color: var(--das-info); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 28ch; }',
      '.das-source-link:hover { text-decoration: underline; }',
      /* chip 与严重度徽章 */
      '.das-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border: 1px solid var(--das-line);',
      '  border-radius: 999px; background: var(--das-l1); font-size: var(--dsw-font-xxxs-11-font-size, 11px); line-height: 15px;',
      '  color: var(--das-dim); white-space: nowrap; }',
      '.das-chip.is-ok { color: var(--das-ok); }',
      '.das-chip.is-err { color: var(--das-err); }',
      '.das-chip.is-warn { color: var(--das-warn); }',
      '.das-chip.is-info { color: var(--das-info); }',
      '.das-chip.is-mono { font-family: var(--das-mono); }',
      /* 「需处置 N / 附带观察 N」自己就是展开入口：省掉一个独立按钮，
         操作列不再和它抢宽度（这正是行高与列宽同时吃紧的一个来源）。 */
      '.das-chip-btn { appearance: none; cursor: pointer; font-family: inherit; text-align: left; }',
      '.das-chip-btn:hover { background: var(--das-l2); }',
      '.das-chip-btn[aria-expanded="true"] { background: var(--dsw-alias-fill-l2, rgba(127,127,127,.18)); }',
      '.das-sev { font-family: var(--das-mono); font-size: var(--dsw-font-xxxs-11-font-size, 11px); padding: 0 4px;',
      '  border: 1px solid currentColor; border-radius: 3px; }',
      '.das-sev.is-high { color: var(--das-err); }',
      '.das-sev.is-medium { color: var(--das-warn); }',
      '.das-sev.is-low { color: var(--das-dim); }',
      /* 状态提示行 */
      '.das-note { display: flex; align-items: flex-start; gap: 8px; padding: 5px 10px; border-radius: var(--das-r);',
      '  border: 1px solid var(--das-line2); background: var(--das-l1); font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px; }',
      '.das-note.is-err { border-color: var(--das-err); }',
      '.das-note.is-ok { border-color: var(--das-ok); }',
      '.das-note-text { min-width: 0; }',
      '.das-detail { display: flex; flex-direction: column; gap: 8px; margin-top: -2px; }',
      '.das-detail .das-card { box-shadow: 0 -6px 18px -12px rgba(0,0,0,.35); }',
      '.das-inline-detail { padding: 6px 10px 8px; background: var(--das-l1); border-bottom: 1px solid var(--das-line2); white-space: normal; overflow: visible; text-overflow: clip; }',
      '.das-inline-detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 6px 14px; }',
      '.das-inline-item { min-width: 0; padding-left: 8px; border-left: 2px solid var(--das-line); }',
      '.das-inline-item.is-high { border-left-color: var(--das-err); }',
      '.das-inline-item.is-medium { border-left-color: var(--das-warn); }',
      '.das-inline-item.is-ok { border-left-color: var(--das-ok); }',
      '.das-inline-title { font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 17px; }',
      '.das-inline-copy { color: var(--das-text2); font-size: var(--dsw-font-xxxs-11-font-size, 11px); line-height: 15px; overflow-wrap: anywhere; }',
      /* 悬停详情卡：**锚定在被悬停行的旁边**（借鉴本机 dsh-annotation 的做法：position:fixed +
         getBoundingClientRect + 下方放不下就翻到上方 + 双轴钳制视口）。
         此前它是表格下方一个固定槽位 —— 行在上方时，详情出现在页面底部，必须滚动才看得见。 */
      '.das-hover { position: fixed; z-index: 60; width: 420px; max-width: calc(100vw - 16px); padding: 8px 10px;',
      '  border: 1px solid var(--das-line); border-radius: var(--das-r); box-shadow: 0 10px 30px rgba(0, 0, 0, .28);',
      '  background: var(--dsw-alias-bg-elevated, var(--das-l1)); font-size: var(--dsw-font-xxxs-11-font-size, 11px);',
      '  line-height: 16px; display: flex; flex-direction: column; gap: 3px; overflow: auto; }',
      '.das-hover-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }',
      '.das-hover-name { font-weight: 600; font-size: var(--dsw-font-xxs-12-font-size, 12px); }',
      '.das-hover-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 2px 16px; }',
      '.das-hover-k { color: var(--das-dim); }',
      '.das-hover-v { color: var(--das-text2); overflow-wrap: anywhere; }',
      '.das-hover-hint { color: var(--das-dim); display: flex; align-items: center; min-height: 36px; }',
      '.das-management { display: flex; flex-direction: column; gap: 8px; }',
      '.das-manage-toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }',
      '.das-manage-input { flex: 1 1 260px; min-width: 180px; font: inherit; font-size: 12px; line-height: 16px; padding: 5px 8px; border: 1px solid var(--das-line); border-radius: var(--dsw-radius-sm, 6px); background: var(--das-l1); color: inherit; }',
      '.das-manage-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 6px; }',
      '.das-manage-group { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--das-line2); }',
      '.das-manage-group-head { display: flex; align-items: baseline; gap: 8px; }',
      '.das-manage-row { display: flex; align-items: flex-start; gap: 8px; padding: 7px 9px; border: 1px solid var(--das-line2); border-radius: var(--dsw-radius-sm, 6px); min-width: 0; }',
      '.das-manage-main { flex: 1 1 auto; min-width: 0; }',
      '.das-manage-name { font-family: var(--das-mono); font-size: 12px; overflow-wrap: anywhere; }',
      '.das-manage-actions { display: flex; flex-wrap: wrap; gap: 5px; justify-content: flex-end; }',
      '.das-manage-preview { white-space: pre-wrap; max-height: 140px; overflow: auto; padding: 7px 9px; border: 1px solid var(--das-line2); border-radius: 6px; font-family: var(--das-mono); font-size: 11px; color: var(--das-dim); }',
      '.das-kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; align-items: baseline; }',
      '.das-kv dt { color: var(--das-dim); font-size: var(--dsw-font-xxxs-11-font-size, 11px); white-space: nowrap; }',
      '.das-kv dd { margin: 0; font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: 18px; }',
      '.das-body { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; }',
      '.das-foot { font-size: var(--dsw-font-xxxs-11-font-size, 11px); line-height: 16px; color: var(--das-dimmer); }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .das-rise { animation: none; }',
      '  .das-btn, .das-seg-btn, .das-table tbody tr, .das-stat { transition: none; }',
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
    var OUTCOME = { ok: '已更新', updated: '已更新', unchanged: '版本未变', 'pending-check': '待确认', fail: '更新失败', failed: '更新失败', done: '已完成' };

    /* 「本轮结果」里逐项状态的措辞与色调（比 OUTCOME 更全，覆盖生成/应用/还原）。 */
    var STATE_TEXT = {
      ok: '成功', done: '已完成', updated: '已更新', unchanged: '版本未变', 'pending-check': '待确认',
      failed: '失败', fail: '失败', applied: '已应用', generated: '已生成',
      restored: '已还原', 'no-backup': '无备份', 'skipped-not-installed': '未安装',
      pending: '排队中', running: '执行中',
    };
    var STATE_TONE = {
      ok: 'ok', done: 'ok', updated: 'ok', applied: 'ok', generated: 'ok', restored: 'ok',
      unchanged: 'warn', 'pending-check': 'warn', pending: 'dim', running: 'dim',
      failed: 'err', fail: 'err', 'no-backup': 'warn', 'skipped-not-installed': 'warn',
    };
    var ACTION_TEXT = { update: '更新', generate: '生成文案', apply: '应用', revert: '还原', 'auto-apply': '自动补回' };

    function stateText(state) { return STATE_TEXT[state] || String(state === undefined || state === null ? '未知' : state); }
    function isBad(state) { return state === 'failed' || state === 'fail'; }
    function isPending(state) { return state === 'pending-check' || state === 'pending'; }

    function ManagementPanel(props) {
      var state = useState(null); var data = state[0]; var setData = state[1];
      var busyState = useState(''); var busy = busyState[0]; var setBusy = busyState[1];
      var specState = useState(''); var spec = specState[0]; var setSpec = specState[1];
      var previewState = useState(null); var preview = previewState[0]; var setPreview = previewState[1];
      var load = useCallback(function () {
        setBusy('load');
        return call('management').then(function (r) { setBusy(''); if (r && r.ok) setData(r); else props.onMessage('err', '治理快照读取失败：' + ((r && r.message) || '插件管理器不可用')); return r; });
      }, [props.onMessage]);
      useEffect(function () { load(); }, [load]);
      var action = useCallback(function (body, label) {
        setBusy(label);
        return call('manage', body).then(function (r) {
          setBusy('');
          if (!r || !r.ok) { props.onMessage('err', label + '失败：' + ((r && r.message) || '未知') + ' → ' + fixOf(r && r.code)); return r; }
          props.onMessage('ok', label + '完成' + (r.restartRequired ? '，需要重启 DSH 才会完全生效' : '')); setPreview(null); return load();
        });
      }, [load, props.onMessage]);
      var inspect = function () {
        if (spec.trim() === '') { props.onMessage('err', '请输入安装规格，例如 npm 包名、Git 地址或 tarball。'); return; }
        setBusy('inspect'); setPreview(null);
        return call('manage', { action: 'install-bundle', spec: spec.trim(), enabled: true }).then(function (r) {
          setBusy('');
          if (!r || !r.ok) { setPreview(r || { ok: false, message: '预检失败' }); props.onMessage('err', '安装未执行：' + ((r && r.message) || '预检未通过')); return r; }
          setPreview(r.inspection || r); setSpec(''); props.onMessage('ok', '安装完成，治理快照正在刷新。'); return load();
        });
      };
      if (!data) return h('section', { className: 'das-card das-management' }, h('div', { className: 'das-card-head' }, h('span', { className: 'das-card-title' }, '插件治理中心')), h('div', { className: 'das-body' }, h('span', { className: 'das-foot' }, busy ? '正在读取第一方插件管理器…' : '插件管理器不可用或尚未返回数据。')));
      var bundles = Array.isArray(data.bundles) ? data.bundles : [];
      var plugins = Array.isArray(data.plugins) ? data.plugins : [];
      var skills = Array.isArray(data.skills) ? data.skills : [];
      var managerCaps = data.capabilities || {};
      var skillAction = function (actionName, pkg, label) {
        setBusy(label);
        return call(actionName, { pkgs: [pkg] }).then(function (r) { setBusy(''); if (!r || !r.ok) props.onMessage('err', label + '失败：' + ((r && r.message) || '未知')); else { props.onMessage('ok', label + '完成'); load(); } return r; });
      };
      var pluginGroup = plugins.length ? h('div', { className: 'das-manage-group' },
        h('div', { className: 'das-manage-group-head' }, h('span', { className: 'das-card-title' }, '运行中的插件条目'), h('span', { className: 'das-foot' }, plugins.length + ' 个')),
        h('div', { className: 'das-manage-list' }, plugins.map(function (item) {
          var cap = item.capabilities || {};
          var toggle = cap.canEnable ? { action: 'enable-plugin', label: '开启' } : (cap.canDisable ? { action: 'disable-plugin', label: '停用' } : null);
          return h('div', { className: 'das-manage-row', key: item.entryId || item.moduleName },
            h('div', { className: 'das-manage-main' }, h('div', { className: 'das-manage-name' }, item.moduleName || item.entryId), h('div', { className: 'das-foot' }, item.entryId + (item.readOnlyReason ? ' · ' + item.readOnlyReason : ''))),
            h('div', { className: 'das-manage-actions' }, toggle ? h('button', { type: 'button', className: 'das-btn das-mini', disabled: busy !== '', onClick: function () { action({ action: toggle.action, entryId: item.entryId }, toggle.label + ' ' + (item.moduleName || item.entryId)); } }, toggle.label) : null));
        }))) : null;
      var skillGroup = skills.length ? h('div', { className: 'das-manage-group' },
        h('div', { className: 'das-manage-group-head' }, h('span', { className: 'das-card-title' }, '技能管理'), h('span', { className: 'das-foot' }, skills.length + ' 个')),
        h('div', { className: 'das-manage-list' }, skills.map(function (item) {
          var cap = item.capabilities || {};
          return h('div', { className: 'das-manage-row', key: item.pkg },
            h('div', { className: 'das-manage-main' }, h('div', { className: 'das-manage-name' }, item.pkg), h('div', { className: 'das-foot' }, (item.displayName || item.descriptionLang || '未知') + ' · ' + (item.source || '来源未知'))),
            h('div', { className: 'das-manage-actions' }, cap.canApply ? h('button', { type: 'button', className: 'das-btn das-mini', disabled: busy !== '', onClick: function () { skillAction('apply-skills', item.pkg, '应用 ' + item.pkg); } }, '应用翻译') : null, cap.canRollback ? h('button', { type: 'button', className: 'das-btn das-mini', disabled: busy !== '', onClick: function () { if (typeof window === 'undefined' || window.confirm('确认还原 ' + item.pkg + ' 的翻译？')) skillAction('revert-skills', item.pkg, '还原 ' + item.pkg); } }, '还原') : null));
        }))) : null;
      return h('section', { className: 'das-card das-management' },
        h('div', { className: 'das-card-head' }, h('span', { className: 'das-card-title' }, '插件治理中心'), h('span', { className: 'das-spacer' }), h('span', { className: 'das-foot' }, bundles.length + ' 个 bundle · 第一方管理器')),
        h('div', { className: 'das-body' },
          h('div', { className: 'das-manage-toolbar' },
            h('input', { className: 'das-manage-input', value: spec, onChange: function (e) { setSpec(e.target.value); }, placeholder: '安装规格：包名 / github:owner/repo / tarball', 'aria-label': '安装规格' }),
            h('button', { type: 'button', className: 'das-btn das-primary', disabled: busy !== '' || managerCaps.install !== true || managerCaps.inspect !== true, onClick: inspect, title: '先执行第一方 inspect 预检，只有通过后才安装' }, busy === 'inspect' ? '预检并安装中…' : '预检并安装'),
            h('button', { type: 'button', className: 'das-btn das-mini', disabled: busy !== '', onClick: load, title: '重新读取 bundle、启停和可卸载能力' }, busy === 'load' ? '刷新中…' : '刷新治理状态')),
          preview ? h('div', { className: 'das-manage-preview', role: 'status' }, JSON.stringify(preview, null, 2)) : null,
          h('div', { className: 'das-manage-list' }, bundles.map(function (item) {
            var cap = item.capabilities || {};
            var toggle = cap.canEnable ? { action: 'enable-bundle', label: '开启' } : (cap.canDisable ? { action: 'disable-bundle', label: '停用' } : null);
            var blocked = cap.blockedReason === 'incompatible-version' ? ' · 版本不兼容，暂不可开启' : '';
            return h('div', { className: 'das-manage-row', key: item.name },
              h('div', { className: 'das-manage-main' }, h('div', { className: 'das-manage-name' }, item.name), h('div', { className: 'das-foot' }, (item.version ? 'v' + item.version + ' · ' : '') + (item.installed ? (item.enabled ? '已启用' : '已停用') : '未安装') + (item.readOnlyReason ? ' · ' + item.readOnlyReason : '') + blocked)),
              h('div', { className: 'das-manage-actions' }, toggle ? h('button', { type: 'button', className: 'das-btn das-mini', disabled: busy !== '', onClick: function () { action({ action: toggle.action, name: item.name }, toggle.label + ' ' + item.name); } }, toggle.label) : null,
                cap.canUninstall ? h('button', { type: 'button', className: 'das-btn das-mini', disabled: busy !== '', onClick: function () { if (typeof window === 'undefined' || window.confirm('确认卸载 ' + item.name + '？这会从当前 profile 移除依赖。')) action({ action: 'remove-bundle', name: item.name }, '卸载 ' + item.name); } }, '卸载') : null));
          })),
          pluginGroup,
          skillGroup,
          h('div', { className: 'das-foot' }, '启停、安装和卸载均由 DSH 第一方 pluginManager 执行；内置或受保护 bundle 不显示危险操作。')));
    }

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
     * @param title - 供 aria-label 使用的完整说明；不再生成原生 title 浮层，避免遮挡行详情
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
        'aria-label': title === undefined || title === null ? label : title,
        style: off ? S.off : undefined,
        onClick: off ? undefined : onClick,
      }, label);
    }

    function chip(key, text, tone, title, mono) {
      return h('span', {
        key: key,
        className: 'das-chip' + (tone ? ' is-' + tone : '') + (mono === true ? ' is-mono' : ''),
        title: title === undefined || title === null ? undefined : title,
      }, h('span', { className: 'das-chip-t' }, text));
    }

    /**
     * 可点的 chip。状态列的「需处置 N / 附带观察 N」自己就是展开入口：
     * 少一个按钮，操作列就少一份宽度争夺，行高也不会被按钮换行顶起来。
     * 原生 title 一律不生成（会盖住行详情卡），说明走 aria-label。
     */
    function chipBtn(key, text, tone, title, onClick, expanded) {
      return h('button', {
        key: key,
        type: 'button',
        className: 'das-chip das-chip-btn' + (tone ? ' is-' + tone : ''),
        'aria-label': title === undefined || title === null ? text : title,
        'aria-expanded': expanded === true,
        onClick: onClick,
      }, h('span', { className: 'das-chip-t' }, text));
    }

    /** 指标带里的一项：一行文本（数字 + 标签）。有 onClick 就是按钮（例如审查筛选）。 */
    function kpiStat(key, n, label, title, tone, onClick) {
      var kids = [
        h('span', { key: 'n', className: 'das-stat-n' }, String(n)),
        h('span', { key: 'l', className: 'das-stat-l' }, label),
      ];
      var cls = 'das-stat' + (tone ? ' is-' + tone : '');
      return onClick === undefined
        ? h('span', { key: key, className: cls, title: title }, kids)
        : h('button', { key: key, type: 'button', className: cls, title: title, onClick: onClick }, kids);
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

    /**
     * 从「包名（中文名）」里取出中文名 —— 本插件的主功能就是让英文插件可读，
     * 而宿主给的 displayName 形态是「原包名（中文名）」（命名约定刻意保留原名）。
     * 列表里如果原样整串渲染，等于把包名打印两遍、把中文埋在括号里；
     * 所以这里拆开：中文名做主标题，原包名退成次级小字。
     * 取不到就返回 ''（调用方回落到 displayName / pkg，不编造）。
     */
    function zhNameOf(displayName, pkg) {
      var t = String(displayName === undefined || displayName === null ? '' : displayName).trim();
      if (t === '' || t === pkg) return '';
      var m = /[（(]\s*([^（()）]{1,30}?)\s*[)）]\s*$/.exec(t);
      if (m !== null && m[1] !== '') return m[1];
      // 没有括号形态：只要它不以包名开头，就把它本身当中文名
      if (t.indexOf(String(pkg)) !== 0) return t;
      return '';
    }

    /**
     * 把悬停详情卡摆在被悬停行的旁边（仿本机 dsh-annotation 的浮层定位）：
     * 优先放行的下方；下方放不下就放上方；两边都不够就把 top 钳进视口，并给出 maxHeight
     * 让卡片内部滚动 —— 结果是「无论行在上还是在下，都不用滚动就能看到详情」。
     * 视口尺寸在 Node 侧（冒烟）取不到时回落到 1024x768，保证定位逻辑可被确定性测试。
     */
    function placeCard(rect, estH, cardW) {
      var vw = (typeof window !== 'undefined' && window.innerWidth) || 1024;
      var vh = (typeof window !== 'undefined' && window.innerHeight) || 768;
      var gap = 8, m = 8;
      var left = Math.max(m, Math.min(rect.left, vw - cardW - m));
      var below = rect.bottom + gap;
      var top;
      if (below + estH <= vh - m) top = below;
      else if (rect.top - estH - gap >= m) top = rect.top - estH - gap;
      else top = Math.max(m, Math.min(below, vh - Math.min(estH, vh - 2 * m) - m));
      top = Math.max(m, Math.min(top, Math.max(m, vh - m - 120)));
      return { left: left, top: top, maxHeight: Math.max(120, vh - top - m) };
    }

      /** 从鼠标事件取被悬停行的位置，算出卡片该摆在哪（取不到 DOM 时给安全的兜底位置）。 */
      function boxFromEvent(event) {
        var el = event && event.currentTarget;
        var rect = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
        if (!rect || (rect.width === 0 && rect.height === 0)) return { left: 12, top: 64, maxHeight: 480 };
        return placeCard(rect, 260, 420);
      }

    /**
     * 内置 catalog 的中文快照查询（只含仓库内置条目）。
     * 用途：宿主 <2.9 的插件行**不发** displayName/localizedDescription（2.8.0 的 index.js 里
     * displayName 只出现在技能行），于是「已优化」的行不显示任何中文 —— 用户会以为功能没生效。
     * 客户端半体是热更新的，所以用这份快照兜底。用户覆盖层（LLM 生成）不在快照里，
     * 命中不了就如实说明，绝不编造。
     */
    function catalogZh(pkg) {
      var hit = CATALOG_ZH[pkg];
      if (!hit) return null;
      return { name: zhNameOf(hit[0], pkg), desc: hit[1] || '' };
    }

    /** 技能来源里的根目录压短成 .dsh/skills、.agents/skills，省掉整条 Windows 路径。 */
    function shortRoot(source) {
      return String(source === undefined || source === null ? '' : source).replace(/[A-Za-z]:\\[^·]*[\\/](\.dsh|\.agents)[\\/]skills/, '$1/skills');
    }

    function summarize(rows, isSkill) {
      var total = rows.length;
      /* 技能侧：随 DSH 提供的技能在 app.asar 里，没有可写路径 —— 只入表并标注来源，
         不计入「待应用 / 待生成」，否则那几项永远是待办、还会在优化时去写写不了的文件。 */
      // 只有有可写路径的对象才进入翻译优化统计；内置/只读对象仍保留在总表中。
      var active = rows.filter(function (r) {
        return r.translationEligible !== false && (isSkill !== true || r.bundled !== true);
      });
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
      /* 悬停展开：行内只留一行主要信息，完整信息进下方固定槽位。
         有意不挂 onMouseLeave —— 鼠标往槽位移动时不该把内容清掉（清了就来不及读）。
         槽位优先显示「点展开钉住」的那一行，否则显示最近悬停的一行。 */
      var hoverState = useState(''); var hoverPkg = hoverState[0]; var setHoverPkg = hoverState[1];
      /* 悬停卡的位置（固定定位，锚在被悬停行旁）；null 时用下面那块兜底位置 */
      var hoverBoxState = useState(null); var hoverBox = hoverBoxState[0]; var setHoverBox = hoverBoxState[1];
      /* 随 DSH 提供的对象默认隐藏（用户要求）；给出数量并可一键显示 */
      var bundledState = useState(false); var showBundled = bundledState[0]; var setShowBundled = bundledState[1];
      /* 上次翻译优化的落盘记录（宿主 /updates 的 translate 字段带回）。
         存在的理由：翻译产物写在 node_modules 里，装包会洗掉；没有记录时，用户看到
         「待生成文案」完全不知道「我明明点过翻译优化」。 */
      var translateState = useState(null); var translate = translateState[0]; var setTranslate = translateState[1];
      /* 本次挂载是否已做过自愈（避免「空列表 → 补应用 → 空列表」来回打转） */
      var healedState = useState(false); var healed = healedState[0]; var setHealed = healedState[1];

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
              versionUnchanged: it.versionUnchanged === true,
            };
          }
          return Object.keys(map).sort().map(function (k) { return map[k]; });
        });
      }, []);

      /**
       * 把一次翻译运行的结果上报宿主落盘，并即时更新本页记录。
       * 这样下一次刷新页面（甚至换一次会话）都能看到「上次翻译优化是什么时候、成了几项、哪项为什么失败」。
       */
      var recordTranslate = useCallback(function (action, items, message) {
        var list = (Array.isArray(items) ? items : []).filter(function (it) { return it && typeof it.pkg === 'string' && it.pkg !== ''; });
        if (list.length === 0) return Promise.resolve(null);
        return call('translate-run', { action: action, items: list, message: message || '', scope: IS_SKILL ? 'skill' : 'plugin' }).then(function (r) {
          if (r && r.ok && r.value) setTranslate(r.value);
          return r;
        });
      }, []);

      /**
       * 自愈：catalog 里有条目、但文件不在盘上（`inCatalog && !localized`）→ 自动补一次 apply。
       *
       * 为什么需要：产物写在 node_modules 里，任何 pnpm install / 重新钉版都可能把它洗掉，
       * 而「补回来」原本只发生在插件图重组合时。用户看到的就只是一个没有来历的「待应用」。
       * 只对插件页做（技能侧 apply 会改写 SKILL.md，属于行为变更，绝不能由「打开页面」触发）；
       * 每次挂载只做一次，且结果同样留痕。
       */
      useEffect(function () {
        if (IS_SKILL || healed || rows === null) return;
        var cand = rows.filter(function (r) { return r.inCatalog === true && r.localized !== true; }).map(function (r) { return r.pkg; });
        if (cand.length === 0) return;
        setHealed(true);
        call('apply', { pkgs: cand }).then(absorb).then(function (r) {
          if (!r || !r.ok) return;
          var items = Array.isArray(r.value) ? r.value : [];
          var applied = items.filter(function (x) { return x.state === 'applied'; }).length;
          /* 只进「上次翻译优化」记录，**不进**「本轮结果」：
             后者是「你刚做了什么」的日志，自愈不是你点的；也不要抢状态提示的文案。
             自愈的可见性由指标带的「上次优化」+ 悬停槽承担。 */
          recordTranslate('auto-apply', items, '打开设置页时自动补回 ' + applied + ' 项（产物曾不在盘上）');
          if (applied > 0) return snapshot({ force: true });
        });
      }, [rows, healed, absorb, absorbResults, recordTranslate, snapshot, IS_SKILL]);

      // 唯一的数据入口：完整快照（状态 + 已装版本 + 最新版本 + 问题）
      var snapshot = useCallback(function (opts) {
        return call(IS_SKILL ? 'skills' : 'updates', opts || {}).then(absorb).then(function (r) {
          if (r && r.ok && Array.isArray(r.value)) { setRows(r.value); if (r.audit) setAudit(r.audit); if ('translate' in r) setTranslate(r.translate || null); return r.value; }
          var why = (r && r.message) || '未知';
          /* 原始原因必须留着（可诊断），但注入类错误还要给出下一步，否则用户只看到一句英文。
             同时按报文兜底识别：**运行中的旧宿主**没有 H3 的 code，只认识那句英文原文。 */
          if (r && (r.code === 'host-inject' || /without inject/.test(String((r && r.message) || '')))) why = why + '　' + fixOf('host-inject');
          /* sticky：读取失败必须活到下一次成功读取。挂载期的「批量历史恢复」也会 setNote，
             会把它顶掉、整页只剩空表（冒烟测试已复现），所以它不能被普通提示覆盖。 */
          setNote({ kind: 'err', text: '读取失败：' + why, sticky: true });
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
            n[b.items[i].pkg] = { state: b.items[i].state, message: b.items[i].message, versionUnchanged: b.items[i].versionUnchanged === true };
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
          setNote(function (prev) {
            /* 但不覆盖 sticky 的读取失败提示：这条恢复提示紧随 snapshot() 之后执行，
               否则用户看到的是一张空表 + 「上次批量执行」，真正的原因彻底消失。 */
            if (prev && prev.sticky === true) return prev
            return {
              kind: finished ? (/失败 [1-9]/.test(String(b.message)) ? 'err' : (/未变化 [1-9]/.test(String(b.message)) ? 'note' : 'ok')) : 'err',
              text: finished
                ? ('上次批量执行（' + agoText(b.finishedAt) + '）：' + String(b.message) +
                  (fresh ? '；下表已按该结果锁定，点「刷新状态」可重新判定。'
                    : '；该记录已超出锁定保鲜期，不再约束下表 —— 下表按当前快照判定，仍可能显示「更新」。'))
                : ('上次批量更新未跑完（' + String(b.message) + '）：' + b.items.length + ' 项里只有中断前完成的那些有结果，'
                  + '它不锁定下表 —— 请点「刷新状态」让宿主重新判定后重试。'),
            }
          });
        });
      }, [absorb, absorbResults, pollBatch, snapshot]);

      var refresh = useCallback(function () {
        setBusy('refresh');
        // 对待确认任务先查宿主任务本身，再刷新版本快照；否则「刷新状态」只刷新表格，
        // 旧 token 仍在后台，用户下一次点击会再次发起安装。
        var pending = Object.keys(done).map(function (pkg) { return { pkg: pkg, record: done[pkg] }; }).filter(function (x) {
          return x.record && x.record.token && (x.record.state === 'pending-check' || x.record.state === 'awaiting-confirmation');
        });
        var lockCount = Object.keys(done).length;
        var statusChecks = pending.length === 0 ? Promise.resolve([]) : Promise.all(pending.map(function (x) {
          return call('update-status', { token: x.record.token }).then(absorb).then(function (r) { return { pkg: x.pkg, response: r }; });
        }));
        return statusChecks.then(function (checks) {
          var carry = {};
          checks.forEach(function (entry) {
            var r = entry.response;
            var job = r && r.ok ? r.job : null;
            if (job && job.done !== true) carry[entry.pkg] = { state: 'pending-check', message: job.message || '仍在等待宿主确认', token: entry.response && entry.response.job ? entry.response.job.token : pending.filter(function (x) { return x.pkg === entry.pkg; })[0].record.token };
            if (job && job.done === true) absorbResults('update', [{ pkg: entry.pkg, state: job.state || (job.ok ? 'updated' : 'failed'), code: job.code, message: job.message, from: job.from, to: job.to, versionUnchanged: job.versionUnchanged === true }]);
          });
          setDone(carry);
          setBatchSettled(Object.keys(carry).length > 0);
          setLockedAt(Object.keys(carry).length > 0 ? Date.now() : 0);
          setNote({ kind: 'note', text: pending.length > 0 ? '已核对 ' + pending.length + ' 个待确认安装，正在刷新状态…' : '正在刷新（状态 + 版本 + 更新检查）…' });
          return snapshot({ force: true }).then(function (v) {
            setBusy('');
            if (v) {
              var s = summarize(v, IS_SKILL);
              setNote({ kind: s.upd || s.pending || Object.keys(carry).length > 0 ? 'note' : 'ok',
                text: '刷新完成：' + s.total + ' 个对象；已优化 ' + s.refined + '，可更新 ' + s.upd + (s.toApply + s.pending ? '，翻译待处理 ' + (s.toApply + s.pending) : '') + (s.unk ? '，版本待确认 ' + s.unk : '') +
                  (Object.keys(carry).length > 0 ? '；仍有 ' + Object.keys(carry).length + ' 个安装待确认，请稍后再次刷新。' : (lockCount > 0 ? '；已释放上一轮的 ' + lockCount + ' 个行锁，下表按最新快照重新判定。' : '')) });
            }
          });
        }).catch(function (error) {
          setBusy('');
          setNote({ kind: 'err', text: '刷新状态失败：' + String((error && error.message) || error) + ' → 请稍后重试。' });
        });
      }, [absorb, absorbResults, done, snapshot]);

      // 单项文案优化：行内「待生成文案」直接触发，生成成功后只应用当前插件。
      var optimizeOne = useCallback(function (row) {
        if (!row || !row.pkg || row.translationEligible === false || row.bundled === true) return;
        var pkg = row.pkg;
        setBusy('optimize:' + pkg);
        setNote({ kind: 'note', text: '正在为 ' + pkg + ' 生成文案…（调用模型，消耗 token）' });
        var endpoint = IS_SKILL ? 'generate-skill' : 'generate';
        var applyEndpoint = IS_SKILL ? 'apply-skills' : 'apply';
        return call(endpoint, { pkg: pkg }).then(absorb).then(function (g) {
          if (!g || !g.ok) {
            var reason = (g && (g.reason || g.message)) || '宿主没有返回失败原因';
            var code = g && g.code ? ' [' + g.code + ']' : '';
            absorbResults('generate', [{ pkg: pkg, state: 'failed', code: g && g.code, message: reason }]);
            setBusy('');
            setNote({ kind: 'err', text: pkg + ' 文案生成失败' + code + '：' + reason + '。' + fixOf(g && g.code) });
            return g;
          }
          absorbResults('generate', [{ pkg: pkg, state: 'generated', message: '已生成，准备应用' }]);
          return call(applyEndpoint, { pkgs: [pkg] }).then(absorb).then(function (ap) {
            var items = ap && Array.isArray(ap.value) ? ap.value : [];
            absorbResults('apply', items);
            return snapshot({ force: true }).then(function () {
              setBusy('');
              var applied = items.filter(function (x) { return x.state === 'applied'; }).length;
              if (!ap || !ap.ok || applied === 0) {
                var msg = (ap && (ap.nextAction || ap.message)) || (items[0] && items[0].message) || '应用阶段没有写入结果';
                setNote({ kind: 'err', text: pkg + ' 文案已生成，但应用失败：' + msg + '。请展开本行查看详情。' });
                return ap;
              }
              setNote({ kind: 'ok', text: pkg + ' 文案优化完成：已生成并应用 1 项。' });
              return ap;
            });
          });
        }).catch(function (error) {
          var reason = String((error && error.message) || error);
          setBusy('');
          setNote({ kind: 'err', text: pkg + ' 文案优化失败：' + reason + '。请重试；若重复失败请检查模型配置。' });
          return { ok: false, code: 'network', message: reason, reason: reason };
        });
      }, [IS_SKILL, absorb, absorbResults, snapshot]);

      // 翻译优化：生成缺失文案（内置能力）→ 应用全部精炼 → 重新取快照
      var optimize = useCallback(function () {
        setBusy('optimize');
        setNote({ kind: 'note', text: '正在读取状态…' });
        if (IS_SKILL) {
          return snapshot().then(function (cur) {
            if (!cur) { setBusy(''); return; }
            var pend = cur.filter(function (r) { return r.translationEligible !== false && r.needsText === true; });
            // 随 DSH 提供的技能在 app.asar 内，没有可写路径：跳过，不算失败
            var toApplyS = cur.filter(function (r) { return r.translationEligible !== false && r.localized !== true; });
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
                    if (!ap || !ap.ok) { setNote({ kind: 'err', text: (ap && ap.partial ? '部分应用完成：' : '应用失败：') + ((ap && (ap.message || ap.nextAction)) || '请展开对应行查看失败原因并重试') }); return; }
                    var ss = v ? summarize(v, true) : null;
                    setNote({ kind: gFail.length ? 'err' : 'ok',
                      text: '翻译优化（技能）：生成 ' + gOk + '/' + pend.length + ' · 应用 ' + applied + ' 项 · 跳过 ' + (cur.length - toApplyS.length) + ' 个（已优化或随 DSH 提供）' +
                        (ss ? '；当前已优化 ' + ss.refined + '/' + ss.total : '') +
                        (gFail.length ? ' · 生成失败：' + compactFailures(gFail) + '；详情见对应行' : '') });
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
                  var why = (g && (g.reason || g.message)) || '宿主没有返回失败原因';
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
          var pending = cur.filter(function (r) { return r.translationEligible !== false && r.needsText === true; });
          var toApply = cur.filter(function (r) { return r.translationEligible !== false && r.localized !== true; });
          var skipped = cur.length - toApply.length;
          if (toApply.length === 0) {
            setBusy('');
            setNote({ kind: 'ok', text: '全部 ' + cur.length + ' 个插件均已优化，无需处理。' });
            return;
          }
          var genOk = 0;
          var genFail = [];
          /* 本次运行的逐项结果（生成阶段）：最后与 apply 结果按包名合并，交给宿主落盘留痕。 */
          var runItems = [];
          var i = 0;
          var stepGen = function () {
            if (i >= pending.length) {
              setNote({ kind: 'note', text: '文案就绪，正在应用（' + toApply.length + ' 个，跳过已优化 ' + skipped + ' 个）…' });
              // 只对这些包应用，已优化的一律不碰
              return call('apply', { pkgs: toApply.map(function (r) { return r.pkg; }) }).then(absorb).then(function (ap) {
                var items = ap && Array.isArray(ap.value) ? ap.value : [];
                var applied = items.filter(function (x) { return x.state === 'applied'; }).length;
                absorbResults('apply', items);
                /* 留痕：**生成与应用各留一条**，绝不按包名覆盖。
                   上一版按包名合并（apply 为准），于是「模型生成失败的真实原因」被
                   apply 的「已安装但缺少精炼文案」顶掉，用户只看到一句无从追查的结论（线上实测发生过）。 */
                var applyFailed = items.filter(function (x) { return x.state === 'failed'; }).length;
                var needsCatalog = items.filter(function (x) { return x.state === 'needs-catalog'; }).length;
                recordTranslate('optimize', runItems.concat(items),
                  '新生成 ' + genOk + ' 条，应用 ' + applied + ' 项' +
                  (needsCatalog ? '，待补文案 ' + needsCatalog + ' 个' : '') +
                  '，失败 ' + (genFail.length + applyFailed) + ' 个');
                return snapshot({ force: true }).then(function (v) {
                  setBusy('');
                  if (!ap || !ap.ok) { setNote({ kind: 'err', text: (ap && ap.partial ? '部分应用完成：' : '应用失败：') + ((ap && (ap.message || ap.nextAction)) || '请展开对应行查看失败原因并重试') }); return; }
                  var s = v ? summarize(v) : null;
                  var stillMissing = v ? v.filter(function (r) { return r.translationEligible !== false && r.needsText === true; }).length : 0;
                  setNote({ kind: genFail.length ? 'err' : 'ok',
                    text: '翻译优化完成：新生成 ' + genOk + '/' + pending.length + ' 条文案，应用 ' + applied + ' 项，跳过已优化 ' + skipped + ' 个' +
                      (s ? '；当前已优化 ' + s.refined + '/' + s.total : '') +
                      (genFail.length ? ' · 生成失败：' + compactFailures(genFail) : '') +
                      (stillMissing ? ' · 仍有 ' + stillMissing + ' 个包缺文案，再点一次「翻译优化」只会重试它们' : '') });
                });
              });
            }
            var pkg = pending[i].pkg;
            i += 1;
            setNote({ kind: 'note', text: '生成文案 ' + i + '/' + pending.length + '：' + pkg + ' …（调用模型，消耗 token）' });
            return call('generate', { pkg: pkg }).then(absorb).then(function (g) {
              var item = (g && g.ok)
                ? { pkg: pkg, state: 'generated', message: (g.entry && g.entry.zh && g.entry.zh.description) || '已写入覆盖层' }
                : { pkg: pkg, state: 'failed', code: (g && g.code), message: (g && (g.reason || g.message)) || '宿主没有返回失败原因' };
              if (g && g.ok) genOk += 1; else genFail.push(pkg + '（' + item.message + '）');
              runItems.push(item);
              absorbResults('generate', [item]);
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
                    resolve({
                      ok: job.state === 'updated' || (job.ok === true && job.state !== 'unchanged' && job.state !== 'pending-check'),
                      state: job.state || (job.ok === true ? 'updated' : 'failed'),
                      pkg: pkg,
                      code: job.code || (job.state === 'unchanged' ? 'unchanged' : (job.state === 'pending-check' ? 'pending-check' : (job.ok ? null : 'update-failed'))),
                      message: job.message,
                      from: job.from,
                      to: job.to,
                      versionUnchanged: job.versionUnchanged === true,
                      application: job.application,
                    });
                    return;
                  }
                }
                if (n < POLL_MAX) setTimeout(tick, POLL_MS);
                else { setJobs(function (prev) { var x = Object.assign({}, prev); delete x[pkg]; return x; }); resolve({ ok: false, pkg: pkg, state: 'pending-check', code: 'pending-check', message: '安装请求已提交，但宿主等待超时；请稍后刷新状态确认。', pending: true }); }
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
                (nFail > 0 ? '（每项失败原因见对应行的悬停详情）' : '') });
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
          setDone(function (prev) { var n = Object.assign({}, prev); n[pkg] = { state: res.state || (res.ok ? 'updated' : 'failed'), message: res.message, versionUnchanged: res.versionUnchanged === true }; return n; });
          setBatchSettled(true);
          setLockedAt(Date.now());
          return snapshot({ force: true }).then(function () {
            absorbResults('update', [{ pkg: pkg, state: res.state || (res.ok ? 'updated' : 'failed'), code: res.code, message: res.message, from: res.from, to: res.to, versionUnchanged: res.versionUnchanged === true }]);
            if (res.state === 'pending-check') setNote({ kind: 'note', text: pkg + ' 安装请求已提交，暂时无法确认结果。' + fixOf(res.code) });
            else if (res.state === 'unchanged') setNote({ kind: 'note', text: pkg + ' 安装请求已执行，但版本未变化。' + fixOf(res.code) });
            else if (res.versionUnchanged === true) setNote({ kind: 'ok', text: pkg + ' 已重新安装；版本字段未变化，重启 DSH 后确认运行状态。' });
            else if (res.ok) setNote({ kind: 'ok', text: pkg + ' 已更新，状态已刷新。' });
            else setNote({ kind: 'err', text: pkg + ' 更新失败：' + res.message + ' → ' + fixOf(res.code) });
          });
        });
      }, [absorbResults, snapshot, updateOne, updateSkills]);

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

      /* 审查卡的动作必须真正落到宿主：更新/翻译会启动真实操作，人工项返回证据和目标。
         处理后重新取快照，避免按钮仍显示旧状态。 */
      var findingAction = useCallback(function (finding, action) {
        var key = 'finding:' + finding.id;
        setBusy(key);
        setNote({ kind: 'note', text: '正在处置：' + (finding.title || finding.id) + ' …' });
        return call('finding-action', { id: finding.id, action: action }).then(absorb).then(function (r) {
          setBusy('');
          if (!r || !r.ok) { setNote({ kind: 'err', text: '处置失败：' + ((r && r.message) || '未知') + ' → ' + fixOf(r && r.code) }); return; }
          var msg = r.message || (action === 'manual' || action === 'open-repo' ? '已给出人工处置目标，请按建议处理。' : '已提交处置，正在刷新结果。');
          setNote({ kind: action === 'manual' || action === 'open-repo' ? 'note' : 'ok', text: msg });
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
      /* 长解释进 title（用户反馈这条提示太占地方）；可见的只留一行短句。
         注意 regression 钉住 '宿主半体版本过旧' / '请重启 DSH。' / '请刷新页面。' 必须在源码里存续。 */
      var revExplain = revGap
        ? '客户端半体 v' + CLIENT_REV + ' 与运行中的宿主半体 v' + hostRev + ' 不一致：' +
          (compareRev(hostRev, CLIENT_REV) < 0
            ? '宿主半体是旧的 —— 它只在 DSH 进程启动时加载一次，因此可能缺少本页需要的接口（例如 /skills）。请重启 DSH。'
            : '客户端半体是旧的（页面来自缓存）。请刷新页面。')
        : '宿主半体版本过旧：运行中的是进程启动时加载的代码，因此缺少新接口。请重启 DSH 后重试。';
      var staleEl = (stale || revGap)
        ? h('div', { className: 'das-note is-err', title: revExplain },
            chip('sg', '版本不一致', 'err'),
            h('span', { className: 'das-note-text' }, revGap
              ? (compareRev(hostRev, CLIENT_REV) < 0
                ? '宿主半体 v' + hostRev + ' 落后于客户端 v' + CLIENT_REV + ' · 重启 DSH 后才能看到插件的中文名与说明'
                : '客户端半体 v' + CLIENT_REV + ' 落后于宿主 v' + hostRev + ' · 刷新页面生效')
              : '宿主半体版本过旧 · 重启 DSH 后重试'))
        : null;

      /* 当前结果摘要优先于旧的批量提示。旧记录仍放进 resultHint 的 title，
         保留可追溯性，但不再把「上次批量失败」和「本轮失败」并排渲染成两张红卡。 */
      /* sticky 提示（读取失败）不参与「折叠旧批量提示」的规则：它是当前事实，必须一直可见。 */
      var noteEl = note && !(note.sticky !== true && typeof note.text === 'string' && (/^上次批量执行|^上次批量更新未跑完/.test(note.text)) && (results.length > 0 || (batch && Array.isArray(batch.items) && batch.items.length > 0)))
        ? h('div', { className: 'das-note' + (note.kind === 'err' ? ' is-err' : (note.kind === 'ok' ? ' is-ok' : '')) },
            chip('nk', note.kind === 'err' ? '失败' : (note.kind === 'ok' ? '完成' : '进行中'), note.kind === 'err' ? 'err' : (note.kind === 'ok' ? 'ok' : 'info')),
            h('span', { className: 'das-note-text' }, note.text))
        : null;

      /* 智能摘要：只保留用户需要决策的四类信息；原始细项进入 title 与详情，不再堆满首屏。 */
      var kpiCells = [];
      var bundledList = (rows || []).filter(function (r) { return r.bundled === true; });
      var factCount = 0;
      var notableInferred = 0;
      var lowInferred = 0;
      (rows || []).forEach(function (r) {
        (r.findings || []).forEach(function (f) {
          if (f.confidence === 'fact') factCount += 1;
          else if (f.severity === 'low') lowInferred += 1;
          else notableInferred += 1;
        });
      });
      var actionable = factCount + notableInferred;
      var failedResults = results.filter(function (item) { return isBad(item.state); }).length;
      var pendingResults = results.filter(function (item) { return isPending(item.state); }).length;
      var changedResults = results.filter(function (item) { return item.state === 'updated' || item.state === 'applied' || item.state === 'generated' || item.state === 'restored'; }).length;
      /* 结果摘要本身已经承载本轮失败/待确认的数量与下一步；否则同一失败会同时出现在
         顶部 guidance、note 和表格 meta 三处，形成「失败提示三连」。 */
      /* 宿主恢复批量记录与本地 results 是异步的；用两者的并集去重，避免首帧又冒出第二张失败卡。 */
      var hasBatchResult = batch && Array.isArray(batch.items) && batch.items.length > 0;
      var hasCurrentResultSummary = results.length > 0 || hasBatchResult;
      var batchNote = note && typeof note.text === 'string' && (/^上次批量执行|^上次批量更新未跑完/.test(note.text));
      var guidance = [];
      if (revGap) guidance.push({ tone: 'err', title: '运行代码未同步', evidence: '客户端 v' + CLIENT_REV + '，宿主 v' + hostRev, impact: '更新和中文显示可能继续使用旧接口。', action: compareRev(hostRev, CLIENT_REV) < 0 ? '重启 DSH 后再刷新状态' : '刷新页面后再操作' });
      /* pending / failed 已由 resultHint 统一显示；审查问题和代码版本问题仍独立保留。 */
      if (!hasCurrentResultSummary && pendingResults > 0) guidance.push({ tone: 'warn', title: '有 ' + pendingResults + ' 项更新待确认', evidence: '宿主已收到安装请求，但等待结果超时。', impact: '重复点击可能并发安装。', action: '先刷新状态，不要重复点击更新' });
      if (actionable > 0) guidance.push({ tone: 'err', title: '有 ' + actionable + ' 条需要处置的审查发现', evidence: '事实级 ' + factCount + ' 条；中高严重度推断 ' + notableInferred + ' 条。', impact: '可能影响兼容性或安全更新。', action: '展开对应行，按证据和建议停用、升级或等待兼容版本' });
      if (!hasCurrentResultSummary && failedResults > 0) guidance.push({ tone: 'err', title: '本轮有 ' + failedResults + ' 项未完成', evidence: '结果已记录，未把失败包装成成功。', impact: '当前版本可能没有变化。', action: '先看行内失败原因，按建议刷新或重试' });
      /* 有动作结果时不再补一条「当前没有问题」绿提示，避免和结果摘要互相打架。 */
      if (guidance.length === 0 && !hasCurrentResultSummary && !batchNote) guidance.push({ tone: 'ok', title: '当前没有需要处置的安全或冲突问题', evidence: '审查结果中没有事实级或中高严重度发现。', impact: '可以继续使用当前插件。', action: '按需刷新状态，或执行翻译优化' });
      var guidanceEl = guidance.length > 0 ? h('div', { className: 'das-guidance', role: 'status' }, guidance.slice(0, 3).map(function (g, i) {
        return h('div', { key: 'g' + i, className: 'das-guidance-item is-' + g.tone },
          chip('gt' + i, g.title, g.tone),
          h('span', { className: 'das-guidance-copy' }, g.evidence + ' · ' + g.impact),
          h('span', { className: 'das-guidance-action' }, '建议：' + g.action));
      })) : null;
      if (s) {
        var pendingTranslation = s.toApply + s.pending;
        var updateLabel = s.upd + (pendingResults ? ' 可更新 · ' + pendingResults + ' 待确认' : ' 可更新');
        kpiCells.push(kpiStat('k1', s.total, IS_SKILL ? '对象' : '插件', '本次快照里的条目总数；旧口径：' + (IS_SKILL ? '技能' : '插件')));
        kpiCells.push(kpiStat('k2', s.refined, '已中文化', '已优化 ' + s.refined + '；待应用 ' + s.toApply + '；待生成文案 ' + s.pending, s.refined > 0 ? 'ok' : null));
        kpiCells.push(kpiStat('k5', updateLabel, '更新状态', IS_SKILL ? '远端比本地新的技能；本轮待确认项单独显示' : 'npm 上比已装版本新的插件；本轮待确认项单独显示', (s.upd > 0 || pendingResults > 0) ? 'warn' : 'dim'));
        kpiCells.push(kpiStat('k11', actionable, actionable > 0 ? '需处置' : '无需处置',
          '事实级 ' + factCount + ' 条；中高严重度推断 ' + notableInferred + ' 条；低置信观察 ' + lowInferred + ' 条仅供知悉', actionable > 0 ? 'err' : 'ok', actionable > 0 ? function () { setOnlyFlagged(!onlyFlagged); } : undefined));
        if (IS_SKILL) {
          kpiCells.push(kpiStat('k7', s.noRepo, '本地目录', '不是 git 仓库，没有远端可比', s.noRepo > 0 ? 'dim' : null));
          kpiCells.push(kpiStat('k9', s.dirty, '有本地改动', 'git 工作区有未提交修改；快进会被 git 拒绝', s.dirty > 0 ? 'warn' : null));
          kpiCells.push(kpiStat('k10', s.english, '描述为英文', '中文可读性较低；改写 description 属行为变更', s.english > 0 ? 'warn' : null));
        }
        if (bundledList.length > 0) {
          kpiCells.push(kpiStat('k8', bundledList.length, '随 DSH' + (showBundled ? '· 收起' : '· 展开'), '内置对象不参与翻译优化和远端版本比较；点击切换显示', 'dim', function () { setShowBundled(!showBundled); }));
        }
      }
      var kpiEl = kpiCells.length > 0 ? h('div', { className: 'das-stats', role: 'group' }, kpiCells) : null;

      /* 「本轮结果」不再单独占一张表（用户报的那张灰表 + 动作列竖排就是它）：
         批量进度压成一条状态提示，逐项结果贴回对应对象行；口径原文进提示的 title，
         悬停即可读到，不再吃版面。 */
      var resultHint = null;
      var lockExplain = lockNote(batch, locked, lockedCount, IS_SKILL, lockReason, lockedAt);
      if (batch && batch.running === true) {
        resultHint = h('div', { className: 'das-note', role: 'status', title: lockExplain }, chip('rh', '执行中', 'info'), h('span', { className: 'das-note-text' },
          (IS_SKILL ? '技能更新' : '插件更新') + ' ' + (Number(batch.index || 0) + 1) + '/' + Number(batch.total || 0) + ' · 下表实时合并结果'));
      } else if (results.length > 0 || (batch && Array.isArray(batch.items) && batch.items.length > 0)) {
        /* 首帧可能还没有把宿主记录吸收到 results；中断批量仍必须有唯一结果摘要。 */
        var resultItems = results.length > 0 ? results : ((batch && Array.isArray(batch.items)) ? batch.items : []);
        var failedResults = resultItems.filter(function (item) { return isBad(item.state); }).length;
        var pendingResults = resultItems.filter(function (item) { return isPending(item.state); }).length;
        var changedResults = resultItems.filter(function (item) { return item.state === 'updated' || item.state === 'applied' || item.state === 'generated' || item.state === 'restored'; }).length;
        var interruptedResult = batch && typeof batch.finishedAt !== 'number';
        var resultScope = locked ? '已锁定 ' + lockedCount + ' 行' : '按最新快照';
        var historyHint = interruptedResult ? ' · 批量未跑完，只有中断前完成的部分有结果，未锁定下表' : (batchNote && note && note.text ? '；旧批量记录已折叠（详见本行记录）' : '');
        var actionHint = failedResults > 0 ? ' · 展开失败行看原因后刷新或重试' : (pendingResults ? ' · 先刷新状态，不要重复点击' : '');
        resultHint = h('div', { className: 'das-note' + (interruptedResult ? '' : (failedResults > 0 ? ' is-err' : ' is-ok')), role: 'status', title: lockExplain + (batchNote && note && note.text ? '。已折叠的历史批量提示：' + note.text : '') },
          chip('rh', interruptedResult ? '已中断（未完成）' : (failedResults > 0 ? '有失败' : (pendingResults > 0 ? '待确认' : '已完成')), interruptedResult ? 'warn' : (failedResults > 0 ? 'err' : (pendingResults > 0 ? 'warn' : 'ok'))),
          h('span', { className: 'das-note-text' }, '本轮处理 ' + resultItems.length + ' 项' + (changedResults ? ' · 已变化 ' + changedResults : '') + (pendingResults ? ' · 待确认 ' + pendingResults : '') + (failedResults ? ' · 失败 ' + failedResults : '') + actionHint + historyHint + ' · ' + resultScope));
      }

      /* 行按钮与「本轮结果」记录一致时不必再说；一旦行按钮不再代表那一轮（记录已超期、锁已释放），
         就把记录贴回该行 —— 这正是用户看到「状态栏说完成、行里还能点更新」时缺的那一句话。 */
      var recordByPkg = {};
      for (var ri = 0; ri < results.length; ri += 1) recordByPkg[results[ri].pkg] = results[ri];
      /* 上次翻译优化的逐项结果（按包名索引）：行内标「上次失败」、悬停槽给「上次翻译优化」用。 */
      var translateItems = {};
      if (translate && Array.isArray(translate.items)) {
        for (var ti = 0; ti < translate.items.length; ti += 1) {
          var tItemCur = translate.items[ti];
          var tItemPrev = translateItems[tItemCur.pkg];
          /* 一个包现在有两条（生成 + 应用）：悬停与「上次失败」徽章必须看到**失败那条**的真实原因，
             不能被后面那条「已应用 / 待补文案」盖掉。 */
          if (tItemPrev === undefined || (isBad(tItemCur.state) && !isBad(tItemPrev.state))) translateItems[tItemCur.pkg] = tItemCur;
        }
      }

      /* 表格要列的行：默认排除随 DSH 提供的对象（上面已算好 bundledList）。 */
      var listed = (rows === null || showBundled) ? rows : (rows || []).filter(function (r) { return r.bundled !== true; });
      var visible = (onlyFlagged && listed) ? listed.filter(function (r) {
        return (r.issues || []).length > 0 || (r.findings || []).some(function (f) { return f.confidence === 'fact' || f.severity !== 'low'; });
      }) : listed;

      var table = rows === null
        ? h('div', { className: 'das-note' }, h('span', { className: 'das-note-text' }, (note && note.sticky === true) ? '状态未读取成功，原因见上方提示。' : (IS_SKILL ? '正在读取技能状态…' : '正在读取插件状态…')))
        : h('div', { className: 'das-wrap' },
            resultHint ? h('div', { className: 'das-table-meta' }, resultHint) : null,
            h('table', { className: 'das-table' },
              h('thead', null, h('tr', null,
                h('th', null, IS_SKILL ? '技能与中文说明' : '插件与中文说明'),
                h('th', null, '健康与优化'),
                h('th', null, '版本'),
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
                /* 事实级发现行内只留严重度徽章（标题进悬停槽与 title）；推断级只计数。 */
                var managerProblem = r.errorCode === 'incompatible-version' || r.errorCode === 'bundle-error' || r.error;
                var readOnly = r.translationEligible === false;
                var stateTone = readOnly ? 'dim' : (r.localized ? 'ok' : 'warn');
                var stateText2 = readOnly
                  ? (r.bundled === true ? '随 DSH 提供' : '未纳入翻译优化')
                  : (r.localized ? '已优化' : (r.needsText ? '待生成文案' : '待应用'));
                var record = recordByPkg[r.pkg];
                var recordChip = (record && done[r.pkg] === undefined)
                  ? chip('rc', '本轮 · ' + stateText(record.state), STATE_TONE[record.state] || 'dim',
                      '这是「本轮结果」里针对本行的记录（' + agoText(record.at) + '，动作：' + (ACTION_TEXT[record.action] || record.action) + '）：' +
                      (record.message || '') + '。它不是当前状态：当前状态由版本列与「更新」按钮决定。')
                  : null;
                /* 更新口径：显式状态 chip，而不是只给一个箭头让用户猜。
                   「版本不兼容」（管理器拒绝）优先 —— 那正是「装了但版本没动」的真因。
                   这个 chip 现在不再占列宽：版本列只显示版本号，状态 / 来源 / 远端版本全部进 title。 */
                var updateState = managerProblem
                  ? { text: '版本不兼容', tone: 'err', title: String(r.errorMessage || r.error || '宿主管理器拒绝了这个版本') }
                  : (upd ? { text: '可更新', tone: 'warn', title: IS_SKILL ? '远端比本地新' : '远端比已装版本新' }
                    : (r.hasUpdate === false ? { text: '已最新', tone: 'ok', title: '远端与本地一致' }
                      : { text: '不可比', tone: 'dim', title: r.reason || '没有可比的远端版本' }));
                var latestText = IS_SKILL
                  ? (r.isGit === true
                    ? (r.hasUpdate === true ? '远端 ' + shortShaOf(r.remoteSha)
                      : (r.hasUpdate === false ? '最新 ' + shortShaOf(r.localSha) : '未比对（' + (r.reason || '未知') + '）'))
                      + (r.dirty > 0 ? ' · 本地改动 ' + r.dirty + ' 个文件' : '')
                    : '本地目录')
                  : (r.latest ? (upd ? '可更新到 ' + r.latest : '已是 ' + r.latest) : (r.reason || '—'));
                /* 版本列只显示版本号：更新状态 / 来源 / 远端版本 / 本轮记录说明全部收进 title，悬停即读。
                   用户原话：这一列内容重叠，只显示版本号即可；有更新时新版本号写到「更新」按钮上。 */
                var versionTitle = [
                  IS_SKILL ? rev.title : ('已安装版本：' + (r.version || '未知')),
                  updateState.text + ' —— ' + updateState.title,
                  '来源：' + (r.sourceLabel || '未确认远端仓库') + (r.sourceUrl ? ' · ' + r.sourceUrl : ''),
                  latestText,
                  (record && done[r.pkg] === undefined)
                    ? ('本轮结果：' + stateText(record.state) + ' · ' + (record.message || '') + '（它不是当前状态）')
                    : '',
                ].filter(function (x) { return typeof x === 'string' && x !== ''; }).join('\n');
                var nameLine = (r.displayName && r.displayName !== r.pkg) ? r.displayName + ' · ' + r.pkg : (r.displayName || r.pkg);
                /* 主功能展示：中文名做主标题、原包名次级、优化后的中文说明直接占一行。
                   过去把「包名（中文名） · 包名」整串塞进一格，等于把中文名藏起来、
                   还让列表看不到任何优化结果 —— 用户为此专门提过两次。 */
                var zhName = zhNameOf(r.displayName, r.pkg);
                if (zhName === '' && r.pkg === OWN_PKG) zhName = LABEL;
                /* 宿主没给中文名时用内置快照兜底（仅当这一行的中文确实已落盘，
                   免得「还没应用」的行也显示中文，反而误导） */
                var snap = zhName === '' ? catalogZh(r.pkg) : null;
                var useSnap = snap !== null && r.localized === true;
                if (useSnap && snap.name !== '') zhName = snap.name;
                var descText = r.localizedDescription || (useSnap ? snap.desc : '');
                var descFromSnap = useSnap && !r.localizedDescription;
                var primaryName = zhName !== '' ? zhName : (r.displayName || r.pkg);
                var showPkg = zhName !== '' || (r.displayName && r.displayName !== r.pkg) ? r.pkg : '';
                var optimizeTitle = (readOnly
                  ? (r.bundled === true
                    ? '该对象来自 DSH 内置运行时，在 app.asar 内没有可写路径，不参与翻译优化。'
                    : '该对象由宿主管理，当前没有可写路径，不参与翻译优化。')
                  : (r.localized ? '文案已落盘' : (r.needsText ? '还没有文案条目，需要调用模型生成' : '已有文案但未落盘，点「翻译优化」应用')))
                  + (descText ? ' 说明：' + descText : '');
                /* 一行一项：整行就是四列、每列一个 .das-cell（不换行的 flex 行）。
                   名称列 = 中文名（不缩） + 包名（可缩） + 中文说明（可缩，同一行内省略号）；
                   状态列 = 状态 chip + 上次失败 + 严重度 + 「需处置 N」（本身可点开）；
                   版本列 = 版本 + 更新状态 + 来源 + 远端版本 + 本轮记录。
                   其余信息（作用、管理器异常、审查标题与证据、时间戳）全部只在悬停卡与 title 里。 */
                var issueCount = issues.length + facts.length;
                var cells = [
                  h('td', { className: 'das-name' },
                    h('span', { className: 'das-cell' },
                      h('span', { className: 'das-name-main', title: r.pkg }, primaryName),
                      showPkg !== '' ? h('span', { className: 'das-name-pkg das-fit', title: r.pkg }, showPkg) : null,
                      descText
                        ? h('span', { className: 'das-desc-line das-fit', title: descText + (descFromSnap ? '（来自客户端内置快照；宿主未提供，重启 DSH 后由宿主提供）' : '') }, descText)
                        : null)),
                  h('td', { className: 'das-status-cell' },
                    h('span', { className: 'das-cell' },
                      chip('lo', stateText2, stateTone, optimizeTitle),
                      (translateItems[r.pkg] && isBad(translateItems[r.pkg].state) && r.localized !== true)
                        ? chip('tf', '上次失败', 'err',
                            '上次翻译优化（' + agoText(translate.finishedAt) + '）里这一项失败了：' + (translateItems[r.pkg].message || '无原因') +
                            ' —— 点「翻译优化」可重试；悬停本行看完整记录')
                        : null,
                      facts.length > 0
                        ? h('span', {
                            className: 'das-sev ' + (SEV_CLASS[sev] || 'is-low'),
                            title: facts.map(function (f) { return (SEV[f.severity] || f.severity) + ' · ' + f.title; }).join('\n'),
                          }, SEV[sev])
                        : null,
                      issueCount > 0
                        ? chipBtn('ev', openPkg === r.pkg ? '收起 ' + issueCount : '需处置 ' + issueCount,
                            openPkg === r.pkg ? 'ok' : 'warn',
                            '本行有 ' + issueCount + ' 条需处置的发现（' + issues.length + ' 条状态问题、' + facts.length + ' 条事实级发现）：' +
                            (openPkg === r.pkg ? '点这里收起' : '点这里在行下展开证据、影响与处理建议'),
                            function () { setOpenPkg(openPkg === r.pkg ? '' : r.pkg); }, openPkg === r.pkg)
                        : (findings.length > 0
                          ? chipBtn('ev', openPkg === r.pkg ? '收起 ' + findings.length : '附带观察 ' + findings.length,
                              openPkg === r.pkg ? 'ok' : 'dim',
                              '本行另有 ' + findings.length + ' 条低置信观察（只供知悉，不要求处置）：' +
                              (openPkg === r.pkg ? '点这里收起' : '点这里在行下展开'),
                              function () { setOpenPkg(openPkg === r.pkg ? '' : r.pkg); }, openPkg === r.pkg)
                          : chip('ev', '暂无需处置', 'ok', '当前没有安全或冲突问题')))),
                  /* 整列只留版本号 + 本行的本轮记录 chip：来源 / 更新状态 / 远端版本都在 title 里。 */
                  h('td', { className: 'das-num das-version-cell' },
                    h('span', { className: 'das-cell' },
                      h('span', { className: 'das-version-current', title: versionTitle }, IS_SKILL ? rev.text : (r.version || '—')),
                      recordChip)),
                ];
                var op = [];
                var finished = done[r.pkg];
                if (job && !job.done) {
                  if (job.pending === true || job.stage === 'awaiting-confirmation') {
                    op.push(opBtn('j', '刷新状态', busyNow, refresh, (job.message || '安装请求正在等待宿主确认') + '；先刷新状态，不要重复点击更新', true));
                  } else {
                    op.push(h('span', { key: 'j', className: 'das-foot', title: job.message || '' }, (job.stage || '执行中') + '…'));
                  }
                }
                // 本会话已处理过这一行：待确认提供刷新，失败提供重试，其余结果保留事实但不重复触发。
                else if (finished && (finished.state === 'pending-check' || finished.state === 'awaiting-confirmation')) {
                  op.push(opBtn('u', '刷新状态', busyNow, refresh,
                    (finished.message ? finished.message + ' · ' : '') + '先确认宿主结果，不要重复启动更新', true));
                }
                else if (finished && finished.state === 'failed' && upd) {
                  op.push(opBtn('u', '重试更新', busyNow, function () { doUpdate(r.pkg); },
                    (finished.message ? finished.message + ' · ' : '') + '确认失败原因后可重新执行', true));
                }
                else if (finished) op.push(opBtn('u', outcomeLabel(finished), true, null,
                  (finished.message ? finished.message + ' · ' : '') + '本轮已处理；点「刷新状态」可重新判定'));
                /* 有新版本时，目标版本号直接写在按钮上（版本列不再重复显示远端版本）。 */
                else if (upd) op.push(opBtn('u', '更新 ' + (IS_SKILL ? shortShaOf(r.remoteSha) : (r.latest || '')), busyNow, function () { doUpdate(r.pkg); },
                  IS_SKILL ? 'git 快进到远端 ' + shortShaOf(r.remoteSha) : '更新到 ' + (r.latest || '最新版'), true));
                if (!readOnly && r.translationEligible !== false && r.needsText === true) {
                  op.push(h('button', { key: 'gen', type: 'button', className: 'das-btn das-mini primary',
                    disabled: busyNow, 'aria-label': '只为当前插件生成并应用中文名称与说明',
                    onClick: function () { optimizeOne(r); } }, busy === 'optimize:' + r.pkg ? '生成中…' : '优化文案'));
                }
                /* 「展开 N」不再自己占一个按钮：状态列的「需处置 N / 附带观察 N」就是入口（见 chipBtn）。
                   操作列越窄，按钮越容易换行，行高就越容易翻倍。 */
                cells.push(h('td', { className: 'das-act' }, h('span', { className: 'das-cell' }, op.length ? op : null)));
                var row = h('tr', {
                  key: r.profileDir + '|' + r.pkg,
                  className: r.installed === false ? 'is-dim' : undefined,
                  onMouseEnter: function (event) {
                    setHoverPkg(r.pkg);
                    setHoverBox(boxFromEvent(event));
                  },
                  onMouseLeave: function () { if (openPkg === '') setHoverPkg(''); },
                }, cells);
                if (openPkg !== r.pkg || (issues.length === 0 && findings.length === 0)) return row;
                var inlineItems = [];
                findings.forEach(function (finding) {
                  inlineItems.push(h('div', { key: 'finding:' + finding.id, className: 'das-inline-item ' + (SEV_CLASS[finding.severity] || '') },
                    h('div', { className: 'das-inline-title' }, h('span', { className: 'das-sev ' + (SEV_CLASS[finding.severity] || 'is-low') }, SEV[finding.severity] || finding.severity), finding.confidence === 'fact' ? null : ' 推断', ' ', finding.title),
                    h('div', { className: 'das-inline-copy' }, '影响/目的：' + (finding.impact || '用于判断该对象是否能被正确识别、选择或安全更新。')),
                    h('div', { className: 'das-inline-copy' }, '证据：' + (finding.evidence || '—')),
                    h('div', { className: 'das-inline-copy' }, '建议：' + (finding.remedy || '—')),
                    h('div', { className: 'das-inline-actions' },
                      finding.action && (finding.action.kind === 'update' || finding.action.kind === 'translate' || finding.action.kind === 'manual' || finding.action.kind === 'open-repo')
                        ? h('button', { type: 'button', className: 'das-btn das-mini primary', disabled: busy.indexOf('finding:') === 0, onClick: function () { findingAction(finding, finding.action.kind); } }, finding.action.label || (finding.action.kind === 'translate' ? '一键翻译优化' : (finding.action.kind === 'update' ? '一键更新' : '查看处置建议')))
                        : null,
                      h('button', { type: 'button', className: 'das-btn das-mini', disabled: busy.indexOf('ignore:') === 0, onClick: function () { ignore(finding.id); } }, '忽略'))));
                });
                issues.forEach(function (issue, issueIndex) {
                  inlineItems.push(h('div', { key: 'issue:' + issueIndex, className: 'das-inline-item is-medium' },
                    h('div', { className: 'das-inline-title' }, issue.reason || '状态异常'),
                    h('div', { className: 'das-inline-copy' }, '影响/目的：' + (issue.impact || issue.reason || '需要确认当前状态是否可继续使用。')),
                    h('div', { className: 'das-inline-copy' }, '建议：' + (issue.remedy || '—')),
                    issue.action && issue.action.kind === 'retry'
                      ? h('button', { type: 'button', className: 'das-btn das-mini', onClick: refresh }, issue.action.label || '重试')
                      : null));
                });
                return [row, h('tr', { key: r.profileDir + '|' + r.pkg + '|detail' }, h('td', { colSpan: 6, className: 'das-inline-detail' }, h('div', { className: 'das-inline-detail-grid' }, inlineItems)))];
              }))));

      /* ── 悬停详情槽（用户三条里的「鼠标悬停拓展展示详细信息」）──
         行内只留一行主要信息，完整信息在这里。固定槽位 + 预留高度：换内容不改布局，所以不跳行。
         优先显示「点展开钉住」的那一行，否则显示最近悬停的一行。 */
      var detailPkg = openPkg || hoverPkg;
      var detailRow = rows ? rows.filter(function (r) { return r.pkg === detailPkg; })[0] : null;
      /* 卡片只在真的有详情行时渲染；位置由 placeCard 决定（锚在行旁、钳在视口内）。
         不再预留槽位 → 表格下方的整块高度都还给内容。 */
      var hoverEl = !detailRow ? null : h('div', {
        className: 'das-hover', role: 'status',
        style: {
          left: (hoverBox || { left: 12 }).left,
          top: (hoverBox || { top: 64 }).top,
          maxHeight: (hoverBox || { maxHeight: 480 }).maxHeight,
        },
      }, (function () {
        var d = detailRow;
        var dRecord = recordByPkg[d.pkg];
        var dFacts = (d.findings || []).filter(function (f) { return f.confidence === 'fact'; });
        var dInferred = (d.findings || []).filter(function (f) { return f.confidence !== 'fact'; });
        var pairs = [];
        /* 名称这一行要解释「为什么没有中文名」——否则「已优化」却不显示中文，用户只会觉得坏了。
           三种情况分开说：宿主给了／内置快照兜底（并标注来源）／确实没有（宿主太旧 或 条目本来没有）。 */
        var nameMissingHost = revGap && compareRev(hostRev, CLIENT_REV) < 0;
        var dSnap = (!d.displayName || d.displayName === d.pkg) ? catalogZh(d.pkg) : null;
        var dUseSnap = dSnap !== null && d.localized === true && dSnap.name !== '';
        var isOwn = d.pkg === OWN_PKG;
        pairs.push(['名称', (d.displayName && d.displayName !== d.pkg)
          ? d.displayName + '（' + d.pkg + '）'
          : (isOwn
            ? LABEL + '（' + d.pkg + '）· 本插件自身'
            : (dUseSnap
              ? dSnap.name + '（' + d.pkg + '）· 来自客户端内置快照'
              : (d.pkg + (d.localized === true
                ? (nameMissingHost
                  ? '（宿主半体 v' + hostRev + ' 未提供中文名 —— 重启 DSH 后这里会显示）'
                  : '（该条目没有中文名，只有原包名）')
                : ''))))]);
        if (d.localizedDescription) pairs.push(['中文说明', d.localizedDescription]);
        else if (dUseSnap && dSnap.desc) pairs.push(['中文说明', dSnap.desc + (nameMissingHost ? '（来自客户端内置快照；宿主 v' + hostRev + ' 未提供，重启后由宿主提供）' : '（来自客户端内置快照）')]);
        if (IS_SKILL && d.purpose) pairs.push(['作用', d.purpose]);
        if (IS_SKILL && d.descriptionLang) pairs.push(['描述语言', d.descriptionLang]);
        pairs.push([IS_SKILL ? '修订' : '版本', (IS_SKILL ? skillRevision(d).text : (d.version || '—')) +
          (IS_SKILL ? '' : (d.latest ? ' → 远端 ' + d.latest : '（' + (d.reason || '没有可比的远端版本') + '）'))]);
        if (d.sourceUrl) pairs.push(['来源', (d.sourceLabel || '远端仓库') + ' · ' + d.sourceUrl]);
         else if (IS_SKILL && d.source) pairs.push(['来源', shortRoot(d.source)]);
        if (d.errorMessage || d.error) pairs.push(['管理器异常', String(d.errorMessage || d.error)]);
        if (dRecord) {
          pairs.push(['本轮结果', stateText(dRecord.state) + (dRecord.message ? ' · ' + dRecord.message : '')
            + '（' + agoText(dRecord.at) + '）' + (dRecord.fix ? ' → ' + dRecord.fix : '')]);
        }
        if (dFacts.length || dInferred.length) {
          pairs.push(['审查', dFacts.map(function (f) { return (SEV[f.severity] || f.severity) + '·' + f.title; }).join('；')
            + (dInferred.length ? '（另有 ' + dInferred.length + ' 条推断）' : '')]);
        }
        /* 「我明明点过翻译优化」的正面回答：这一项上次跑成了没有、失败原因是什么。 */
        var tItem = translateItems[d.pkg];
        pairs.push(['上次翻译优化', tItem
          ? (stateText(tItem.state) + (tItem.message ? ' · ' + tItem.message : '') + '（' + agoText(translate.finishedAt) + '）')
          : (translate ? '最近一次运行（' + agoText(translate.finishedAt) + '）没有这一项' : '无记录：还没跑过，或记录已被清理')]);
        return [
          h('div', { key: 'k', className: 'das-hover-head' },
            h('span', { className: 'das-hover-name' }, d.displayName || d.pkg),
            chip('hv', openPkg === d.pkg ? '已钉住' : '悬停预览', openPkg === d.pkg ? 'ok' : 'dim',
              openPkg === d.pkg ? '点行内「收起」取消钉住' : '点行内状态列的「需处置 N / 附带观察 N」可钉住并在行下显示操作按钮')),
          h('div', { key: 'g', className: 'das-hover-grid' }, pairs.map(function (p, i) {
            return h('div', { key: 'p' + i },
              h('span', { className: 'das-hover-k' }, p[0] + '：'),
              h('span', { className: 'das-hover-v' }, String(p[1])));
          })),
        ];
      })());

      return h('div', { className: 'das-root' },
        h('div', { className: 'das-head' },
          props && props.seg ? props.seg : null,
          h('h3', { className: 'das-title' }, LABEL,
            chip('cr', 'v' + CLIENT_REV, 'dim', '客户端半体版本（随页面刷新热更新）', true),
            chip('hr', hostRev ? '宿主 v' + hostRev : '宿主未知', revGap ? 'err' : 'dim',
              '宿主半体只在 DSH 进程启动时加载一次；它与客户端版本不一致时，新接口可能不存在', true)),
          /* 首屏第一句必须讲「本插件给你什么」，而不是讲命名约定 ——
             用户原话：当前对插件的功能、简介缺乏展示。命名约定这类机制说明退到 title。 */
          h('p', {
            className: 'das-sub',
            title: IS_SKILL
              ? '命名约定：name 保留原文，中文名以（）附加；技能不是 npm 包，版本取 SKILL.md 声明的 version，未声明则回落到 git 提交号。'
              : '命名约定：标题保留原包名，中文名以（）附加；中文化写入插件自身的 locale，因此 DSH 内置 Plugins 页会原生显示中文。',
          }, IS_SKILL
            ? '把技能的英文说明精炼成中文，写回 SKILL.md —— 下次对话里模型就是按这份中文描述来选择技能；本页同时汇总来源、修订与描述语言。'
            : '把插件的英文标题与说明精炼成中文（保留原包名），写入插件自身的 locale —— DSH 内置的 Plugins 页会直接显示中文。本页同时汇总版本、更新与冲突。')),
        head,
        staleEl,
        guidanceEl,
        kpiEl,
        noteEl,
        table,
        hoverEl,
        h('p', { className: 'das-sub', title: IS_SKILL
          ? '技能改写会真实写入 SKILL.md；写入前保留 .dsh-skill.backup，必要时可还原；改写描述属于行为变更。'
          : undefined }, IS_SKILL
          ? '技能表已合并来源、修订、翻译、更新与审查；翻译会写入 SKILL.md 并保留备份。· 把鼠标移到任意一行，详情卡贴在该行旁边（点状态列的「需处置 N」可钉住）。'
          : '插件表已合并优化状态、版本、更新、审查与本轮结果；安装和更新由第一方管理器执行。· 把鼠标移到任意一行，详情卡贴在该行旁边（点状态列的「需处置 N」可钉住）。'));
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
      /* 页签由 Merged 建好、传进来，和标题同处一行：省掉一整行头部高度（用户要求位置上移、
         把显示位置腾给内容）。 */
      var segEl = h('div', { className: 'das-seg', role: 'tablist' },
        tab('plugin', '插件', '插件半体：翻译优化、版本与更新、冲突与兼容审查'),
        tab('skill', '技能', '技能 SKILL.md：翻译优化、来源、作用与审查'));
      return h('div', { className: 'das-root' },
        h('style', { key: 'das-css' }, CSS),
        h(Panel, { key: mode, target: mode, seg: segEl }));
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
