# ① 项目画像

只扫描当前工作目录。提取：目录信息→关键文件→文件特征→构建多维画像（类型/用途/活动/技术栈/兴趣/痛点/入口）。

**痛点必须来自数据源，禁止猜测**。默认只在报告中输出画像和证据；`project_profiles.auto_persist=true` 且用户明确确认后，才能写入 `{project}/.agents/project-profile.md`。

**画像过期检查**（v5.9.1）：如果已有 `.data/project-profiles.json` 超过 `auto_refresh_days`，标记“画像可能过期”；重新画像仍默认只读。

---
## 下一步

→ [② 技能清单](02-inventory.md)
