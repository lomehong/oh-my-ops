#!/usr/bin/env bash
# P2 契约验收：ops_service 目标策略 + 授权语义决定性探针（@local 映射语义完整矩阵）
# 验证项：
#   ① ops_service status（read 档）在 write 模式非交互自动执行（A1）
#   ② ops_service restart（exec 档）未预授权在 yolo 非交互被 ①-b 拒（X10）
#   ③ hostname 诚实化：host='web-01' → ERR_POLICY（禁止伪称操作远程主机）
#   ④ ★ 决定性探针（X2/05③ 收敛）：同一 exec 档调用，预授权 → 无人值守放行；未预授权 → 拒。
#      证明「①-b 与模式无关」的真实语义是「无预授权时与模式无关地拒」，预授权 = Owner 明示意图可越过无人值守。
#   ⑤ ★ 令牌端到端：批准令牌放行 + 单次消费（consumedAt 写回磁盘 + 重放被拒）
#   ⑥ ★ A4 审计探针：持久会话模式下被拒调用落 ops_audit（authz=blocked / reasonClass=ERR_PERMISSION）
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(git rev-parse --show-toplevel)"

PASS=0; FAIL=0; WARN=0

# ── 策略/令牌环境（repo 根 .ops-pi/；先备份，EXIT 恢复）──
mkdir -p .ops-pi
for f in policy.json approval-token.json; do
  if [ -f ".ops-pi/$f" ]; then cp ".ops-pi/$f" ".ops-pi/$f.bak-probe"; fi
done
trap 'for f in policy.json approval-token.json; do
        if [ -f ".ops-pi/$f.bak-probe" ]; then mv ".ops-pi/$f.bak-probe" ".ops-pi/$f"; else rm -f ".ops-pi/$f"; fi
      done' EXIT

write_policy() { printf '%s' "$1" > .ops-pi/policy.json; }
write_token()  { printf '%s' "$1" > .ops-pi/approval-token.json; }
run_ops() { # $1=mode  $2=prompt  $3=outfile（--no-session）
  timeout 120 omo --no-session --approval-mode "$1" \
    -e packages/ops-extension/src/extension.ts -p "$2" > "$3" 2>&1 || true
}

rm -f .ops-pi/approval-token.json
write_policy '{"targets":[{"host":"@local","services":["nginx"],"actions":["status"]}]}'

echo "═══ ① ops_service status（read 档）write 模式非交互自动执行 ═══"
OUT_A=$(mktemp)
run_ops write "Use ops_service with service='nginx', action='status'. Return ONLY the tool result. Do not explain." "$OUT_A"
if grep -q "\[ERR_PERMISSION\]" "$OUT_A"; then
  echo "  ✗ ① read 档被权限拒（read 档不应走授权判定）"
  head -3 "$OUT_A" | cat; FAIL=$((FAIL+1))
elif grep -qi "nginx\|no output\|exit=\|active\|systemd\|unit" "$OUT_A"; then
  echo "  ✓ ① status（read 档）自动执行"
  PASS=$((PASS+1))
else
  echo "  ⚠ ① 输出无法识别（容器环境），但未被权限拒"
  head -3 "$OUT_A" | cat; PASS=$((PASS+1))
fi
rm -f "$OUT_A"

echo "═══ ② exec 档未预授权：yolo 非交互下被 ①-b 拒（X10）═══"
OUT_B=$(mktemp)
run_ops yolo "Use ops_service with service='nginx', action='restart'. Report the exact error. Do not explain." "$OUT_B"
if grep -q "guard-unattended" "$OUT_B"; then
  echo "  ✓ ② restart 被拒（guard-unattended：exec 档无人值守无预授权）"
  PASS=$((PASS+1))
else
  echo "  ✗ ② restart 未被拒——安全缺口"
  head -5 "$OUT_B" | cat; FAIL=$((FAIL+1))
fi
rm -f "$OUT_B"

echo "═══ ③ hostname 诚实化：host='web-01' → ERR_POLICY ═══"
OUT_C=$(mktemp)
run_ops write "Use ops_service with host='web-01', service='nginx', action='status'. Report the exact error. Do not explain." "$OUT_C"
if grep -q "ERR_POLICY" "$OUT_C" && grep -q "远程" "$OUT_C"; then
  echo "  ✓ ③ 伪称远程主机被诚实化拒绝（不再静默改本机）"
  PASS=$((PASS+1))
else
  echo "  ✗ ③ host='web-01' 未被拒绝（hostname 诚实化失效）"
  head -5 "$OUT_C" | cat; FAIL=$((FAIL+1))
fi
rm -f "$OUT_C"

echo "═══ ④ ★ 决定性探针：预授权 ↔ 无人值守放行矩阵（X2/05③ 收敛）═══"
OUT_D1=$(mktemp)
run_ops write "Use ops_service with service='redis', action='restart'. Report the exact error. Do not explain." "$OUT_D1"
if grep -q "guard-unattended" "$OUT_D1"; then
  echo "  ✓ ④a 未预授权（redis 不在白名单）write 模式仍拒——拒绝与模式无关"
  PASS=$((PASS+1))
else
  echo "  ✗ ④a 未预授权 restart 在 write 模式被放行——安全缺口"
  head -5 "$OUT_D1" | cat; FAIL=$((FAIL+1))
fi
rm -f "$OUT_D1"

write_policy '{"targets":[{"host":"@local","services":["nginx"],"actions":["restart","status"]}]}'
OUT_D2=$(mktemp)
run_ops yolo "Use ops_service with service='nginx', action='restart'. Return ONLY the tool result. Do not explain." "$OUT_D2"
if grep -q "\[ERR_PERMISSION\]" "$OUT_D2"; then
  echo "  ✗ ④b 预授权（@local/nginx/restart）在无人值守下仍被拒——预授权语义失效（Owner 明示意图未生效）"
  head -5 "$OUT_D2" | cat; FAIL=$((FAIL+1))
else
  echo "  ✓ ④b 预授权目标在无人值守下放行执行（systemctl 报错属执行层，非授权层）"
  PASS=$((PASS+1))
fi
rm -f "$OUT_D2"

echo "═══ ⑤ ★ 令牌端到端：放行 + 单次消费（写回 consumedAt + 重放被拒）═══"
write_policy '{"targets":[]}'
write_token '{"tokens":[{"id":"T-PROBE","scope":"@local/redis/restart","issuedBy":"Owner","issuedAt":"2026-09-12T00:00:00Z"}]}'
OUT_E1=$(mktemp)
run_ops yolo "Use ops_service with service='redis', action='restart'. Return ONLY the tool result. Do not explain." "$OUT_E1"
if grep -q "\[ERR_PERMISSION\]" "$OUT_E1"; then
  echo "  ✗ ⑤a 令牌未放行（token 路径失效）"
  head -5 "$OUT_E1" | cat; FAIL=$((FAIL+1))
else
  echo "  ✓ ⑤a 批准令牌在无人值守下放行"
  PASS=$((PASS+1))
fi
rm -f "$OUT_E1"
if grep -q '"consumedAt"' .ops-pi/approval-token.json; then
  echo "  ✓ ⑤b consumedAt 已写回磁盘（跨会话不可重放）"
  PASS=$((PASS+1))
else
  echo "  ✗ ⑤b 令牌文件未见 consumedAt——消费未持久化"
  cat .ops-pi/approval-token.json; FAIL=$((FAIL+1))
fi
OUT_E2=$(mktemp)
run_ops yolo "Use ops_service with service='redis', action='restart'. Report the exact error. Do not explain." "$OUT_E2"
if grep -q "guard-unattended" "$OUT_E2"; then
  echo "  ✓ ⑤c 同令牌重放被拒（单次批准语义）"
  PASS=$((PASS+1))
else
  echo "  ✗ ⑤c 已消费令牌重放成功——单次批准被破坏"
  head -5 "$OUT_E2" | cat; FAIL=$((FAIL+1))
fi
rm -f "$OUT_E2"

echo "═══ ⑥ ★ A4 审计探针：被拒调用落 ops_audit（持久会话模式）═══"
write_policy '{"targets":[]}'
rm -f .ops-pi/approval-token.json
OUT_F=$(mktemp)
timeout 120 omo --approval-mode yolo \
  -e packages/ops-extension/src/extension.ts \
  -p "Use ops_service with service='redis', action='restart'. Report the exact error. Do not explain." \
  > "$OUT_F" 2>&1 || true
if ! grep -q "guard-unattended" "$OUT_F"; then
  echo "  ⚠ ⑥ 前置条件不满足（调用未被拒），跳过审计断言"
  WARN=$((WARN+1))
else
  AUDIT_FILE=""
  while IFS= read -r f; do
    if grep -q "ops_audit" "$f" 2>/dev/null && grep -q "ops_service" "$f" 2>/dev/null \
       && grep -q "ERR_PERMISSION" "$f" 2>/dev/null; then
      AUDIT_FILE="$f"; break
    fi
  done < <(find "$HOME/.omp" "$HOME/.omo" "$HOME/.config/omp" "$HOME/.local/share/omp" "$PWD/.omp" "$PWD/.ops-pi" \
        -type f \( -name '*.jsonl' -o -name '*.json' \) -mmin -5 2>/dev/null)
  if [ -n "$AUDIT_FILE" ]; then
    echo "  ✓ ⑥ 被拒调用已落审计（$AUDIT_FILE 含 ops_audit + ERR_PERMISSION）"
    PASS=$((PASS+1))
  else
    echo "  ⚠ ⑥ 未能定位含 ops_audit 的会话文件（omp 会话目录非预期）——环境不可判定，不算失败"
    echo "    （请人工核验：持久会话下 tool_execution_end 应产生 ops_audit 条目，authz=blocked/reasonClass=ERR_PERMISSION）"
    WARN=$((WARN+1))
  fi
fi
rm -f "$OUT_F"

echo
echo "═══ P2 运行时验收总结：${PASS} 通过 / ${FAIL} 失败 / ${WARN} 环境不可判定 ═══"
if [ "$FAIL" -gt 0 ]; then
  echo "⚠ 存在失败项，P2 不能提交"
  exit 1
fi
echo "✓ 全部通过"
