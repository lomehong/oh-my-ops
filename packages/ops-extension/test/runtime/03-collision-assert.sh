#!/usr/bin/env bash
# P0 契约验收：session_start 工具清单断言在加载期触发（O11/X15）
# 同时加载 ops-extension 与模拟 Yuyi stub（无冲突版本），验证断言正常通过
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(git rev-parse --show-toplevel)"

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

echo "[P0-D] 共载 ops-extension + yuyi stub（无重名），验证断言通过且工具可用"
timeout 120 omo --no-session --approval-mode write \
  -e packages/ops-extension/src/extension.ts \
  -e packages/ops-extension/test/runtime/stubs-yuyi.ts \
  -p "Use ops_file_read to read /etc/hostname. Return ONLY the file content." \
  > "$OUT" 2>&1 || true

echo "[P0-D] 输出片段（前 5 行）："
head -5 "$OUT" | cat

# 反向断言：无断言失败
if grep -q "\[ops-pi\] 工具清单断言失败" "$OUT"; then
  echo "[P0-D] ✗ 工具清单断言失败（共载版本）" >&2
  exit 1
fi

# 正向断言：hostname 内容返回（证明 ops_file_read 在共载下仍可执行，yuyi stub 无干扰）
if grep -qE "3c272819fff9" "$OUT"; then
  echo "[P0-D] ✓ 共载 yuyi stub 正常，工具清单断言通过，read 档执行成功（hostname 返回）"
else
  echo "[P0-D] ✗ 未读到 hostname 内容" >&2
  exit 1
fi
