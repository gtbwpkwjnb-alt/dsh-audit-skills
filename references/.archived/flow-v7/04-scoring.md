# ④ 三级分层+八维评分（质量信号联动 + Forma 格式分）

**分层**：T1核心→保留 · T2通用→保留 · T3专业→建议归档

**使用信号读取**（v8.1.0 — 结构化 Codex session/tool-call 事件）：

在评分前，按 `config.yaml usage_signals.source` 读取 `session_index.jsonl` 与对应 rollout JSONL，只统计显式 skill/tool 调用事件。系统提示、skill catalog、原始 user 文本或历史摘要中的名称不算使用证据。

```
解析规则:
  1. 以 session_index 的更新时间筛选最近窗口
  2. 只读取对应 rollout 中的显式 skill/tool 事件并保留 provenance
  3. 可归因调用 ≥5 → pass；1–4 → warn；0 → unavailable
  4. unavailable 不回填分数、不判定 zombie、不触发 P1 缺口搜索
```

**降级策略**（v8.1.0）：
- 若 session_index/rollout 路径不存在、解析失败或无法建立 provenance → 使用信号为 `unavailable`，不使用回填分数
- 不触发 P1 缺口搜索，社区 Feed 步骤跳过使用缺口分支
- 报告中标注「使用证据 unavailable」，不影响其他维度评分或推荐排序
- 降级不扣 Forma 分，也不降低工具质量评分

使用信号影响：
- 只为 Fit/Value 的实际频率提供 evidence；低频不等于低质量
- 没有可归因调用时保持 unavailable，不自动归档或搜索替代品

**八维评分（S/A/B/C/D + 强制理由）**：

| 维度 | 权重 | 标准概要 |
|:---|:---:|:---|
| Fit 项目匹配 | 30% | 命中≥2核心活动=S |
| Value 预期价值 | 20% | 命中核心活动+高频=S |
| Fresh 版本时效 | 15% | 外部 release/更新时间为 observed 时评分；仅本地 registry 时仅输出 registry 对齐 |
| Community 外部信号 | 15% | 外部信号为 observed 时才评分；搜索关闭或无缓存时 unavailable |
| ROI 成本效益 | 8% | 只按已列公式和输入估算；输入缺失时 unavailable |
| Novelty 新颖性 | 6% | 独特无替代=S |
| Contamination 污染 | 1% | 纯目标语言=S |
| **Forma 格式分** | **5%** | **描述格式规范·语言一致性·长度合规·信息密度** |

每个维度同时输出 `observed`、`inferred`、`estimated` 或 `unavailable` 状态。`unavailable` 维度不参与综合分；报告必须列出有效权重和，禁止用默认分替代。

综合 = Fit×0.30 + Value×0.20 + Fresh×0.15 + Community×0.15 + ROI×0.08 + Novelty×0.06 + Contamination×0.01 + Forma×0.05
≥4.0→S · ≥3.0→A · ≥2.0→B · ≥1.5→C · <1.5→D

**Forma 格式分（v6.2.0）** — 描述格式质量专项，解决中英混搭/超长描述/无规范格式问题。

| 检查项 | 权重 | 0分 | 5分 | 10分 |
|:-------|:----:|:---|:---|:----|
| 格式规范 | 40% | 无格式/纯段落 | 基本箭头但缺内容 | `主题 → 功能1·功能2` |
| 语言一致性 | 30% | 中英混搭严重 | 偶有英文残留 | 全中文（标准缩写除外） |
| 长度合规 | 20% | >80字符 | 41-80字符 | ≤40字符 |
| 信息密度 | 10% | 含使用说明/触发条件 | 含轻微冗余词 | 纯功能短语，无杂质 |

Forma 评分 = 格式规范×0.40 + 语言一致性×0.30 + 长度合规×0.20 + 信息密度×0.10

**质量信号联动**：如果 description-quality.md 检测到问题，Forma 自动扣 1 档。

> 🔄 旧版七维 → 八维迁移说明（v6.2.0）：
> - ROI 从 10% → 8%（-2%），Novelty 从 7% → 6%（-1%），Contamination 从 3% → 1%（-2%）
> - Forma 新占 5%，权重来源合理
> - 旧审计快照保留原七维分数，不做回溯转换

**安全子项**（融入 Value）：只有实际扫描结果为 `observed` 时才调整档位；未运行时状态为 `unavailable`，不得加分。

---
## 下一步

→ [④-a T3 验证](04-a-t3-validation.md)
→ [④-bis 深度阅读](04-bis-deepread.md)
