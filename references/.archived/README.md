# 归档说明

## flow-v7/（2026-07-23，v8.2.1 归档）

`flow-v7/` 收录的是 v7 及以前（v5.9.1–v7 时代）的阶段式旧主流程文档（00-config.md 至 08-persist.md，共 24 个文件）。

归档原因：

- 现行 SKILL.md v8 与 config.yaml 均不再引用这些文件；现行流程见 [references/execution-flow.md](../execution-flow.md)。
- 旧流程与 v8 的只读底线和按需加载架构不一致（例如 07-c-execute.md 描述了写入操作，与 v8"默认只读"边界矛盾）。

这些文件仅作为历史参考保留，不属于现行契约，请勿在新流程中引用。
