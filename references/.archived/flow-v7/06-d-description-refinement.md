# ⑥-d 描述精炼候选

在每次技能审计的 ⑥-c 之后执行。先读 `references/display-source-map.md`，再读取 `references/description-quality.md`（`references/description-refinement.md` 的 Forma 规则已于 v8.2.2 合并入此文件）。对每个扫描到的 `SKILL.md` 的 `description` 按 Forma 四项规则检查。扫描路径必须包含 `.agents`、`.zcode`、`.claude`、`~/.codex/skills`、`$CODEX_HOME/skills`、`$CODEX_HOME/plugins/cache`、`$CODEX_HOME/cache/remote_plugin_catalog` 与已启用 Codex runtime 插件；排除 `.archived`。

1. 任一项不合格时，在报告尾部输出 `📋 描述精炼候选` 表，含技能、原始 description、问题、精炼后候选、`editable` 与事实状态。
2. `技能审查 精炼` 或 `技能审计 refine` 强制运行 `scripts/collect_codex_display_candidates.py --scope installed --check-unchanged`，并固定输出 `📋 Codex 命令栏与侧边栏中文翻译清单`。已安装项与 `remote_plugin_catalog` 市场项必须分组：catalog-only 仅作可发现展示候选，不计入已安装健康度、容量或 P1 翻译积压。每项包含绝对来源路径、命令栏原文/候选、侧边栏原文/候选、来源类型、可编辑性、事实状态及“仅清单，不写入”标记。
3. `精炼`、`描述精炼`、`描述优化` 进入独立描述精炼模式，复用同一发现与候选格式。
4. `$CODEX_HOME/plugins/cache`、runtime、remote catalog 与官方插件一律 `editable=false`：只读，不写入；仅生成候选，不提供修改命令，不修改 runtime、插件缓存或 Codex UI。
5. 默认只读。只有用户明确确认候选后，才能在⑦-b确认→⑦-a快照→⑦-c执行顺序中修改用户自制且 `editable=true` 的 frontmatter；修改后重新解析 YAML 并运行严格验证。

候选表缺失时，⑥-c 必须将报告标为 `partial`，不得进入执行阶段。
