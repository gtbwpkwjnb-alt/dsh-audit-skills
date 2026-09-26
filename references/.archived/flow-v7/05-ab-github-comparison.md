# ⑤-ab GitHub 同类项目横向对比

仅在 `community_feed.enabled=true` 且用户明确同意本次联网查询时执行。此阶段只生成建议，不安装、更新或写入任何目标目录。

## 候选与证据

1. 从能力缺口生成 GitHub 查询；每个缺口至少保留 2 个同类候选，不足 2 个则输出“候选不足”。
2. 对每个候选记录可复查 URL、抓取时间、仓库 README/manifest、GitHub 元数据和 release/commit 活跃度。
3. 无许可证、已归档、缺少安装说明或目标 Agent 不兼容的候选只能列为风险项，不能推荐安装。

## 固定比较表

| 字段 | 取证方式 | 结论规则 |
|:---|:---|:---|
| 能力覆盖 | README/`SKILL.md` 与能力维度映射 | 仅计入有原始链接的声明 |
| 活跃度 | 最新 release 或 `pushedAt` | 超过 180 天无活动标记陈旧 |
| 许可证 | GitHub license/仓库 LICENSE | 未知则阻断安装建议 |
| 兼容性 | 平台目录与安装文档 | 未声明目标 Agent 视为未知 |
| 安全与供应链 | 安装命令、权限、依赖来源 | 远程执行或提权命令必须标红 |
| 成本与作用域 | 注入成本、数据访问、复用范围 | 决定 project/global/defer |

## 决策

每项候选必须输出：`comparison_id`、`evidence_urls`、`confidence`、`relationship`、`install_scope`、`target_path`、`risk_notes`。

- `confidence < 7`、证据字段缺失或安全风险未解决：仅标记“评估中”。
- 只有在能力提升、兼容性、许可证和安全检查均通过时，才能进入安装候选清单。
- 相同能力的候选按证据完整度优先，再比较活跃度和成本；不得只以 stars 排序。

## 输出示例

```text
web-search: 现有工具 5/10
候选 A / B: 证据完整、许可证已知、均兼容 Codex
结论: A 与现有工具互补，scope=project，原因=仅服务当前仓库的抓取流水线
操作: [需确认] 安装前展示 target_path、来源 URL、校验方式与风险
```

