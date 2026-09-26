# ② 已安装技能清单（含容量采集 + 能力映射）

使用已加载 config.yaml 中所有 scan_paths，提取每个技能的 name/description/路径/来源/版本号。
同时扫描 MCP 服务器（mcp_config.files），提取服务器+工具列表。去重：同name优先 editable=true→版本高者。

**能力映射**（v6.0.0 — 为推荐引擎建立能力矩阵）：

对每个已扫描到的工具（skill 或 MCP server），加载 `references/capability-dimensions.yaml`：

1. **T0 匹配**：如果工具在 capability-dimensions.yaml 的 tools 列表中，直接读取其能力评分
2. **T1 推断**：如果不在，从工具 tags + description 按关键词规则自动推断能力维度
   - 规则见 capability-dimensions.yaml 底部 mapping 表
   - 推断结果仅保留在本次报告；用户确认保存审计历史后才写入 `.data/auto-capabilities.json`
3. **结果格式**：
   ```yaml
   agent-reach:
     capabilities:
       multi-platform-search: {level: 9, source: "手动精标"}
       web-search: {level: 5, source: "手动精标"}
       # T1 推断示例:
       # content-aggregation: {level: 6, source: "auto-inferred from tags"}
   ```

能力映射数据传递给 Phase ③ 参考数据加载和 Phase ⑤b 推荐引擎。

**容量采集**（同时执行，不额外增加轮次）：

| 采集项 | 采集方式 | 用途 |
|:---|:---|:---|
| SKILL.md 文件大小 | Read → 字节数 / 4 ≈ token 估算 | 估算注入成本，标记 estimated |
| MCP 工具数量 | 解析 mcp_config 配置 | 计算工具池 token 成本 |
| MCP 工具描述长度 | 读取每个工具的 description | 计算 tool listing 成本 |
| Agent 类型 | 从平台特征判定 | 选择计算模型 |

**CI 降级**（v5.9.1）：CI 模式下 token 预算不够时，跳过 MCP 工具扫描以节省 30-50% 开销。

---
## 下一步

→ [②-bis 容量分析](02-bis-capacity.md)
