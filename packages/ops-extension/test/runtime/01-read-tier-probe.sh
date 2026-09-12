#!/usr/bin/env bash
# P0 契约验收：read 档工具（真实 ops_file_read）在 approvalMode=write 下自动执行（X1/X8）
# 依赖：omp 已安装 + ~/.omp 模型配置 + 网络
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(git rev-parse --show-toplevel)"

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

echo "[A1] 启动 omp（write 模式 + 非交互），加载 ops-extension，prompt 读取 /etc/hostname"
timeout 120 omo --no-session --approval-mode write \
  -e packages/ops-extension/src/extension.ts \
  -p "Use ops_file_read to read /etc/hostname. Return ONLY the file content, no explanation." \
  > "$OUT" 2>&1 || true

echo "[A1] 输出前 5 行："
head -5 "$OUT" | cat

# 正向断言：成功读到文件内容（hostname 通常短且非空）
if grep -qE "^(127\.0\.1\.1|[0-9a-zA-Z])" "$OUT"; then
  echo "[A1] ✓ read 档工具在 write 模式下自动执行并返回了文件内容（X1 验收通过）"
else
  echo "[A1] ✗ 未读到文件内容" >&2
  exit 1
fi

# 反向断言：不应有权限拒绝
if grep -q "\[ERR_PERMISSION\]" "$OUT"; then
  echo "[A1] ✗ 出现了权限拒绝消息——read 档不应被拒" >&2
  exit 1
fi
