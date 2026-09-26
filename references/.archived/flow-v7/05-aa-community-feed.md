# ⑤-aa 社区 Feed — 能力缺口驱动搜索

> v6.0.0 新增。位于 ⑤a 外部信号之后、⑤b 推荐引擎之前。
> 搜索 GitHub 社区，寻找能填补当前能力缺口的工具。

文中的工具名、stars、分数和安装命令仅为流程示意，不是本次审计事实；实际报告只能输出本次取得的证据。

执行前检查 `config.yaml community_feed.enabled=true` 且 `require_explicit_consent=true` 时已获得用户对本次联网查询的明确同意；任一条件不满足则跳过并在报告中标注“⏸ 社区搜索未获同意”。

---

## 搜索词构建（双源）

搜索词从两个来源推导，合并去重：

### 来源 1：质量缺口（P1 以上）

从 Phase ① 质量信号中读取标记为 P1 缺口的工具，取该工具的薄弱能力维度作为搜索目标：

```
例: agent-reach.web-search = 5/10 (因 WebFetch 质量低)
→ 搜索词: "mcp server web search alternative"
→ 目标: 找 web-search 能力 ≥8/10 的工具
```

### 来源 2：项目核心活动（未覆盖的能力）

从 project-types.yaml 的项目画像中，找出当前能力矩阵未覆盖的核心活动：

```
例: 项目类型 "AI Agent 技能开发" 含核心活动 "搜索调研"
    但能力矩阵中 web-search 覆盖度 <50%
→ 搜索词: "mcp server search tool agent"
→ 目标: 补全新能力维度
```

### 搜索词优化规则

- 每个来源生成 1-2 个搜索词
- 搜索词优先用英文（GitHub 搜索更准）
- 搜索词含 "mcp" 关键词（针对 MCP 生态）
- 去重：相同搜索词只搜一次
- 上限：每次审计最多 3 个搜索词

---

## 搜索执行（用 GitHub MCP 或 GitHub API）

使用已安装的 GitHub MCP server 执行搜索（无需新增 API Key）：

```
工具: github_search_code 或 github_search_repositories
查询: 搜索词 + "stars:>500"
排序: stars desc
每查询取前 15 条
```

如果 GitHub MCP 不可用，回退到 WebFetch 搜索 GitHub 页面或使用 `agent-reach`。

---

## 结果分类与置信度评估

对每个搜索结果，用项目 description + topics 进行快速分类：

```
1. 提取项目的 description 和 topics
2. 匹配 capability-dimensions.yaml 的维度关键词
3. 计算置信度:
   - topics 直接命中的关键词匹配 → 8/10
   - description 含关键词 → 7/10
   - 无关键词但 category 相关 → 5/10
4. 低于 5/10 的跳过
```

候选进入推荐引擎前，必须继续执行 `flow/05-ab-github-comparison.md`；本阶段的 stars、topics 和 description 不能单独作为安装结论。

结果输出格式：

```yaml
candidates:
  - name: "firecrawl"
    stars: 144000
    url: "https://github.com/firecrawl/firecrawl"
    description: "Web scraping, search, and crawling"
    matched_dimensions:
      web-search: {confidence: 9, evidence: "description+topics match"}
      web-scrape: {confidence: 9, evidence: "topics: web-scraping"}
    install: "npx -y firecrawl-mcp"
```

---

## 缓存策略

- 每次搜索缓存到 `.data/community-feed-cache.json`
- 缓存结构（基线快照）：
  ```json
  {
    "snapshot_at": "2026-07-05",
    "searches": [
      {
        "query": "mcp server web search",
        "results": [
          {"name": "firecrawl", "stars": 144000, "matched_dims": ["web-search"]},
          ...
        ]
      }
    ],
    "gaps_found": ["web-search"],     
    "recommendations_generated": true
  }
  ```
- 下次审计对比缓存：新出现的高星项目标记为 `🆕 新增`
- stars 增长 >20% 的项目标记为 `📈 快速增长`

---

## 数据流向

```
Phase 1 (质量缺口) ──→ 搜索词 ──→ Phase 3 (GitHub 搜索)
Phase 2 (能力矩阵)  ──→ 缺口    ──→          ↓
                                     候选池 → Phase 4 (生态雷达)
                                       ↓
                              Phase ⑤b (推荐引擎参考)
```

---
## 下一步

→ [⑤b 推荐引擎](05-rec-engine.md)
