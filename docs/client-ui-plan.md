# 客户端半体实现计划（v1.2.0 待真机验证）

v1.1.0 只发布宿主半体。以下 API 均已从**在装插件源码**核实，实现属机械工作；
但必须先真机验证再发布（对抗审查 T1）。

## 已核实 API

| 需求 | API 形状 | 来源 |
|---|---|---|
| 设置页「技能审查」分区 | `ctx.slots.inject("settings.section", () => ctx.slots.register({ name, id, order, label: () => t(...), inject: () => ({...}) }, Section))` | dsh-better-sidebar client.js:17686 |
| 插件页卡片（激活翻译按钮） | `ctx.slots.inject("plugins.row.config", () => ctx.slots.register({ name: "plugins.row.config", key: "<包名>#<patch 行 id>" }, (slotProps) => slotProps?.view === "summary" ? summary : h(Card, { page: true })))` | dsh-free-search client.js:1143 |
| 侧边栏卡片（用户可自行增删） | `ctx.betterSidebar.registerTab({ id, title, component })`，需 `inject: ['betterSidebar']`，**可选依赖** | dsh-better-sidebar README:186 |
| 第一方右侧栏 tab | `ctx.sidebarRightTabs` / `ctx.sidebarRight` | dsh-better-sidebar README:4 |
| 客户端 → 宿主通道 | 宿主：`ctx.inject(["webServer"], (sctx) => sctx.webServer.register(route))`；客户端 `fetch("/api/<name>")` | dsh-free-search index.js:2100 |

## 关键约定（踩坑记录）

- **rowConfigKey = `<包名>#<patch 里声明的行 id>`**。本插件的行 id 是 `dsh-audit-skills`。
- ui-commands 的 `description` 必须是**函数**，传字符串会抛 TypeError 并让整份 `/` 候选列表一起失败。
- 所有注册包 `try { } catch (e) { fail("load", e) }`，让失败局限在本插件，不拖垮设置页。
- 用 `createElement` 直接写，避免引入构建链。
- `betterSidebar` 是可选依赖：没有它时只降级为设置页分区，不得报错。

## 按钮组（设置页「技能审查」）

| 按钮 | 动作 | 归属 |
|---|---|---|
| 应用翻译精炼 | `applyLocale()` | 自研（主功能） |
| 还原翻译 | `revertLocale()` | 自研 |
| 刷新状态 | `collectStatus()` | 自研（读第一方数据） |
| 冲突风险报告 | 读 peers + 激活态，**只出报告** | 自研（不自动停用，避免 T4 三方打架） |
| 检查更新 | 委托 `dsh-updater-ui` / `dsh-purge` | **委托** |
| 找插件 | 委托 `find_dsh_plugins` / `dsh-recommend` | **委托** |
| 崩溃防护 | 建议安装 `dsh-conflict-guardian` / `dsh-my-guardian` | **委托** |

## 发布前验证清单

1. 设置页出现「技能审查」分区，页面其余部分不受影响。
2. Plugins 页本插件行出现卡片，按钮可点。
3. 点「应用翻译精炼」→ 刷新页面 → 其他插件卡片文案变中文。
4. 停用本插件 → 翻译还原；再启用 → 重新应用。
5. 故意让 client.js 抛错 → 只有本插件失效，设置页与 Plugins 页仍可用。
