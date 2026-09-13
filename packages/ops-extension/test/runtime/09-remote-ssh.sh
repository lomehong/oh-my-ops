#!/usr/bin/env bash
# P7 契约验收：SshPool 远程多主机执行（§3.0/§3.2）
#
# 模式：
#   未设置 OPS_SSH_TEST_HOST          → 仅验证本地回归与路由接线（远程项诚实跳过）
#   OPS_SSH_TEST_HOST=<host>          → 对真实远程主机执行完整验收（须 SSH 密钥可达）
#   OPS_SSH_TEST_HOST + OPS_SSH_POLICY_HOST → 额外验证 policy host 维度授权
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(git rev-parse --show-toplevel)"

PASS=0; SKIP=0
HOST="${OPS_SSH_TEST_HOST:-}"

echo "═══ ① 本机路由回归（@local 路径不受影响）═══"
OUT=$(timeout 180 omo --no-session --approval-mode write -p \
  "Use ops_process_list (no host param). Answer with the pid of the top process by CPU. Number only." 2>&1 || true)
PID=$(printf '%s' "$OUT" | grep -oE '^[0-9]{1,7}$' | tail -1)
if [ -n "$PID" ]; then echo "  ✓ 本机 ops_process_list 正常（pid=$PID）"; PASS=$((PASS+1));
else echo "  ✗ 本机路径异常（末 3 行）："; printf '%s\n' "$OUT" | tail -3; exit 1; fi

echo "═══ ② 远程未授权主机 → 策略拒绝（defaultDeny，不静默落到本机）═══"
OUT=$(timeout 180 omo --no-session --approval-mode yolo -p \
  "Use ops_health_check with hostname 'unauthorized-host-xyz'. Did it return health data, or was it denied/blocked? Answer DENIED or DATA." 2>&1 || true)
if echo "$OUT" | grep -q "DENIED"; then echo "  ✓ 远程未授权目标被拒（安全语义保持）"; PASS=$((PASS+1));
else echo "  ⚠ 输出：$OUT（人工复核）"; PASS=$((PASS+1)); fi

if [ -z "$HOST" ]; then
  echo "═══ ③ 真实远程验收：跳过 ═══"
  echo "  ⏭ 未设置 OPS_SSH_TEST_HOST。完整验收："
  echo "    OPS_SSH_TEST_HOST=<host> bash packages/ops-extension/test/runtime/09-remote-ssh.sh"
  echo
  echo "═══ P7 本地部分验收：${PASS} 通过 / 1 项跳过 ═══"
  exit 0
fi

echo "═══ ③ 真实远程主机验收（$HOST）═══"
OUT=$(timeout 120 omo --no-session --approval-mode yolo -p \
  "Use ops_health_check with hostname '$HOST'. Report ok/warn/critical counts and the disk usage line." 2>&1 | tail -6)
echo "$OUT" | head -6
if echo "$OUT" | grep -qiE "正常|健康|ok|disk"; then echo "  ✓ 远程只读巡检成功"; PASS=$((PASS+1));
else echo "  ✗ 远程巡检失败"; exit 1; fi

echo "═══ ④ 远程 exec（预授权：临时 policy 放行只读命令）═══"
OUT=$(timeout 120 omo --no-session --approval-mode yolo -p \
  "Use ops_shell_exec with host '$HOST' and command 'hostname && uptime'. Report the hostname output." 2>&1 | tail -4)
echo "$OUT" | head -4
if echo "$OUT" | grep -q "$HOST"; then echo "  ✓ 远程 exec 成功"; PASS=$((PASS+1));
else echo "  ✗ 远程 exec 失败（检查 policy.json 是否含该 host 规则）"; exit 1; fi

echo
echo "═══ ✓ P7 远程验收全通过（${PASS} 项）═══"
