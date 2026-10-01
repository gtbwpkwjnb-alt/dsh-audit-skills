# 界面模式调研：悬停预览 / 页签 / 内置行

本轮（v2.10.5）按用户要求「参考插件市场与排行榜前 30」做了一次**有预算的**调研，结论直接落进代码。
下面记录证据与取舍，方便下次改动时不重复烧 token。

## 证据台账

| 结论 | 来源 | 观察时间 | 支撑什么 | 局限 |
|---|---|---|---|---|
| 排行榜数据在本地就有，无需联网 | 本机 `dsh-plugin-marketplace/registry.json`（15MB，`repos` 数组 15,443 条，字段含 `stargazers_count`/`market_tags`/`risk_tier`） | 2026-10-01，文件 `generated_at=2026-10-01T05:19:55Z` | 前 30 名按 stars 排序即可拿到，零网络开销 | stars ≠ 界面质量；前 30 里多数不是 DSH 客户端 UI 插件 |
| 前 30 名（按 stars）示例 | 同上：`nexu-io/open-design` 98960、`tt-a1i/archify` 75353、`ruvnet/ruflo` 73590 … `dsh-market/dsh-market` 5163 | 同上 | 说明「排行榜前 30」的构成：以通用工具/记忆类为主 | 不能据此挑选 UI 模式 |
| 本机带 `dsh.client` 的插件只有 4 个 | 扫描 `profiles/desktop/node_modules` 中声明 `dsh.client` 的包 | 2026-10-01 | 真正可比的是**同 shell 里正在跑**的 DSH 客户端插件 | 样本小（4 个） |
| 其中唯一的浮层实现：`@changfenhuang/dsh-annotation`（客户端 98KB，`fixed=10 / getBoundingClientRect=10`） | 其 `client.js`：`.dsh-ann-card { position: fixed; z-index: 1201; width: 400px; max-width: calc(100vw - 16px) }`；定位逻辑 `belowTop = rect.bottom + 8; belowFits = belowTop + height <= window.innerHeight - 8;` 放不下则 `top = rect.top - height - 8`，再 `Math.max(8, Math.min(top, window.innerHeight - card.offsetHeight - 8))`；`left` 同理钳制 | 2026-10-01 | **借用的模式**：固定定位 + 行矩形 + 下方优先/上方回落 + 双轴钳制视口 | 它是无框架 DOM 脚本（可 append 到 body），我们在 React 里没有 portal，所以改为在树内用 `position: fixed` 并加 `maxHeight` 内部滚动 |
| `dsh-plugin-marketplace` 客户端不经普通 `.js` 交付（`dsh.bundle.patch` → `cordis.patch.yml` 只声明注入 `webServer`） | 其 `package.json` 的 `dsh` 段与 `cordis.patch.yml` | 2026-10-01 | 无法低成本读到它的页签实现细节（721KB 包里最大文件是测试） | 因此「参考插件市场」只落到**结构结论**：主切换器在最上方、独立且紧凑 |

## 借用的做法（v2.10.5 已实现）

1. **悬停详情卡改成锚定浮层**：`position: fixed` + `placeCard(rect, estH, cardW)`（下方优先 → 上方回落 → 双轴钳制 → `maxHeight` 内部滚动）。
   副作用是**净赚高度**：原来表格下方有一个固定槽位（`min-height: 52px` + 常驻提示），现在没有详情行时完全不渲染。
2. **页签与标题并成一行**：`Merged` 造好 `.das-seg` 传给 `Panel`，`Panel` 把它放进 `.das-head` 首个子节点；
   `.das-head` 从纵向居中改成 `flex-wrap` 横向，`.das-sub` 用 `flex-basis: 100%` 独占第二行。头部由 3 行压到 2 行。
3. **随 DSH 提供的对象默认隐藏**，并在指标带上给出数量与开关（`随 DSH 提供 N · 点此显示/隐藏`）——
   不静默隐藏，也不假装它们不存在。

## 明确没做的（以及为什么）

- 没有把悬停卡 append 到 `document.body`（本机可比对象那样做）——React 侧没有 `react-dom`，只能 `require('react')`；
  用 `position: fixed` + 钳制 + `maxHeight` 已足够，且避免引入依赖。
- 没有为「内联展开」「右侧抽屉」做额外实现：现有「点展开钉住」已覆盖需要长驻的场景。
- 没有按 stars 排行挑选实现去抄：排行榜只用来确认生态构成，模式选择依据是本机可比对象的真实代码。
