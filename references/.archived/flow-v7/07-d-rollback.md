# ⑦-d 回滚操作（v5.9.1）

技能审查 --undo <snapshot_id> 或 技能审查 回滚 <snapshot_id>：

1. 查找 {snapshot.dir}/{snapshot_id}/
2. 展示变更清单（对比快照与当前状态）
3. 用户确认后恢复
4. .data/stats.json 记录 olled_back: true
5. 输出：↩️ 已回滚至 {snapshot_id}

--undo --list：按时间倒序列出可用快照。

---
## 下一步

← [⑦-c 执行](07-c-execute.md)
