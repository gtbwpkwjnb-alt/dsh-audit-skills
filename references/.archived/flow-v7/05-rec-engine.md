# ⑤b 推荐引擎 — 能力矩阵驱动（v6.0.0）

**输入**：Phase ② 能力映射 + Phase ④ 质量信号 + Phase ⑤-aa 社区 Feed + Phase ⑤-ab 横向对比

**输出**：每项推荐附带能力对比证据链 + 互补性分析 + 信心指数(0-10)+ROI

---

## 推荐逻辑（能力优先，不再分 A/B/C 硬分层）

### 步骤 1：能力覆盖度分析

对比"项目所需能力" vs "已装工具的能力矩阵"：

```
项目核心活动 → 所需能力列表
  例: "搜索调研" → [web-search, multi-platform-search, research]

已装工具能力 → 实际覆盖
  agent-reach:  multi-platform-search(9), web-search(5)
  覆盖度: multi-platform-search 100%, web-search 50%

缺口: web-search 能力只有 5/10（因依赖 WebFetch，质量评分 4/10）
```

### 步骤 2：社区替代匹配

从 Phase ⑤-aa 社区 Feed 的候选池中，找能填补缺口能力的工具：

```
缺口 web-search(5) → 候选 firecrawl.web-search(9) → 能力提升 +4
缺口 web-scrape(0) → 候选 firecrawl.web-scrape(9) → 新能力覆盖
```

### 步骤 3：互补性分析（核心改进，v6.0.0）

不推荐"替代"，而是分析互补关系：

```
firecrawl vs agent-reach:
  能力重叠: web-search (agent-reach 5 → firecrawl 9)
  能力独占: agent-reach → multi-platform-search(9), social-search(9)
             firecrawl → web-scrape(9), deep-crawl(8), extract(8)
  
  关系判定: 高度互补 → 建议并存
  推荐: "保留 agent-reach 的多平台编排，安装 firecrawl 作为搜索后端"
```

互补关系分类：

| 关系 | 条件 | 建议 |
|:----|:-----|:----|
| **替代** | 重叠 ≥3 能力，新工具全面领先 | 替换旧工具 |
| **互补** | 重叠 ≤1 能力，各有独占能力 | 并存 |
| **补充** | 新工具覆盖旧工具的薄弱能力(≤6) | 并存，新工具做后端 |
| **无关** | 无重叠，新工具覆盖新能力维度 | 按需安装 |

### 步骤 4：推荐去重与排序

- 同名工具只保留置信度最高的推荐
- 排序：P1 缺口 → P0 缺口 → 互补推荐 → 新能力推荐
- 信心指数：能力提升幅度 × 质量信号 × 社区热度
  - 能力提升 ≥4 档且社区 ≥1000⭐ → 强烈推荐(≥8/10)
  - 能力提升 ≥2 档且社区 ≥500⭐ → 建议评估(5-7/10)
  - 能力提升 <2 档 → 不推荐(<5/10)

### 步骤 5：作用域与执行门槛

对通过比较门槛的候选，读取 `flow/05-c-scope-decision.md`，补充 `install_scope`、`target_path`、`scope_reason`、兼容性证据和 `confirmation_required=true`。

- 缺少许可证、兼容性、来源 URL 或作用域理由时，降为“评估中”。
- `project` 与 `global` 推荐必须分组输出；`plugin` 只给官方更新渠道，`defer` 不生成安装命令。
- 推荐不执行安装。执行阶段仍必须走快照和用户确认。

---

## 数据流向

```
Phase ④ 质量信号 ──→ 能力缺口 (例: web-search=5)
                          ↓
Phase ⑤-aa 社区Feed ──→ 候选方案 (例: firecrawl.web-search=9)
                          ↓
Phase ⑤b 互补性分析 ──→ 推荐: "互补，安装 firecrawl 补强"
                          ↓
Phase ⑥ 生态雷达区块 ──→ 输出到报告
```

---
## 下一步

→ [⑥ 生成报告](06-report.md)
