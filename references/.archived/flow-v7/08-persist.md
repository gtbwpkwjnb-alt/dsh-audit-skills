# ⑧ 持久化

仅持久化用户在⑦-b确认过的画像、统计、日志、缓存、快照或自检缺陷追踪；未确认时跳过本阶段。

**缓存GC**：清理 .data/external-signals-cache.json 中不在当前技能列表的条目。
**快照GC**：清理超过 retention_days 的旧快照。
**画像刷新**（v5.9.1）：.data/project-profiles.json 超过 auto_refresh_days → 自动重新画像。

未确认导致的跳过不是失败；已确认的持久化失败必须报告失败项，不能声称保存成功。

---
## 下一步

✅ 流程结束。返回 [索引](../execution-flow.md)

