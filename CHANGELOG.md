# Changelog

## 1.4.0 — 2026-09-26 · 新装插件识别 / 按钮稳定性 / 版本监控与一键更新

用户反馈：① 新装插件识别不到 ② 设置里的翻译按钮「时有时无」 ③ 希望刷新时能看到版本、是否有新版本、并能一键更新。

### ① 换用第一方数据源，两端天然一致

`status` 现在优先调用 **`pluginManager.listBundles()`**（就是插件页用的那份数据），
服务不可用时才回落到自行扫描。这样：
- 新装插件必然出现（与插件页同源）
- 不会出现「插件页有、设置页没有」

### ② 按钮「时有时无」的根因

旧代码直接访问 `ctx.slots`，若 `slots` 服务尚未挂载就会抛错，而被 `safe()` **静默吞掉** ——
表现就是设置页分区时有时无。

修复：改为 `ctx.inject(['slots'], (sctx) => { … })`，**等服务就绪再注册**；
失败仍隔离，但会写 `console.warn` 而不是完全无声。

### ③ 版本监控与一键更新

新增两个 bridge 动作：

| 动作 | 说明 |
|---|---|
| `/updates` | 逐个已装插件查 npm 最新版；给出 `version / latest / hasUpdate / reason`。git 安装的包（如本插件）返回 `unavailable`，**不猜** |
| `/update` | **经第一方 `pluginManager.installBundle()` 执行**，自带 profile 锁、兼容预检与失败回滚 |

UI 新增 **检查更新** 按钮与 版本 / 最新 / 操作 三列；有更新时该行出现「更新」按钮。

**为什么不自己跑 pnpm**：那会与应用持有的 profile 写锁竞争，可能损坏 profile。
复用第一方服务是唯一安全的做法。

### 附带

闸门 `preflight-client.mjs` 补强：`inject` 桩会真正调用回调，
因此 `settings.section` / `plugins.row.config` 的注册仍被验证（此前会被跳过）。

## 1.3.2 — 2026-09-26 · 🔁 修复「插件页慢一拍」的自伤循环

### 现象

重启后部分插件变中文（better-sidebar / dsh-context / whale-widget / 本插件），
但 **free-search / memory / find-plugins 仍是英文**。

### 根因：默认开启的退出还原，造成无限循环

实机时间戳是铁证：

| 包 | package.json mtime | 插件页 |
|---|---|---|
| whale-widget / better-sidebar | 13:47–13:48（**从未被本插件改过**） | ✅ 中文 |
| free-search / memory / find-plugins | **23:16:10**（应用 23:16:09 启动后 **1 秒**） | ❌ 英文 |

循环过程：

1. 退出 DSH → Cordis `dispose()` 触发 → 因 `revertOnDisable: true` **还原**，
   把我加进 `package.json` 的 `./locale/*.json` 导出**撤掉**
2. 下次启动 → 宿主在 T+0 读插件元数据（此时导出缺失 → 英文）
3. T+1s → 本插件 `apply()` 又把导出加回来

⇒ **插件页永远显示上一轮的状态。** 而 whale-widget（无 exports）与
better-sidebar / dsh-context（作者本就有该导出）从未被我改过 `package.json`，
所以不受影响——与观测完全吻合。

### 修复

- `revertOnDisable` **默认改为 `false`**。`dispose` 无法区分「停用插件」与「退出 DSH」，
  在退出时还原是错误的默认值。需要还原请用设置页的**「还原翻译」按钮**（显式、可控）。
- `writeJson` 改为**内容一致就不写**，不再每次启动刷新 mtime，消除与宿主读元数据的时序竞争。

### 验证

```
第一次 applyLocale 是否改动文件: false
第二次 applyLocale 是否改动文件（应为 false）: false
revertOnDisable 默认值 = false
```

### 附带修复

`VERSION` 文件此前停留在 1.3.0，与 `package.json` 不一致 —— 已同步为 1.3.2。

## 1.3.1 — 2026-09-26 · 三个实机问题修复

用户实测反馈：① 本插件自己的卡片是英文 ② 新装的插件没被翻译 ③ 设置页列了未安装插件，与插件页不统一。

### ① locale 导出键写错（根因）

DSH 解析 `<pkg>/locale/en.json` 时**要求 exports 用 `./locale/*.json` 形式**；
`./locale/*` 虽然 Node 能解析，**DSH 读不到**。

实机对比（100% 相关）：

| 包 | locale 导出键 | 插件页 |
|---|---|---|
| dsh-better-sidebar / dsh-context | `./locale/*.json` | ✅ 中文 |
| dsh-whale-widget | 无 exports（纯路径） | ✅ 中文 |
| dsh-free-search / @furongjun1999/dsh-memory | `./locale/*` ← 本插件旧版所加 | ❌ 未生效 |
| dsh-audit-skills（自身） | 无 locale 导出 | ❌ 英文 |

修复：
- 新写入一律用 `./locale/*.json`
- **自动迁移**：已存在 `./locale/*` 的包会被改写为 `./locale/*.json`（删旧键、加新键，写前备份）
- **本插件自身**也补上 `./locale/*.json`——之前只顾着给别的插件补，忘了自己

### ② 新装插件无法翻译

旧版 catalog 是**静态 7 条**，用户新装的 `dsh-find-plugins` 不在其中，点"应用翻译精炼"也无效。

修复：`collectStatus` 改为**动态发现已装 bundle**（读 profile 的 dependencies，
按 `dsh.bundle.patch` 判定，与插件页同口径），新装插件立刻出现在表里并标为
**待补文案**；`applyLocale` 也会对这类包返回 `needs-catalog` 而不是静默跳过。
同时补入 `dsh-find-plugins` 的精炼文案。

### ③ 设置页与插件页不统一

旧版 `collectStatus` 遍历 catalog，把已卸载的 `dsh-web-fetch-playwright`、
`@linxin666/dsh-remote-web-ui` 也列成"未安装"。

修复：只列**已安装**项。表头改为 插件 / 启用 / 精炼 / 插件页当前标题。

### 验证（对已安装产物）

```
status  rows=7  未安装=0  待补文案=0
  on | 已精炼 | @furongjun1999/dsh-memory
  on | 已精炼 | dsh-audit-skills
  on | 已精炼 | dsh-better-sidebar
  on | 已精炼 | dsh-context
  on | 已精炼 | dsh-find-plugins
  on | 已精炼 | dsh-free-search
  on | 已精炼 | dsh-whale-widget

locale/en.json 解析：7/7 OK
客户端闸门：ALL PASS
```

## 1.3.0 — 2026-09-26 · 客户端半体以**正确格式**回归 + 发布闸门

### 根因彻底解决

v1.2.1 复盘时发现：DSH 的客户端**不是**必须用打包器产出——生态插件的 `client.js` 用的是
**手写即可的传统脚本格式**：

```js
window.__ModuleLoader__.load({
  id: '<plugin-id>',
  factory: (require) => {
    var module = { exports: {} }
    var react = require('react')
    // ...
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
```

关键是**不得有顶层 `import`**，依赖经 factory 收到的 `require` 获取。

### 新增发布闸门 `scripts/preflight-client.mjs`

以**传统脚本**方式在 Node `vm` 中执行 `client.js`——任何顶层 `import/export` 都会当场抛
`SyntaxError`，正是 v1.2.0 崩溃的那个错误。随后校验 `load()` 调用、`factory` 执行、
`exports` 契约（name/inject/apply）以及 `apply()` 不抛错。

**此后任何客户端改动，必须先过此闸门才允许发布。**

### 恢复的能力

- 设置页 **「技能审查」分区**：应用翻译精炼 / 还原翻译 / 刷新状态 + 状态表
- **插件页本插件卡片**（key `dsh-audit-skills#dsh-audit-skills`）
- **侧边栏卡片**（可选，需 dsh-better-sidebar；缺失时静默跳过）
- 全部经 ErrorBoundary 隔离；三个入口的注册各自 try/catch，失败只影响本插件

### 仍未覆盖的风险

闸门只能证明**脚本格式与注册路径正确**，不能证明真机渲染无误。
首次启用请先确认设置页与 Plugins 页其余部分正常。

## 1.2.1 — 2026-09-26 · 🔥 事故修复：客户端半体导致 web-boot 崩溃

### 事故

v1.2.0 安装后重启，**DSH GUI 无法启动**。

```
crash-…-web-boot.log
Error: web boot: 1 entry did not activate
dsh-audit-skills: import failed (see console for the import error)

renderer console:
dsh-app://app/plugins/??dsh-audit-skills/client.js:11
Uncaught SyntaxError: Cannot use import statement outside a module
```

### 根因

**DSH 的客户端半体必须是打包后的传统脚本**（rolldown/tsdown 产物），加载方式等同
`<script>`，没有 `type="module"`。v1.2.0 直接以**裸 ESM**（顶层 `import ... from 'react'`）
作为 `client.js`，浏览器按传统脚本解析 → 语法错误 → 该 client entry 无法激活。

### 一个被纠正的错误认知

此前我以为"某个 bundle 加载失败只会产生 warning"。这只对**宿主半体**成立。
**客户端/web 半体失败是致命的**：`web boot: 1 entry did not activate` → 整个 GUI 起不来。

### 修复

- **移除 `dsh.client` 声明与 `./client` export** → 不再加载客户端半体，恢复为 v1.1.0 的
  纯宿主形态（已本机实测、不会崩）。
- 客户端源码移入 `src/client.js`，文件头写明"**尚不可直接加载**"及恢复路径（需引入构建链）。
- 事故恢复手册（用户侧）：在 `~/.dsh/profiles/<profile>/package.json` 的
  `dsh.profile.bundles` 中删掉本插件行 → 下次启动即不再加载。

### 状态

宿主半体能力（插件页中文化、开关即应用/还原、新装插件自动纳入）**不受影响，继续可用**。
按钮式 UI 需先补构建链，见 `docs/client-ui-plan.md`。

## 1.2.0 — 2026-09-26

### 客户端半体（需真机验证）

按 `docs/client-ui-plan.md` 实现，三个入口全部经 **ErrorBoundary 隔离**——
渲染失败只在本插件范围内显示一行提示，不拖垮设置页或插件页（对抗审查 T1）：

| 入口 | Slot / API | 说明 |
|---|---|---|
| 设置页「技能审查」分区 | `ctx.slots.inject("settings.section")` | 主入口：按钮组 + 状态表 |
| 插件页卡片 | `ctx.slots.inject("plugins.row.config")`，key = `dsh-audit-skills#dsh-audit-skills` | 与设置页同一面板 |
| 侧边栏卡片（可选） | `ctx.betterSidebar.registerTab` | `betterSidebar` 不存在时静默跳过 |

按钮：**应用翻译精炼** / **还原翻译** / **刷新状态**。状态表列出「插件 / 已精炼·待精炼·未安装 / 插件页当前标题」。

### 宿主半体新增 bridge

`ctx.inject(['webServer'])` 注册三个 `kind: 'exact'` 路由：
`/api/dsh-audit-skills/{status,apply,revert}`。客户端不直接读磁盘，一律经此通道；
每个 handler 独立 try/catch，失败返回 `{ok:false,message}` 而非 5xx。

### 委托边界（不自研）

更新检查 / 推荐 / 崩溃守护 **未在本插件实现**，设置页明确标注为委托生态既有插件。

### ⚠️ 验证状态

宿主半体已本机实测通过；**客户端半体尚未真机验证**（见 `docs/client-ui-plan.md` 的 5 条验证清单）。
若设置页出现异常，在 Plugins 页停用本插件即可完全恢复。

## 1.1.0 — 2026-09-26

### 从「技能」转为「插件」

- **移除 skill provider 注册**：本插件不再向 `ctx.skills` 注册技能，不再出现在技能目录里。
  它是纯插件形态——在侧边栏 Plugins 页显示为一张卡片 + 启用/停用开关。
- **开关即效果**：bundle 启用 → `apply()` 应用插件说明精炼；停用 → `dispose()` 默认还原（对抗审查 T3）。
- **声明式设置**（`Config`）：`autoApply` / `revertOnDisable` / `profileDir` / `extraProfileDirs`，
  由 DSH 按 schema 自动生成设置表单，无需自写 UI。
- **新装插件自动纳入**：每次 bundle 启用或 DSH 重启都会重扫 profile，新装插件自动精炼；
  也可停用再启用本插件来手动触发。

### 宿主半体能力（本机已实测）

```
catalog entries = 7
  installed enabled=true  localized=true  dsh-better-sidebar  -> dsh-better-sidebar（增强侧边栏）
  installed enabled=true  localized=true  dsh-context        -> dsh-context（上下文洞察）
  installed enabled=true  localized=true  dsh-free-search    -> dsh-free-search（免费搜索）
  MISSING   enabled=false localized=false dsh-web-fetch-playwright
  MISSING   enabled=false localized=false @linxin666/dsh-remote-web-ui
  installed enabled=true  localized=true  @furongjun1999/dsh-memory -> @furongjun1999/dsh-memory（灵枢记忆）
  installed enabled=true  localized=true  dsh-whale-widget   -> dsh-whale-widget（余额小鲸鱼）
```

- `applyLocale()` 写 `locale/{en,zh}.json`，必要时补 `exports` 的 `./locale/*`；幂等。
- `revertLocale()` 从 `.dsh-locale.backup`（兼容脚本的 `.dsh-locale.bak`）还原；不抛错。
- `collectStatus()` 只读汇总「已装 / 启用 / 已精炼 / 当前中文标题」。
- **零第三方依赖**；`apply()` 全量 try/catch，异常一律吞掉并降级只读（对抗审查 T1）。
- 未安装的插件条目 `skipped-not-installed`，不报错。

### 本插件自身也遵守同一约定

`locale/{en,zh}.json` → `dsh-audit-skills（插件审查）`。

### 延后到 v1.2.0（需真机验证）

客户端半体（设置页「技能审查」按钮组、Plugins 页卡片、侧边栏卡片）的全部 API 已探明并写入
`docs/client-ui-plan.md`。按对抗审查 **T1（自指崩溃）**——一个"防崩溃"插件若把设置页/插件页弄坏，
是用户最难恢复的故障——**未经真机验证的 React 客户端不随本版发布**。

## 1.0.0 — 2026-09-26

基于上游 `skills-summarize-audit` v9.2.2（MIT, © 2026 ZCode）做的 **DeepSeek Harness 适配版**，
作为独立的 DSH 插件重新打包发布。

### 新增

- **平台范围收敛**：`config.yaml` 新增 `platform_scope`（默认 `dsh`，
  `exclude_other_platforms: true`）。全量分析默认只覆盖 DSH；Codex / ZCode / Claude Code
  来源移入 `excluded_scan_paths`，仅在用户明确要求跨平台审查时纳入。
- **DSH 平台特征**：`platforms/dsh.yaml` —— profile 路径、6 级技能根 rank 表
  （100 project-dsh → 600 bundled）、`top_level_only` 发现规则、插件页文字机制、MCP 现状。
- **能力四：插件页中文化落地** —— `scripts/dsh_plugin_locale.mjs` +
  `references/dsh-plugin-locale-catalog.json`。
  直接写入 `<pkg>/locale/{en,zh}.json` 并补齐 `exports` 的 `./locale/*`，
  使 DSH 插件页显示精炼文案。**命名约定：title 保留原包名，中文名以全角括号附加**，
  避免中文覆盖后无法识别原插件。
- **能力五：市场按需检索** —— `scripts/dsh_market_search.mjs` +
  `references/dsh-market-needs.md`。按需求检索真 DSH bundle（含 `dsh.bundle.patch`），
  给出兼容 / 成本 / 已装状态 / 仓库对比。

### 与上游的差异

集中在 `config.yaml` 的 `platform_scope` / `scan_paths` / `excluded_scan_paths`，
以及上述 4 个新增文件。

### 已知边界

- 上游的 `scripts/audit_skill_plugin_issues.py` 仍以 Codex 侧来源为主，
  且 `config.yaml` 不参与脚本消费；脚本级 DSH 采集分支尚未实现。
- 插件页本地化写在 `node_modules` 内，**插件升级/重装后需重新执行 `--apply`**。
