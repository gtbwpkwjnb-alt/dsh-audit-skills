# audit 定位与优化方向

## 定位

`audit` 应作为“插件与技能治理中心”，而不是第二个插件商城。市场检索、排行和推荐已经由 DSH 生态中的市场插件覆盖；`audit` 的差异点是把来源、兼容性、中文文案、更新状态和可逆操作放在同一份可解释快照里。

## 研究结论

- VS Code Extension Marketplace 的核心体验是来源、版本、安装状态和明确的启用反馈，适合借鉴信息架构，不适合复制商城规模。
- Claude Code Plugins / Plugin Marketplaces 把安装来源、插件包和启用生命周期分开，说明“发现”和“治理”应分层。
- DSH 第一方 `pluginManager` 已提供 `listBundles`、`listPlugins`、`inspect`、`installBundle`、`setBundleEnabled`、`setPluginEnabled` 和 `removeBundle`，应作为唯一写入口。
- DSH 现有社区插件已经覆盖市场、冲突守护和更新器；重复建立排行或包管理器会增加冲突面。

## 页面结构

设置页保留三个平级入口：

1. **插件**：版本快照、中文化、更新检查、审查发现。
2. **技能**：来源作用域、描述语言、git 修订、翻译应用与备份还原。
3. **治理中心**：安装预检、bundle 启停/卸载、运行插件条目启停，以及技能管理摘要。

治理中心不显示不可执行的危险按钮。内置、受保护或非 `removable` 的 bundle 只展示原因；卸载必须二次确认。

## 交互规则

- 写操作统一显示“检查中、执行中、已完成、未变化、失败、需要重启”。
- 安装流程先 `inspect()`，预检拒绝时展示原因和建议，不直接调用安装。
- 翻译与技能还原保留备份；失败结果包含下一步处理方式和重试入口。
- 状态文字不能只依赖颜色，按钮在不可用时置灰并说明原因。
- 所有管理动作由宿主串行执行，客户端只发起请求、轮询并刷新快照。

## 来源

- [VS Code Extension Marketplace](https://code.visualstudio.com/docs/editor/extension-marketplace)
- [Claude Code Plugins](https://docs.anthropic.com/en/docs/claude-code/plugins)
- [Claude Code Plugin Marketplaces](https://docs.anthropic.com/en/docs/claude-code/plugin-marketplaces)
- [DeepSeek Harness plugin-manager](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/boot/plugin-manager)
