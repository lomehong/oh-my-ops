#!/usr/bin/env bash
# P0 契约验收：ops_extension 加载成功 + session_start 时工具清单断言通过（O11/X15）
# 验证项：
#   ① 平台能力校验（§7.2）通过（无 [ops-pi] 平台能力校验失败报错）
#   ② 工具名断言（§5 Contract ②）通过（无 [ops-pi] 工具清单断言失败报错）
#   ③ 工具注册成功（LLM 可见 ops_file_read / ops_process_list）
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(git rev-parse --show-toplevel)"

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

echo "[P0-C] 加载 ops-extension（无共载），验证无平台/断言报错"
timeout 120 omo --no-session \
  -e packages/ops-extension/src/extension.ts \
  -p "List ALL available tools prefixed with 'ops_'. Return them one per line." \
  > "$OUT" 2>&1 || true

echo "[P0-C] 输出片段（前 10 行）："
head -10 "$OUT" | cat

# 反向断言：不应有平台能力校验失败或工具清单断言失败
if grep -q "\[ops-pi\] 平台能力校验失败" "$OUT"; then
  echo "[P0-C] ✗ 平台能力校验失败" >&2
  exit 1
fi
if grep -q "\[ops-pi\] 工具清单断言失败" "$OUT"; then
  echo "[P0-C] ✗ 工具清单断言失败" >&2
  exit 1
fi

# 正向断言：LLM 报告了 ops_file_read 与 ops_process_list
if grep -q "ops_file_read" "$OUT" && grep -q "ops_process_list" "$OUT"; then
  echo "[P0-C] ✓ ops_extension 加载成功，平台校验与工具清单断言均通过，工具注册成功"
else
  echo "[P0-C] ✗ 未在 LLM 输出中找到 ops_file_read 或 ops_process_list" >&2
  exit 1
fi
