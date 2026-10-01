# 设计边界判定 (v1.1 规划)

方法：`/luopan`（输出判断而非百科，逐条标信源等级）· `/ponytail`（复用优先，首个可行层级停止）· `/ruofeng-adversarial-review`（先攻击再实现）

---

## 1. 用户需求边界

### 真实痛点（按严重度）

| # | 痛点 | 证据等级 |
|---|---|---|
| P1 | **装插件导致 DSH 崩溃 / 冲突**，且不知道哪个插件干的、怎么恢复 | A（用户原话「用户插件安装容易导致插件冲突，dsh 系统崩溃」） |
| P2 | 插件页说明是英文/原始 npm 长文案，**看不懂装了什么、有什么副作用** | A（用户原话 + 本机实测 7 个插件 5 个无 locale） |
| P3 | 不知道自己装了什么、该不该留 | B（由 P2 推导） |
| P4 | 想要**一键开关**控制插件效果，而不是改文件 | A（用户原话） |

### 明确排除（非需求）

- 不做插件市场本体（已有 dshmarket 4600★、DSH-Plugins-Marketplace 167★）
- 不做插件开发脚手架（已有 make-dsh-plugin / vlln/plugin-console）
- 不做包管理器（pnpm 已足够，DSH 已封装）
- 不做 LLM API 审计（api-relay-audit 858★ 已覆盖）

### 需求分级

- **必须**：看懂（中文化）· 可控（开关）· 不崩（冲突防护）
- **应该**：可诊断（状态/冲突报告）· 可回滚
- **可选**：画像标签 · 生态推荐

---

## 2. DSH 功能范围边界

### 插件**能**做（已核实）

| 能力 | 依据 |
|---|---|
| bundle 安装后，**第一方 Plugins 页自动给卡片 + 启停开关** | dsh-plugin-manager `listBundles`/`EnableSwitch` |
| 卡片标题/描述来自 `locale/<lang>.json` 的 `meta.title/description` | dsh-app-boot `readPluginMeta()` lib/index.js:1968 |
| 声明 `dsh.client` → 加载浏览器半体；可 inject `dsh-client-ui-settings` / `dsh-client-ui-plugin-manager` / `dsh-client-ui-sidebar-right` | dsh-context / dsh-free-search 实测 |
| 读插件状态：`ctx.loader.entries()` / `PluginPackages` / `readPluginInventory` | 第一方 `dsh-host-plugin-inventory` |
| settings 卡 + 按钮，并可 **settings mutate 写 profile `cordis.patch.yml`** | dsh-free-search 实测（`/api/dsh-free-search-settings`） |
| `apply()/dispose()` 随启停执行 → 开关可挂副作用 | Cordis 生命周期 |

### 插件**不能**做（硬边界）

1. **无法在插件加载前拦截**——不能阻止宿主挂载一个坏插件。防护只能是**事后诊断 + 建议/自动停用**。
2. **无法在 Plugins 页新增页签**——只能扩展既有页或新增 settings 分区。
3. **无法通过 profile 覆盖别家插件的展示文案**——`readPluginMeta` 只读包目录，没有配置覆盖点。
4. **写 `node_modules` 内文件会被升级/重装覆盖**，且不受 lockfile 保护。
5. **`desktop` profile 由应用独占**——CLI 被拒；写 profile 必须走 settings mutate 或插件管理器。

---

## 3. 生态市场边界（已有轮子盘点）

信源：`find_dsh_plugins`（聚合 dsh.so 5336 / dsh.works 13223 / 岚叔 655 / awesome 4353 / radar 293 / npm / GitHub topic，池 15618）

| 目标功能 | 已有实现（星数） | 判定 |
|---|---|---|
| **冲突检测** | baisama-cloud/dsh-conflict-guardian · MutaLucem/dsh-plugin-integration · Zhenyu98/dsh-context-doctor · omdsh-dev/dsh-plugin-check(26) | **不自研**：读第一方 loader 数据即可；检测能力建议**委托/推荐**上述之一 |
| **插件状态监控 / 启停** | Noob-stupid/dsh-plugin-hub(92) · dshmarket(4600) · 2768651338/dsh-plugin-manager | 启停**第一方已给**；状态数据用第一方 API |
| **插件页中文化** | 2768651338/dsh-plugin-manager（**自有页面**中文名+白话描述）· RadicalGitter/dsh-ui-translate（浏览器机翻 UI）· yyyyukari/dsh-plugin-workshop（描述机翻） | ✅ **本插件唯一真实差异点**：写 `locale/*.json` 让**内置 Plugins 页原生**显示（非另起页面、非机翻、随开关应用/还原） |
| **设置页按钮** | omdsh-dev/ex-setting · PerryLink/dsh-mcp-panel(66) · xingyingyuzhui/dsh-updater-ui · **dsh-free-search 的设置卡** | **复用第一方 UI 槽**，照抄 free-search 范式 |
| **更新检查** | xingyingyuzhui/dsh-updater-ui · YuJunZhiXue/dsh-purge(2288) · omdsh-dev/dsh-plugin-check | 委托；本插件只做**入口汇总** |
| **推荐 / 排行** | zp-home/dsh-recommend(21) · dshmarket · DSH-Plugins-Marketplace(167) · vlln/plugin-console(58) · 第一方 `find_dsh_plugins` | **委托**，不建第二个排行 |

**市场结论**：生态已高度饱和，**唯一未被满足的差异点是「让内置 Plugins 页原生中文化 + 作为开关中枢」**。其余一律复用或委托。

---

## 4. audit 插件功能边界

### 做（4 项，其中仅 1 项自研）

| 代号 | 功能 | 性质 |
|---|---|---|
| **F1** | 内置 Plugins 页**原生中文化**（写 `locale/{en,zh}.json` + 补 `exports`），**随插件启停应用/还原** | 🔬 自研（唯一差异点） |
| **F2** | 插件状态与健康**汇总**（只读第一方数据：激活状态、版本、peer 兼容、locale 缺失、上游更新可查） | 🔁 复用第一方 API |
| **F3** | 冲突威胁**评估与建议**（peer 不满足、同槽抢占、配置行 id 重复、加载失败）——**只出报告，不自动停用** | 🔁 复用数据 + 委托执行 |
| **F4** | 设置页「技能审查」**按钮控制台**（翻译精炼/还原、刷新状态、兼容性报告、更新检查入口、需求检索） | 🔁 复用第一方 settings 槽 |
| **F5** | **治理中心**（第一方 `inspect` 预检安装、bundle 启停/可卸载判断、运行条目启停、技能来源与备份还原） | 🔁 只调用第一方 manager / 既有技能写入链 |

### 不做

- ❌ 市场索引 / 排行 / 评分模型 → 委托 dshmarket、dsh-recommend、`find_dsh_plugins`
- ❌ 自建包管理器、市场排行或版本回滚 → 委托第一方 pluginManager 与生态插件
- ❌ 启动期守护 / 自动停用 → 委托 dsh-conflict-guardian、dsh-my-guardian
- ❌ 规则集管理（AGENTS.md / prompt-inject.md）→ dsh-purge 已覆盖

---

## 5. 每项功能实现边界

| | F1 中文化 | F2 状态汇总 | F3 冲突评估 | F4 控制台 | F5 治理中心 |
|---|---|---|---|---|---|
| 输入 | catalog JSON + profile 路径 | loader entries / listBundles | peers + 激活态 + patch id | 用户点击 | spec、bundle/plugin/skill 标识 |
| 输出 | `<pkg>/locale/*.json` + `exports` 补丁 | 只读表格 | 风险清单（附证据） | 触发 F1–F3 | 第一方 ChangeResult 与能力矩阵 |
| 依赖 | node:fs | 第一方 inventory API | 同上 + 版本比较 | client-ui-settings | pluginManager + 技能扫描 |
| 失败模式 | 包未装→跳过；包被 pnpm 覆盖→重新应用 | API 缺失→显示 unavailable | 无证据→不排序 | 只读降级 | inspect 拒绝、只读/不可移除、需重启 |
| 验证 | resolve `locale/en.json` | 与 Plugins 页一致 | 报告可复现 | 页面可渲染 | 管理快照与 HTTP bridge 契约 |
| 回滚 | `--restore` / dispose 还原 | 只读，无需回滚 | 只读 | 只读 | 技能只从备份还原；bundle 卸载由第一方执行 |
| **不做** | 不机翻、不另起页面 | 不自己扫描磁盘 | **不自动停用** | 不引入隐式写操作 | 不绕过 `inspect`，不删除不可移除 bundle |

---

## 6. 对抗审查（/ruofeng-adversarial-review）

### 确认的威胁

**🔴 T1 自指崩溃（致命 / 触发概率中）**
- 破绽：一个"防崩溃"插件若自身抛异常，会成为最难恢复的插件——用户装它就是为了防崩，结果它崩。
- 后果：DSH 启动失败，且用户不知道该禁用谁。
- 加固：`index.js` **零第三方依赖**；`apply()` 内全量 try/catch，**任何异常吞掉并降级为只读**，绝不 throw；不注册任何阻塞型 hook；不写 system prompt。

**🔴 T2 写 node_modules 的脆弱性（致命 / 必然发生）**
- 破绽：locale 写在 `node_modules/<pkg>/` 内，`pnpm install` 与插件升级都会覆盖；且不受 lockfile 保护。
- 证据：本机实测——`dsh-web-fetch-playwright`、`@linxin666/dsh-remote-web-ui` 卸载后 catalog 条目立即变 MISSING。
- 加固：① 默认**不自动写**，只在用户点按钮时写；② 写入前后各留 manifest，`--restore` 一键还原；③ **明确文档化"升级后需重新应用"**；④ 不宣称持久。

**🟡 T3 开关语义歧义（严重 / 必然）**
- 破绽：用户预期"关闭插件 = 翻译消失"，但已写入的 locale 文件在卸载后仍然存在 → 翻译还在。
- 加固：`dispose()` 默认还原（可配置保留）；UI 上明写"关闭并还原 / 关闭但保留"。

**🟡 T4 三方守护互相打架（严重 / 偶发）**
- 破绽：若用户同时装 dsh-my-guardian + dsh-conflict-guardian + 本插件，三者都可能去改 `dsh.profile.bundles`，互相覆盖。
- 加固：本插件**默认完全只读**，不碰 bundles 列表；只在用户显式点击且已确认无其他守护时，才输出"建议动作"由用户/他插件执行。

**🟢 T5 desktop profile 写入受限（一般 / 必然）**
- 破绽：设置页按钮若试图直接改 `package.json`，会被应用独占保护挡住。
- 加固：写操作只走第一方 **settings mutate → `cordis.patch.yml`** 通道（free-search 已验证可行）。

**🟢 T6 审计面板自身的上下文成本（一般 / 可控）**
- 加固：不注入 system prompt；状态数据只在用户打开面板时按需拉取。

### 排除的伪问题

1. "插件多会拖慢启动" —— 每条 entry 成本极低，且已有 dsh-context-doctor 度量，不构成本插件的理由。
2. "中文化会改变插件行为" —— locale 只影响展示层，已核实。
3. "设置页按钮需要新权限模型" —— 第一方 settings 槽已提供，无需自造。

### 未覆盖的攻击面

- 未做真实并发/竞态压测（pnpm 安装与 locale 写入同时进行）
- 未验证 DSH 0.1.8+ 的 `readPluginMeta` 是否变更
- 未审计第三方依赖（本插件计划零依赖，故风险面很小）

---

## 7. 最小实现路径（/ponytail）

按阶梯，**首个可行层级即停**：

1. **不做**：市场、排行、守护、更新执行 —— 全部已有轮子
2. **复用**：第一方 Plugins 页（卡片+启停）· `dsh-client-ui-settings` 槽 · `readPluginInventory` · free-search 的 settings 卡范式 · 已发布的 `dsh_plugin_locale.mjs` 逻辑
3. **新增仅 3 个文件**：
   - `client.js` —— 设置页「插件与技能审查」（页内上方切换插件/技能）+ 状态表 + 翻译优化
   - `index.js` 扩展 —— locale 应用/还原 + 状态/审查工具 + 技能 SKILL.md 改写与还原（**零依赖**）
   - `locale/{en,zh}.json` —— 本插件自身也遵循同一命名约定
4. **交付** v1.1.0

---

## 8. 待用户拍板的 3 个边界决策

| # | 问题 | 建议 | 理由 |
|---|---|---|---|
| Q1 | 关闭插件时，是否自动把翻译**还原**？ | **是**（默认还原，可开关） | 否则 T3 语义歧义成立 |
| Q2 | 冲突检测要不要"**自动停用**"坏插件？ | **否**，只出报告 + 一键建议 | 避免 T4 三方保护打架；停用有让用户丢功能的风险 |
| Q3 | 更新检查 / 推荐 / 守护 是自研还是**委托**已有插件？ | **委托**，本插件只做入口汇总 | 生态已饱和，自研=重复造轮子 |

三项确认后即可进入实现。
