# ⓪ 前置：配置+记忆+模式

1. **前置目录检查**：确认当前目录存在，是项目根，深度合理
2. **加载 config.yaml**：读取本技能目录下 config.yaml，加载 scan_paths、project_scan、health_thresholds 等
3. **加载项目记忆**：memories/MEMORY.md 存在则读取，不存在则询问用户
4. **模式检测**：
   - 检查触发词是否含 --ci 或子命令 ci → 设置 ci=true
   - CI 模式：无交互、JSON 输出、跳过 ④-bis、max_tokens 预算限制
   - 设置 mode = "skill"（全量）或 "project"（跳过深读+描述优化）
5. **读取 user-profile.md** 用于个性化判定
6. **CI 模式 Token 预算**：max_tokens 取自 config.yaml ci.max_tokens（默认 8000），超限时自动降级（优先跳过 ④-bis → ⑤a → ⑤b）
7. **加载 health_thresholds**：按检测到的 platform 合并 default + per_platform 配置（v5.9.1）
8. **写入门禁**：读取 `write_policy`。阶段⓪至⑥只读；缺失 MEMORY.md、user-profile.md 或缓存时标记 `unavailable`，不得创建文件或请求自动安装。
9. **工具探针**：对关键工具执行无副作用探针（例如 `codegraph --help`、`git --version`）。命令存在但探针失败时按 unavailable 降级，并记录错误摘要；不得仅凭 PATH 命中判定可用。

---
## 下一步

→ [① 项目画像](01-profiling.md)
