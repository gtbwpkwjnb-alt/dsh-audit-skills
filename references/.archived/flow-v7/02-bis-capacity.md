# ②-bis 容量分析引擎

> 核心诊断：多因子有效容量计算（v5.9.1 增强）

```text
token预算容量 = (上下文可用空间 - 固定消耗) / 单 skill 平均注入成本
有效容量 = min(token预算容量, 技能上下文容量×冲突因子, 认知容量)

冲突因子 = 1 - (contamination均分 / 5 × 0.3)
认知容量 = max(3, min(15, activity_count × 2))
```

所有容量结果均为 `estimated`：文件字节/4、平台 listing 预算和认知容量不是实际注入 token。缺少上下文上限、固定消耗或加载策略时输出 `unavailable`，不输出“还能安装几个”的确定结论。

**各 Agent 模型**：

| Agent | 上限约束 | 有效容量适用 |
|:---|:---|:---:|
| CodeBuddy | 16K 硬限制 | ✅ |
| Claude Code | skillListingBudget=1%×200K=2000t | ✅ |
| Cursor | 动态，无固定上限 | ✅ |

**分级判定**：
```text
可再装 ≥ 5 → 🟢 · 2-4 → 🟡 · 1 → 🟠 · 0 → 🔴
```

**CI 降级链**（v5.9.1）：剩余 token < 2000 时跳过容量分析，输出 capacity_analysis: skipped (budget)。

---
## 下一步

→ [②-ter 活性检测](02-ter-liveness.md)

