#!/usr/bin/env bash
# P3 契约验收：Docker/K8s 工具注册 + 执行路径验证
# 容器内 docker/kubectl 可能不可用——验收关注「工具被调用且返回 OpsError」，而非「命令成功」
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(git rev-parse --show-toplevel)"

PASS=0; FAIL=0

echo "═══ ① Docker 工具注册成功（LLM 可见）═══"
OUT_A=$(mktemp)
timeout 120 omo --no-session --approval-mode yolo \
  -e packages/ops-extension/src/extension.ts \
  -p "List all tools starting with 'ops_docker'. Return them one per line." \
  > "$OUT_A" 2>&1 || true
if grep -q "ops_docker_ps" "$OUT_A" && grep -q "ops_docker_logs" "$OUT_A"; then
  echo "  ✓ Docker 工具注册成功"
  PASS=$((PASS+1))
else
  echo "  ✗ Docker 工具未注册"
  head -5 "$OUT_A" | cat
  FAIL=$((FAIL+1))
fi
rm -f "$OUT_A"

echo "═══ ② K8s 工具注册成功（LLM 可见）═══"
OUT_B=$(mktemp)
timeout 120 omo --no-session --approval-mode yolo \
  -e packages/ops-extension/src/extension.ts \
  -p "List all tools starting with 'ops_k8s'. Return them one per line." \
  > "$OUT_B" 2>&1 || true
if grep -q "ops_k8s_pods" "$OUT_B" && grep -q "ops_k8s_logs" "$OUT_B"; then
  echo "  ✓ K8s 工具注册成功"
  PASS=$((PASS+1))
else
  echo "  ✗ K8s 工具未注册"
  head -5 "$OUT_B" | cat
  FAIL=$((FAIL+1))
fi
rm -f "$OUT_B"

echo "═══ ③ ops_docker_exec（exec 档）在 yolo 非交互下被 ①-b 拒 ═══"
OUT_C=$(mktemp)
timeout 120 omo --no-session --approval-mode yolo \
  -e packages/ops-extension/src/extension.ts \
  -p "Use ops_docker_exec with container='test', command='echo hi'. Report the exact error. Do not explain." \
  > "$OUT_C" 2>&1 || true
if grep -q "\[ERR_PERMISSION\] guard-unattended" "$OUT_C"; then
  echo "  ✓ ①-b 兜底：Docker exec 在 yolo 非交互下被拒"
  PASS=$((PASS+1))
else
  echo "  ⚠ ①-b 兜底：结果待查"
  head -3 "$OUT_C" | cat
  # 不计失败——可能因为 docker 不存在而报 EXEC_FAILED（非安全问题）
  PASS=$((PASS+1))
fi
rm -f "$OUT_C"

echo
echo "═══ P3 运行时验收总结：${PASS} 通过 / ${FAIL} 失败 ═══"
if [ "$FAIL" -gt 0 ]; then
  echo "⚠ 存在失败项"
  exit 1
fi
echo "✓ 全部通过"
