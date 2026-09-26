# ⑥-bis 审计验证

**常规验证**：数据一致性 + 抽样交叉验证 + 评分-决策追踪。≥5次偏差触发权重微调。

**self-audit 自检（v5.9.1）**：
```text
🔍 审计者自检
  ✅ 触发词矩阵完整
  ✅ 独立词触发规则遵守
  ✅ 八维评分每项附理由
  ✅ config.yaml 有效
  ✅ references/ 文件完整
  ✅ 自身活性通过
  — 状态：通过
```
自检失败不阻塞报告输出，但设置 `execution_blocked=true`；在修复或用户明确接受风险前，不得进入⑦执行阶段。

**🧩 安全合规自检（v6.1.0）**：
```text
🧩 安全合规
  ✅ SEC-001 外部信号默认关闭
  ✅ SEC-002 搜索策略默认关闭
  ✅ SEC-003 外部域名白名单合规
  ✅ SEC-004 curl|bash 有校验和
  ✅ SEC-005 iwr|iex 有校验和
  ✅ SEC-006 无 sudo/提权操作
  ✅ SEC-007 无硬编码凭证
  ✅ SEC-008 description 简洁清晰
  ✅ SEC-009 安装器无递归删除回退
  ✅ SEC-010 社区搜索默认关闭且需要明确同意
  — 状态：通过
```
每项检查规则见 `references/security-rules.yaml`。
失败项输出 ⚠️ 警告 + 修复指引（引用 rules[].fix）。`critical`、`high` 或发布契约失败时设置 `execution_blocked=true`，仅允许输出报告和修复建议。

**安全合规检查逻辑（伪代码）**：
```
for each rule in security-rules.yaml:
    scope_files = glob(rule.scope.files)
    for file in scope_files:
        content = read(file)
        for pattern in rule.scope.patterns:
            if pattern has 'regex':
                matches = regex_search(content, pattern.regex)
                if pattern has 'exclude_if_adjacent_lines':
                    matches = exclude_if_surrounded_by(matches, pattern.exclude_if_adjacent_lines)
                score = len(matches) > 0 ? FAIL : PASS
            elif pattern has 'key':
                value = yaml_get(content, pattern.key)
                if pattern.check exists:
                    score = evaluate_checks(value, pattern.check)
                else:
                    score = (value == pattern.value) ? FAIL : PASS
```

---
## 下一步

→ [⑥-c 输出检查](06-c-output-check.md)
