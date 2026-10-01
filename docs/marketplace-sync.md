# 发布与市场同步（每次发版的固定动作）

> 一句话结论：**这个生态的插件市场基本都靠 GitHub topic `dsh-plugin` 自动发现**。
> 所以「同步到市场」= ❶ topic 在 ❷ 打附注 tag ❸ 建 GitHub Release ❹ 卡片字段达标
> ❺（可选）向少数需要人工/PR 的目录单独提交。**不需要逐个市场手动填表。**

## 0 机制（2026-10-01 实测抓取，不是推测）

DSH Marketplace 提交页（<https://dshmarketplace.dev/submit>）原话：

> This catalogue syncs the `dsh-plugin` GitHub topic. Adding that topic to your repository gets you
> listed on the next sync, **with no submission needed** — and it also makes you discoverable to
> **every other DSH plugin market, including the one built into DeepSeek Harness**.
> Recommended: add **both** `dsh-plugin` and `deepseek-harness` topics.

岚叔 registry（<https://dsh.lanshuagent.com/api/registry/status>）实测：

```json
{ "automation": { "enabled": true, "schedule": "0 */12 * * *", "state": "live",
                  "lastRunAt": "2026-10-01T00:06:08Z", "discoveredThisRun": 185 },
  "summary":    { "listed": 655, "autoDiscovered": 452, "codexPicks": 52 } }
```

其精选来源是 `cclank/dsh-plugin-hub` 的 `data/codex-picks.json`（52 条）。

`cclank/dsh-plugin-hub` README 原话：「自动收录 | Cloudflare Cron 每 12 小时发现新仓库、同步严选列表」
「GitHub `dsh-plugin` topic：自动发现入口」。

**结论**：加 topic 之后，dshmarketplace.dev / dsh-plugin-hub / 岚叔 registry / 内置插件市场会在
**下一次同步（≤12 小时）**自行收录；我们不需要提交表单。

## 1 每次发版的固定四步（全部可脚本化）

| # | 动作 | 命令 |
|---|---|---|
| 1 | 回测全绿 | `node scripts/preflight-client.mjs`、`crash-rehearsal.mjs`、`render-smoke.mjs`、`regression.mjs` **分别跑**（`npm run check` 用 `&&`，第一项红后面就不跑） |
| 2 | 提交 + 附注 tag + 推送 | `git add -A` → `git commit -F <msg>` → `git tag -a vX.Y.Z -F <msg>` → `git push origin main` → `git push origin vX.Y.Z` |
| 3 | 建 GitHub Release（目录页与爬虫读它） | `gh release create vX.Y.Z --repo gtbwpkwjnb-alt/dsh-audit-skills --title "<版本 — 一句话>" --notes-file <notes>` |
| 4 | 重新钉 profile（本机生效 + 防回退） | `node <bundle>/pnpm.cjs -C C:\Users\Administrator\.dsh\profiles\desktop add "github:gtbwpkwjnb-alt/dsh-audit-skills#vX.Y.Z"` |

> ⚠️ 第 4 步注意：这是 `pnpm add`，会重新物化 profile 里的包。**若某个插件正在运行并占住自己的目录**
> （实测 `dsh-computer-use-win` 的 MCP server 与常驻 UIA helper 会占住），pnpm 会在 rename 时报
> `ERR_PNPM_EPERM` 并把该包目录清空、同时回滚我们的 spec。处置见 §5。

## 2 一次性配置（已做，勿丢）

- **topics**：`dsh-plugin`、`deepseek-harness`、`dsh`、`plugin-manager`、`chinese-localization`、`i18n`
  ```powershell
  gh repo edit gtbwpkwjnb-alt/dsh-audit-skills --add-topic dsh-plugin --add-topic deepseek-harness
  ```
- **About**：一句话讲能力（市场明说 repository description 会变成卡片摘要，别写实现）
- **许可**：MIT（已有）；**README 含安装说明**（市场会把 README 渲染成详情页）

## 3 各市场与路径（2026-10-01 实测）

| 市场 | 地址 | 收录方式 | 我们要做的 |
|---|---|---|---|
| DSH Marketplace | <https://dshmarketplace.dev/submit> | **同步 `dsh-plugin` topic** 自动收录；也可贴仓库 URL 人工提交（人工复核） | topic 已加 → 等下一次同步 |
| 同上 · Awesome 列表 | 该站「Submit a pull request」 | 在他们仓库 `data/curated.yml` 按分类加条目并跑 `npm test`，发 PR | 可选：PR |
| dsh-plugin-hub（社区 registry） | <https://github.com/cclank/dsh-plugin-hub> | Cron 每 12h 扫 topic；`data/plugins.generated.json` 自动生成 | topic 已加 → 等同步 |
| 岚叔 registry | <https://dsh.lanshuagent.com/api/registry/status> | 聚合 hub 的 codex-picks + 自身巡检；护照 API `/api/passports/:owner/:repo/:sha` | topic 已加 |
| dshbase | <https://dshbase.com> | 目录页；`Verified` 表示他们做过真机安装测试 | 记录入口，按需人工提交 |
| dshplugin.store | <https://www.dshplugin.store> | 目录页 | 记录入口，按需人工提交 |
| dsh.works / dsh.so | <https://dsh.works>（200）· <https://dsh.so>（308→） | 目录页 | 记录入口，按需人工提交 |
| npm | <https://registry.npmjs.org> | 多个目录会取 npm 元数据 | ⚠️ 见 §4 |

## 4 已知缺口（需要人拍板）

1. **npm 未发布**：`dsh-audit-skills` 不在 npm 上；市场把「有 npm 包」列为加分项，且 npm 安装路径
   比 git 依赖更好升级。需要 npm 凭据：
   ```powershell
   npm login          # 或设置 NPM_TOKEN
   npm publish --access public
   ```
   本机 `.npmrc` 只有 cache/registry/prefix，**没有 `_authToken`**，所以这一步必须你来。
2. **需要登录态的人工提交表单**（dshmarketplace.dev / dshbase / dshplugin.store）：本会话没有
   浏览器自动化工具，只记录路径。
3. **PR 到 Awesome 列表**：`gh` 已登录 `gtbwpkwjnb-alt`（scopes: `gist, read:org, repo, workflow`），
   技术上可 fork+PR，但需先确认他们的分类与 `npm test` 要求。

## 5 故障处置：pnpm 重装把某个插件目录清空（EPERM）

症状：`pnpm add` 报 `ERR_PNPM_EPERM ... rename 'X_tmp_N' -> 'X'`；之后 `node_modules/X` 变成空目录、
`package.json` 丢失；同一次操作会**回滚我们的 spec**（表现为插件被降到上一个 tag）。

原因：该插件的进程占住了自己的目录（实测 `dsh-computer-use-win`：`mcp/server.mjs` 的
`DeepSeek Harness.exe` 子进程 + `windows-uia.ps1 -Persistent` 的 powershell）。

处置（**只杀插件自己的进程，绝不动监听 19387 的 DSH 主进程**）：

```powershell
# 1 找出占用者
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*<包名>*' } |
  Select-Object ProcessId,Name,CommandLine
# 2 杀掉它们（确认 PID 不是 DSH 主进程）
Stop-Process -Id <pid1>,<pid2> -Force
# 3 删掉空目录并重装
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\<包名>" -Recurse -Force
node <bundle>/pnpm.cjs -C $env:USERPROFILE\.dsh\profiles\desktop install
# 4 重新钉我们的版本 + 补回被洗掉的 locale
node <bundle>/pnpm.cjs -C $env:USERPROFILE\.dsh\profiles\desktop add "github:gtbwpkwjnb-alt/dsh-audit-skills#vX.Y.Z"
# 5 补文案（也可打开设置页触发自愈）
curl.exe -sS -X POST http://127.0.0.1:19387/api/dsh-audit-skills/apply -H "content-type: application/json" -d '{\"pkgs\":[\"<包名>\"]}'
```

> 复盘：杀掉的 MCP server 与 helper 要等 **DSH 重启**才会重新拉起；重启前那个插件的能力不可用。

## 6 复核命令（确认同步生效）

```powershell
gh api repos/gtbwpkwjnb-alt/dsh-audit-skills/topics --jq '.names'
gh release list --repo gtbwpkwjnb-alt/dsh-audit-skills
curl.exe -sS https://dsh.lanshuagent.com/api/registry/status   # 看 listed / autoDiscovered 是否增长
curl.exe -sS https://raw.githubusercontent.com/cclank/dsh-plugin-hub/main/data/plugins.generated.json | Select-String "dsh-audit-skills"
```

## 7 上次执行记录

- **2026-10-01**：发布 v2.10.0（commit `06eece7`，附注 tag `v2.10.0`）；设 topics；建 Release
  <https://github.com/gtbwpkwjnb-alt/dsh-audit-skills/releases/tag/v2.10.0>；重新钉 profile 到 `#v2.10.0`。
  期间遇到 §5 的 EPERM（`dsh-computer-use-win` 被自己的进程占住），已按其步骤修复并补回 locale。
- 待办：npm 发布（缺 token）；人工表单与 Awesome PR（需登录态/分类确认）。
