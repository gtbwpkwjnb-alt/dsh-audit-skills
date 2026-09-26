# DSH 市场按需检索映射（本地 DSH 适配）

配套脚本：`scripts/dsh_market_search.mjs`（只发现与对比，不安装）

## 用法

```bash
node scripts/dsh_market_search.mjs --need 记忆 --need 搜索 --runtime 0.1.7-rc.2 --limit 8
node scripts/dsh_market_search.mjs --need "语音转写" --json
```

脚本只保留**真 DSH bundle**（package.json 含 `dsh.bundle.patch`），并给出：版本、发布日期、
许可、DSH peer 兼容判定、是否已装/启用、仓库地址。**Stars 与下载量不作为质量证据。**

## 需求 → 检索关键词

| 需求 | 建议关键词 | 已装方案（本机实测） |
|---|---|---|
| 长期记忆 / 跨会话回忆 | `记忆` `memory` | `@furongjun1999/dsh-memory` ✅启用 |
| 联网搜索 / 多引擎 | `搜索` `web search` | `dsh-free-search` ✅启用（引擎 bing） |
| 网页抓取 / 正文提取 | `fetch` `抓取` `readability` | `dsh-web-fetch-playwright` ⛔已禁用（import 失败） |
| 上下文洞察 / 压缩 | `context` `上下文` | `dsh-context` ✅启用 |
| 侧边栏 / 编辑器 / 文件树 | `sidebar` `editor` | `dsh-better-sidebar` ✅启用 |
| 用量 / 成本统计 | `cost` `用量` `余额` | `dsh-whale-widget` ✅启用（仅展示） |
| 远程访问 / 手机端 | `remote` `mobile` | 无（`@linxin666/dsh-remote-web-ui` 已卸载） |
| 插件治理 / 崩溃回滚 | `guardian` `governance` | 无 |
| 任务看板 / 定时 | `task board` `cron` | 无 |
| 技能管理 | `skills manager` | 无 |
| 主题 / 皮肤 | `theme` `skin` | 无 |

## 对比推荐的判定顺序

1. **兼容性优先**：DSH peer 不满足 → 直接排除（本机 runtime `0.1.7-rc.2`）。历史教训：
   `dsh-oil-creator` peer 钉死 `0.1.0-rc.6/rc.7`、`@firecrawl/dsh-firecrawl` 钉死 `0.1.0-rc.6`，
   都是**装得上、跑不起来**或直接被拒。
2. **成本**：默认免 key/免费（如 `dsh-free-search`）> 需 key。需 key 的必须写明价格与免费额度。
3. **运行证据**：优先有实测记录的方案；无运行证据的标 `unavailable`，不补分。
4. **作用域**：只服务本项目的走项目级；跨项目复用的才进全局 profile。
5. **冲突**：与已装插件功能重叠时优先**共存或替换**，并检查是否抢占同一 seam
   （如 search provider / fetch provider 同槽互斥）。

## 输出纪律

- 许可与价格**分别核验**；目录排名与第三方宣称不作为本机安全结论。
- 未实际安装或运行的候选，不得写成「可用」「已验证」。
- 证据不足时输出「补充证据，暂不变更」，而不是猜测卸载。
