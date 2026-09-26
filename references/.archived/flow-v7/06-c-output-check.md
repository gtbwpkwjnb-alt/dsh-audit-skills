# ⑥-c 报告输出强制检查

确认报告已输出、评分表已生成，并满足 `references/output-contract.md`：

1. 每个健康度、收益、容量、趋势和推荐结论都有事实状态与证据或限制。
2. `unavailable` 数据已列出，未被默认分数或样例数字替代。
3. 操作全部标为 `[需确认]`，报告中声明本轮未写入文件。
4. `report_status` 只能为 `complete` 或 `partial`；不得使用无证据的 `verified=true`。
5. Forma 检测发现不合格 description 时，必须输出“描述精炼候选”表；缺失则报告标记 `partial` 并阻止进入⑦执行阶段。
6. `技能审查 精炼` 必须输出 `📋 Codex 命令栏与侧边栏中文翻译清单`；插件 cache、runtime 和 remote catalog 项必须为“仅清单，不写入”。
7. 必须输出 `🛠 建议执行` 与 `技能审查 深度` 入口；翻译积压、GitHub 候选或可运行性缺口不得只报数字而无优先级、验证方式和确认边界。

任一检查失败，报告标记 `partial` 并阻止进入⑦执行阶段。

---
## 下一步

→ [⑦-a 快照备份](07-a-snapshot.md)
