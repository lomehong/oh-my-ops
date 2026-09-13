#!/usr/bin/env bash
# P9 契约验收：沙箱隔离（§7.1，bubblewrap 白名单写入）
#
# 前置：bwrap 可用（missing → 诚实跳过并给出安装指引）。
# 验收：OPS_PI_SANDBOX=1 时——
#   ① 白名单外（宿主 $HOME）写 → 沙箱内失败且宿主无文件
#   ② 白名单内（cwd）写 → 成功落盘
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(git rev-parse --show-toplevel)"

PASS=0
if ! command -v bwrap >/dev/null 2>&1; then
  echo "⏭ bwrap 不可用——跳过沙箱验收（安装 bubblewrap 后重跑）。"
  echo "  验收命令：OPS_PI_SANDBOX=1 bash packages/ops-extension/test/runtime/11-sandbox.sh"
  exit 0
fi
export OPS_PI_SANDBOX=1
MARKER="$HOME/omo-p9-marker-$$"
rm -f "$MARKER"

echo "═══ ① 白名单外写（宿主 \$HOME）→ 拒绝且不落宿主 ═══"
OUT=$(timeout 120 omo --no-session --approval-mode yolo -p \
  "Use ops_shell_exec with command 'touch $MARKER && echo WROTE || echo DENIED'. Report WROTE or DENIED." 2>&1 | tail -2)
echo "$OUT" | head -2
if [ -f "$MARKER" ]; then echo "  ✗ 宿主出现 marker（沙箱泄漏！）"; exit 1; fi
if echo "$OUT" | grep -q "DENIED"; then echo "  ✓ 白名单外写被拒，宿主无文件"; PASS=$((PASS+1)); else echo "  ✗ 未达预期"; exit 1; fi

echo "═══ ② 白名单内写（cwd）→ 成功落盘 ═══"
OUT=$(timeout 120 omo --no-session --approval-mode yolo -p \
  "Use ops_shell_exec with command 'echo p9 > .ops-pi/p9-inside.txt && cat .ops-pi/p9-inside.txt'. Report the file content." 2>&1 | tail -2)
echo "$OUT" | head -2
if [ -f ".ops-pi/p9-inside.txt" ] && grep -q "p9" ".ops-pi/p9-inside.txt"; then echo "  ✓ cwd 写入成功"; PASS=$((PASS+1)); else echo "  ✗ cwd 写入异常"; cat .ops-pi/p9-inside.txt 2>/dev/null; exit 1; fi
rm -f .ops-pi/p9-inside.txt

echo
echo "═══ ✓ P9 沙箱验收：${PASS}/2 通过 ═══"
[ "$PASS" -eq 2 ] || exit 1
