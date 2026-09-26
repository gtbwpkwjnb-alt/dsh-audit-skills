# ⑤c 安装作用域决策

对每个“可安装”候选执行本阶段。读取 `config.yaml` 的 `scope_targets` 与 `recommendation_scope`；平台路径未知时不得猜测。

| 条件 | 作用域 | 行为 |
|:---|:---|:---|
| 依赖当前仓库代码、团队规范、CI、项目密钥或单项目工作流 | `project` | 仅建议写入已识别的项目目录 |
| 不访问项目私有数据，且在至少两个项目有复用证据 | `global` | 仅建议写入用户级目录 |
| 插件缓存或系统内置能力 | `plugin` | 只读审计，建议通过官方插件渠道更新 |
| 证据、路径或兼容性缺失 | `defer` | 不生成安装命令 |

推荐输出必须包含以下字段：

```yaml
install_scope: project | global | plugin | defer
target_path: ".agents/skills/example" # plugin/defer 时为空
scope_reason: "命中当前仓库 CI 工作流，不能污染全局库"
compatibility: {agent: "codex", verified: true, evidence_url: "..."}
confirmation_required: true
```

先逐项展示来源、作用域、目标路径、校验方式与风险；用户确认后才创建快照并执行。未确认时只输出建议。
