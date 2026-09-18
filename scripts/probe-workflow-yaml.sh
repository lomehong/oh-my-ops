#!/usr/bin/env bash
# 工作流 YAML 结构守卫：块标量（`key: |`）内的行必须比**键**更深缩进。
# 动机（2026-09-18 真实事故）：一次补丁把 markdown 插到 `draft: false` 之后 ⇒ YAML 解析失败，
# GitHub 端工作流名退化为文件路径、无任何 job ⇒ **发布被静默跳过**（tag 推了却没有 Release）。
# 该类错误本地 CI 无法感知（不依赖 pyyaml），故用缩进规则做机械校验。
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
for f in .github/workflows/*.yml .github/workflows/*.yaml; do
  [ -f "$f" ] || continue
  err="$(awk '
    match($0, /^[ ]*/) { ind = RLENGTH }
    /:[ ]*\|[ ]*$/ { block = ind; next }
    block != "" {
      if ($0 ~ /^[ ]*$/) next
      if (ind <= block) { block = ""; next }              # 块结束
      if (ind <= block) { print NR": 块标量内缩进不足（应为 > "block"）"; bad=1 }
    }
    END { exit bad }
  ' "$f" 2>&1)" || { echo "  ✗ $f：${err:-块标量缩进异常}"; fail=$((fail+1)); }
  # 冒烟：顶层必须含 triggers 与 jobs
  grep -qE '^on:' "$f" || { echo "  ✗ $f：缺顶层 on:"; fail=$((fail+1)); }
  grep -qE '^jobs:' "$f" || { echo "  ✗ $f：缺顶层 jobs:"; fail=$((fail+1)); }
  [ "$fail" -eq 0 ] && echo "  ✓ $f 结构检查通过"
done
[ "$fail" -eq 0 ] && echo "结果：全绿" || { echo "结果：$fail 项失败"; exit 1; }
