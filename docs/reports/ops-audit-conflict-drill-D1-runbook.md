# OPSAUDIT-4 · D-1 实弹演练手册（交付主人执行）

> 已批准范围：D-1 必做（交互态）；D-2/D-3 可选实弹，受限则降级引用 05 探针证据。
> 执行者：主人（部署机交互会话）；对账与报告：omp-architect（结果回传即写 `docs/reports/ops-audit-conflict-drill.md` + 台账 evidence）。
> 纪律：演练即测试，不改产品代码；全程复制 UI 原文（或截图）留存。

## 前置（一次性，演练后恢复）

```bash
which omo                      # 确认部署机有 omo
cd <部署仓根>                   # .ops-pi/ 所在目录
cp .ops-pi/policy.json .ops-pi/policy.json.bak-drill 2>/dev/null || true
cat > .ops-pi/policy.json <<'EOF'
{"targets":[{"host":"@local","services":["nginx"],"actions":["status"]}]}
EOF
rm -f .ops-pi/approval-token.json   # 确保无残留令牌
```

## 步骤（每步留存：输入 + UI 完整输出）

| 步 | 操作 | 预期观察（判据） |
|---|---|---|
| S1 | 终端 `omo` 进交互 TUI | 扩展加载无报错（缺 getBranch 类启动断言失败则立即停止并回报） |
| S2 | 对 LLM：`用 ops_service 对 nginx 执行 restart，原样返回错误，不要解释` | 工具被拒，错误含 `[ERR_PERMISSION] guard-unattended`（未预授权 exec 档） |
| S3 | 输入 `/ops-audit` | 头部 `ops-audit：显示 N 条（可读范围=当前会话分支 leaf 路径）`；列表含 `ops_service … blocked class=ERR_PERMISSION … [ERR_PERMISSION] guard-unattended`；其余历史 ops_* 条目按时间倒序 |
| S4 | 输入 `/ops-audit 1` | 仅 1 条 = S3 那次 `/ops-audit` 的自审计条目（`ops-audit read/ok`）→ **B6 先读后写闭环** |
| S5 | 输入 `/ops-audit abc` | 错误提示 `参数须为正整数（1–200…）`，无条目列表（B4） |
| S6 | 输入 `/ops-audit 0` | 同类错误提示 |
| S7 | 退出 TUI，恢复策略：`mv .ops-pi/policy.json.bak-drill .ops-pi/policy.json` | 环境还原 |

## D-2 / D-3（可选实弹；同机非交互）

- D-2：`bash bin/omo --approval-mode yolo -p "ops_service restart nginx，原样返回错误"` 与 `--approval-mode always-ask` 同参各跑一次 → 两者输出均应含 `guard-unattended`（模式无关兜底，对账 05②）。
- D-3：令牌签发/消费/重放按 `packages/ops-extension/test/runtime/05-service-policy.sh` ⑤ 的流程实弹一遍（对账 05⑤）。
- 受限则降级：引用 05②⑤⑥ 自动化证据 + 差异说明（已获批准）。

## 回收与对账

结果（各步 UI 原文）回传本会话 → 对账执行记录 T1–T7 → 落 `docs/reports/ops-audit-conflict-drill.md` + 台账 `OPSAUDIT-4` evidence 回填 → 自报 → 主人 confirm（阶段 3 收口）。
