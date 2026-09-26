# Changelog

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
