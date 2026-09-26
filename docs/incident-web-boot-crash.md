# 事故复盘：客户端半体导致 web-boot 崩溃（v1.2.0 → v1.2.1）

日期：2026-09-26 · 严重度：**致命（DSH GUI 无法启动）** · 影响版本：1.2.0

## 现象

安装 v1.2.0 后重启，DSH 起不来。崩溃日志：

```
crash-2026-09-26T09-43-21-823Z-web-boot.log
source: web-boot
Error: web boot: 1 entry did not activate
dsh-audit-skills: import failed (see console for the import error)

--- renderer console ---
dsh-app://app/plugins/??dsh-audit-skills/client.js&rev=de701a0df9fa:11
Uncaught SyntaxError: Cannot use import statement outside a module
```

## 根因

DSH 的客户端插件通过 `dsh-app://app/plugins/??<pkg>/client.js` 加载，**加载方式等同传统
`<script>`，没有 `type="module"`**。这也是为什么所有生态插件的客户端都产出**打包后的
单文件**（rolldown/tsdown 输出），而不是带顶层 `import` 的裸 ESM。

v1.2.0 的 `client.js` 首行就是 `import { createElement as h, ... } from 'react'` → 浏览器直接
抛语法错误 → 该 entry 无法激活 → **web boot 失败**。

## 关键教训（纠正了此前的错误认知）

| 半体 | 加载失败的表现 | 严重度 |
|---|---|---|
| 宿主 half（`index.js`） | `1 entry did not activate`（warning），DSH 继续运行 | ⚠️ 可降级 |
| **客户端 half（`client.js`）** | **`web boot: 1 entry did not activate`，GUI 完全起不来** | 🔴 **致命** |

因此**客户端半体的发布门槛必须高于宿主半体**：没有真机验证 + 没有构建链，就不能发。

## 修复

1. 移除 `dsh.client` 与 `./client` export → 回退为纯宿主形态。
2. `client.js` 移入 `src/`，文件头标注"尚不可直接加载"。
3. 用户侧恢复：从 `dsh.profile.bundles` 删除本插件行，重启即可。

## 后续若要恢复 UI

需要引入构建链（rolldown/tsdown）产出 `lib/client.js`，并满足：
1. 产物必须是**无顶层 import 的传统脚本**（或 IIFE 包裹）。
2. 先在**独立 profile**（非 desktop）上验证 web boot 成功，再上 desktop。
3. 保留 `docs/client-ui-plan.md` 的 5 条验证清单。
