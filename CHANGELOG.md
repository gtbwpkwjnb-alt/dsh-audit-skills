# Changelog

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
