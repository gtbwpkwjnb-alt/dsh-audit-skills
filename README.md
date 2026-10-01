# dsh-audit-skills

**DeepSeek Harness（DSH）专用的技能 / 插件审查插件。**

上游 [`skills-summarize-audit`](https://github.com/gtbwpkwjnb-alt/skills-summarize-audit-skill) v9.2.2 是跨平台（Codex / ZCode / Claude Code）审计技能。
本插件把它**收敛为 DSH 单平台**，并把「插件页中文化」提升为主能力。

MIT License · © 2026 ZCode（上游）· DSH 适配部分同许可发布。

---

## 安装

DSH 的 `desktop` / `web` profile 由插件管理器托管：

```bash
# 官方 profile（web 等）
dsh plugin --profile web add github:gtbwpkwjnb-alt/dsh-audit-skills

# 应用托管的 desktop profile：在侧边栏 Plugins 页粘贴
github:gtbwpkwjnb-alt/dsh-audit-skills
```

安装后 **重启 DSH**：侧边栏 **Plugins 页**出现 `dsh-audit-skills（插件审查）` 卡片，
卡片上的开关就是效果开关——**启用即应用精炼，停用即还原**。

> v1.1.0 起本插件是**纯插件形态**（不再注册 skill）。
>
> **v1.4.0 —— 新装插件识别 · 按钮稳定性 · 版本监控与一键更新。**
> 状态表改用第一方 `pluginManager.listBundles()` 作数据源（与插件页同源）；
> slot 注册改为 `ctx.inject(['slots'])` 等待服务就绪；新增「检查更新」与逐行「更新」按钮，
> 更新经第一方插件管理器执行（自带锁与回滚），不自行跑 pnpm。
>
> **v1.3.2 —— 修复「插件页慢一拍」。** 此前 `revertOnDisable` 默认 true，退出 DSH 时会把
> `package.json` 的 `./locale/*.json` 导出撤掉，下次启动宿主在读取元数据之后（+1s）才等到本插件重写，
> 导致插件页永远落后一轮。现已默认不还原（需要还原请用设置页的「还原翻译」按钮），并改为幂等写入。
>
> **v1.3.1 —— 修复 locale 导出键 / 新装插件 / 设置页口径。**
>
> DSH 要求 exports 用 **`./locale/*.json`**（`./locale/*` 无效）；本插件会自动迁移旧键。
> 状态表改为**动态发现已装 bundle**，新装插件自动现身并标「待补文案」。
>
> **v1.3.0 —— UI 半体以正确格式回归。** 关键：DSH 客户端必须是**无顶层 import 的传统脚本**
> （`window.__ModuleLoader__.load({ id, factory: (require) => ... })`），不是裸 ESM，也**不需要打包器**。
>
> ⚠️ **v1.2.1 事故（已修复）**：v1.2.0 发的是裸 ESM，被按传统脚本加载 →
> `Cannot use import statement outside a module` → `web boot: 1 entry did not activate` → **GUI 起不来**。
> 复盘见 [docs/incident-web-boot-crash.md](docs/incident-web-boot-crash.md)。
> 此后**任何客户端改动都必须先过** `scripts/preflight-client.mjs`（以传统脚本方式执行 + exports 契约校验）。
>
> **当前可用能力（宿主半体，已本机实测）**：启用本插件即自动把已装插件的插件页说明精炼为中文；
> **新装插件后停用再启用本插件**（或重启 DSH）即会自动补上，无需重装。
> 开启/关闭开关就是效果开关：关闭即还原。

---

## 五项能力

| # | 能力 | 触发 | 产物 |
|---|---|---|---|
| 一 | 技能库翻译精炼 | 技能翻译精炼 / 描述精炼 | 中文候选、真实来源与质量状态 |
| 二 | 项目画像 | 项目画像 / 项目审查 | 技术栈、项目类型、扫描边界与缺口 |
| 三 | 技能/插件推荐 | 技能审查 / 插件推荐 | 已装工具优化、同类比较、带证据的下一步 |
| 四 | **插件页中文化落地** | 插件页翻译 / 插件中文化 | 写入 `<pkg>/locale/{en,zh}.json`，插件页显示精炼中文 |
| 五 | **市场按需检索** | 找插件 / 需求检索 | 真 DSH bundle 的兼容/成本/冲突对比 |
| 六 | **插件与技能状态维护** | 设置页 → 插件 / 技能主表 | 在同一张表内查看翻译、作用、来源、版本、更新与审查；更新、翻译和还原均从对象行执行 |

### 关键约定：插件名保留原文

DSH 插件页的标题来自 `locale/<lang>.json` 的 `meta.title`，**一旦写成中文就再也认不出是哪个插件**。
因此本插件强制：

```json
// locale/zh.json
{ "meta": {
    "title": "dsh-free-search（免费搜索）",
    "description": "接管内置 web_search：13 个引擎自动降级，默认免 API key……只负责搜索，不接管网页抓取。"
} }
```

- `title` = **原包名（英文代码名）** + 全角括号中文名
- `description` **按语言直接替换**为精炼文案，写明「做什么 / 不做什么」

---

## 脚本

### `scripts/dsh_plugin_locale.mjs` — 插件页中文化落地

```bash
node scripts/dsh_plugin_locale.mjs --check      # 只读巡检
node scripts/dsh_plugin_locale.mjs --apply      # 写入 locale 文件并补 exports
node scripts/dsh_plugin_locale.mjs --restore    # 从 *.dsh-locale.bak 还原
node scripts/dsh_plugin_locale.mjs --profile <profileDir>
```

文案来源：`references/dsh-plugin-locale-catalog.json`。幂等；写前自动备份。

**机制**（已核实 `@deepseek-ai/dsh-app-boot` `readPluginMeta()`）：DSH 读
`<pkg>/locale/en.json`（英语资源，同时定义同目录语言文件集合）的 `meta.title` / `meta.description`；
缺失才回落 `package.json.name` / `description`。该路径**经包 specifier 解析**，
所以有 `exports` 的包必须导出 `./locale/*`，否则读不到——脚本会自动补上。

### `scripts/dsh_market_search.mjs` — 市场按需检索

```bash
node scripts/dsh_market_search.mjs --need 记忆 --need 搜索 --limit 8
node scripts/dsh_market_search.mjs --need 语音转写 --json
```

只保留**真 DSH bundle**（`package.json` 含 `dsh.bundle.patch`），输出兼容判定 / 许可 /
发布日 / 是否已装启用 / 仓库。需求→关键词映射见 `references/dsh-market-needs.md`。

---

## 范围收敛

`config.yaml`：

```yaml
platform_scope:
  default: "dsh"
  exclude_other_platforms: true
```

- `scan_paths`：4 条，全部 DSH 相关（用户技能根、内置 office 技能、profile 插件、本地化目录）
- `excluded_scan_paths`：8 条（Codex / ZCode / Claude Code），**默认不计入** DSH 的健康度、评分与推荐

DSH 技能根的发现规则：只扫描根**顶层**的 `<name>/SKILL.md` 或 `<name>.md`，
嵌套 `**/SKILL.md` 不发现；六档优先级 100 project-dsh → 600 bundled。

---

## 已知边界

完整优化记录与下一阶段路线见 [docs/optimization-roadmap.md](docs/optimization-roadmap.md)。

- 上游的 `scripts/audit_skill_plugin_issues.py` 仍以 Codex 侧来源为主，且 `config.yaml`
  不参与脚本消费。**脚本级 DSH 采集分支尚未实现**，当前收敛作用于 Agent 行为层。
- 插件页本地化写在 `node_modules` 内，**插件升级 / 重装后会丢失**，重新执行
  `dsh_plugin_locale.mjs --apply` 即可恢复。
- 插件管理能力不再单独占用“治理中心”页面；状态、翻译、版本更新与审查统一回到插件 / 技能主表，避免重复对象列表。安装、启停和卸载仍只调用 DSH 第一方 `pluginManager`，由宿主能力决定是否显示。
- 技能的应用与还原会保留 `.dsh-skill.backup`；随 DSH 提供且没有可写路径的技能只展示来源与状态，不执行写入。
- 所有写操作都有明确的进行中、完成、失败和需要重启反馈；失败结果会带下一步处理建议。
