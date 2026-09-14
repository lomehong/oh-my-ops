#!/usr/bin/env bash
# OPSAUDIT-3 契约验收：/ops-audit 读取面数据平面探针（方案 §5 T5）
# 验证项：
#   ① 会话分支中的 ops_audit 条目可被 toAuditViews 按信封判据收窄（≥2 条：read + blocked 两类）
#   ② 种子条目 tool/ts/authz 字段可辨（undefined 面为零）
#   ③ formatAuditReport 头部含可读范围声明；被拒条目 reasonClass/reason 可辨
# 说明：写入侧用与 hooks.ts/commands.ts 同款 appendEntry 形状（见 probes/ops-audit-dataplane-probe.ts）；
#       命令 UI 面由 audit-view.test.ts 单测覆盖，交互端到端为人工冒烟（方案 U2，O19/H4）。
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(git rev-parse --show-toplevel)"

OUT_DIR=$(mktemp -d)
trap 'rm -rf "$OUT_DIR"' EXIT
PROBE_OUT="$OUT_DIR/out.json"

echo "═══ ops_audit 数据面：分支条目 → toAuditViews 收窄（真实 omp 会话）═══"
OPS_AUDIT_PROBE_OUT_DIR="$OUT_DIR" timeout 120 \
  bash bin/omo --approval-mode yolo \
  -e packages/ops-extension/test/runtime/probes/ops-audit-dataplane-probe.ts \
  -p "回复 ok。不要调用任何工具。" > "$OUT_DIR/run.log" 2>&1 || true

if [ ! -s "$PROBE_OUT" ]; then
  echo "  ✗ 探针未产出（session_start/turn_end 均未 dump，getBranch 面不可用？）"
  head -8 "$OUT_DIR/run.log"; exit 1
fi

PASS=0; FAIL=0
check() { # $1=描述 $2=期望布尔
  if [ "$2" = "1" ]; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1"; FAIL=$((FAIL+1)); fi
}

COUNT=$(node -e "const d=require('$PROBE_OUT'); console.log(d.count)")
SEEDED_OK=$(node -e "
const d=require('$PROBE_OUT');
const ok = d.count >= 2
  && d.seeded.length === 2
  && d.seeded.every(v => typeof v.tool==='string' && typeof v.ts==='string' && typeof v.authz==='string');
console.log(ok ? 1 : 0)")
REPORT_OK=$(node -e "
const d=require('$PROBE_OUT');
const r = String(d.report||'');
const ok = r.includes('可读范围=当前会话分支') && r.includes('blocked') && r.includes('ERR_PERMISSION') && !/\n.*第二行文本/.test(r.split('\n').filter(l=>l.includes('ops_service'))[0]||'');
console.log(ok ? 1 : 0)")

check "① 分支收窄 ≥2 条且种子条目字段可辨（count=$COUNT）" "$SEEDED_OK"
check "② 报告头含可读范围声明 + blocked/ERR_PERMISSION 可辨 + reason 单行化" "$REPORT_OK"

echo "═══ 结果：$PASS 过 / $FAIL 败 ═══"
[ "$FAIL" = "0" ]
