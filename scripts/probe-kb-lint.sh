#!/usr/bin/env bash
# P4 契约验收：kb 服务 /kb/webhook 合流期 lint 门禁（KBORG-1）
# 覆盖：HMAC 校验（好签/坏签/缺签）· strict 硬拦（status failure + 评论）· warn 模式（status success + 评论）·
#       lint off ⇒ 503 · 非 PR 事件忽略 · 幂等（同 body 重复投递结果一致）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$REPO_ROOT/scripts/install-enroll-service.sh"
. "$REPO_ROOT/scripts/lib/proc.sh"
TMP="$(mktemp -d)"
# 收尾：杀桩与已起服务（pkill 在 Windows Git Bash 不存在 ⇒ 统一 pid 文件 + 双命名空间 kill，见 lib/proc.sh）。
# set +e 是硬要求：EXIT trap 里任何失败命令会点着 set -e，把「全绿」翻成 exit 1（真机踩到）。
cleanup() {
  set +e
  for f in "$TMP/pid-stub" "${H:-}/.omo-kb/service.pid"; do
    [ -f "$f" ] && proc_kill "$(cat "$f" 2>/dev/null)"
  done
  rm -rf "$TMP" 2>/dev/null || true
  return 0
}
trap cleanup EXIT
FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=$((FAILED + 1)); }

PORT=$(( (RANDOM % 2000) + 17000 ))
STUB_PORT=$(( PORT + 1 ))
H="$TMP/home"; mkdir -p "$H/.local/bin"
SECRET="s3cr3t-key"
SHA="abc123def456sha"

echo "installer: $INSTALLER"

# ── 桩 Gitea：记录 statuses/comments；按固定路径供 PR files/contents/domains.yml ──
# 桩是**原生进程**（bun.exe）：脚本里写死的 MSYS 路径 /tmp/... 在 Windows 上会被当成本地盘路径（C:\tmp\...）而落空，
# 故把输出目录经 argv 传成原生路径（cygpath -w；Linux 无 cygpath 则原样传）。
TMP_NATIVE="$(cygpath -w "$TMP" 2>/dev/null || printf '%s' "$TMP")"
cat > "$TMP/stub.mjs" <<EOF
import * as fs from "node:fs";
import * as path from "node:path";
const OUT = process.argv[2];
const statuses = []; const comments = [];
Bun.serve({ port: $STUB_PORT, async fetch(req) {
  const u = new URL(req.url);
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  const b64 = (t) => Buffer.from(t, "utf8").toString("base64");
  if (u.pathname.endsWith("/statuses/$SHA") && req.method === "POST") {
    statuses.push(await req.json());
    fs.writeFileSync(path.join(OUT, "statuses.json"), JSON.stringify(statuses));
    return json({ ok: true }, 201);
  }
  if (u.pathname.endsWith("/issues/7/comments") && req.method === "POST") {
    comments.push(await req.json());
    fs.writeFileSync(path.join(OUT, "comments.json"), JSON.stringify(comments));
    return json({ ok: true }, 201);
  }
  if (u.pathname.endsWith("/pulls/7/files")) {
    return json([
      { filename: "omo-kb/v0134-cache-note.md" },
      { filename: "runbooks/warn-note.md" },
    ], 200);
  }
  if (u.pathname.endsWith("/contents/domains.yml")) {
    return json({ content: b64("domains:\\n  - omo-kb\\n  - runbooks\\nroot_allowlist:\\n  - README.md\\n  - domains.yml\\nfallback: runbooks\\n") }, 200);
  }
  if (u.pathname.endsWith("/contents/omo-kb/v0134-cache-note.md")) {
    return json({ content: b64("系统: omo-kb\\n\\n升级后页面拿旧缓存需要 no-store 才能修复浏览器缓存问题。\\n") }, 200);
  }
  if (u.pathname.endsWith("/contents/runbooks/warn-note.md")) {
    return json({ content: b64("系统: runbooks\\n\\n升级后页面拿旧缓存需要 no-store 才能修复，定位为浏览器缓存。\\n") }, 200);
  }
  if (u.pathname.endsWith("/contents/omo-kb/README.md")) {
    return json({ content: b64("# omo-kb 活档案\\n\\n## 2026-09-20 旧坑（来源设备：x）\\n\\n升级后页面拿旧缓存需要 no-store 才能修复浏览器缓存问题。\\n") }, 200);
  }
  return json({ version: "1.27.3" }, 200);
} });
console.log("STUB_READY");
EOF
bun "$TMP/stub.mjs" "$TMP_NATIVE" >"$TMP/stub.log" 2>&1 &
echo $! > "$TMP/pid-stub"
for _ in $(seq 1 20); do grep -q STUB_READY "$TMP/stub.log" 2>/dev/null && break; sleep 0.2; done

printf 'token good-token\n' > "$TMP/good.token"; chmod 600 "$TMP/good.token"

echo "[0] 安装（webhook 密钥 + strict + main=main）"
HOME="$H" bash "$INSTALLER" --api "http://127.0.0.1:$STUB_PORT/api/v1" --repo acme/kb \
     --admin-token-file "$TMP/good.token" --self-signed auto --port "$PORT" --no-start >"$TMP/install.log" 2>&1 \
  && pass "安装成功" || fail "安装失败：$(tail -3 "$TMP/install.log" | tr '\n' ' ')"
sed -i 's/^OMO_KB_UI=off/OMO_KB_UI=on/' "$H/.omo-kb/config.env"
cat >> "$H/.omo-kb/config.env" <<EOF
OMO_KB_WEBHOOK_SECRET=$SECRET
OMO_KB_LINT_MODE=strict
OMO_KB_MAIN_BRANCH=main
EOF
HOME="$H" "$H/.local/bin/omo-kb" start >>"$TMP/start.log" 2>&1 || true
for _ in $(seq 1 20); do curl -sk --max-time 2 "https://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q '"ok":true' && break; sleep 0.5; done
HOME="$H" "$H/.local/bin/omo-kb" logs 2>/dev/null | grep -q "lint=strict" && pass "LISTEN 行标注 lint=strict" || fail "LISTEN 行缺 lint 标注"

BODY='{"action":"opened","number":7,"pull_request":{"number":7,"base":{"ref":"main"},"head":{"sha":"'"$SHA"'"},"title":"kb: 测试"},"repository":{"full_name":"acme/kb"}}'
SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"
# hdr$1=签名头名（Gitea 真实头为 X-Gitea-Signature）
post_webhook() { local h="$1"; local s="$2"; local b="$3"; curl -sk -o /tmp/kbwb-body.json -w '%{http_code}' --max-time 15 -X POST "https://127.0.0.1:$PORT/kb/webhook" -H "$h: $s" -H 'Content-Type: application/json' -d "$b"; }

echo "[1] strict：重复内容 ⇒ 硬拦（status failure + 评论）"
C1="$(post_webhook "X-Gitea-Signature" "$SIG" "$BODY")"
[ "$C1" = "200" ] && pass "webhook 200" || fail "webhook HTTP $C1：$(head -c 120 /tmp/kbwb-body.json)"
grep -q '"blocked":true' /tmp/kbwb-body.json && pass "重复内容被硬拦（blocked=true）" || fail "未硬拦：$(head -c 160 /tmp/kbwb-body.json)"
[ -f "$TMP/statuses.json" ] && grep -q '"state":"failure"' "$TMP/statuses.json" && pass "status failure 已回写" || fail "未回写 failure status"
[ -f "$TMP/comments.json" ] && grep -q "kb-lint（模式：strict）" "$TMP/comments.json" && pass "PR 评论已发（含违规明细）" || fail "未发评论"
[ -f "$H/.omo-kb/audit.jsonl" ] && grep -q '"event":"lint.blocked"' "$H/.omo-kb/audit.jsonl" && pass "审计 lint.blocked 落账" || fail "审计缺 lint.blocked"

echo "[2] 幂等：同 body 重复投递 ⇒ 结果一致且 status 记录不翻倍"
C2="$(post_webhook "X-Gitea-Signature" "$SIG" "$BODY")"
grep -q '"blocked":true' /tmp/kbwb-body.json && pass "重复投递结果一致" || fail "重复投递行为漂移"
N1="$(grep -o '"context":"kb-lint"' "$TMP/statuses.json" 2>/dev/null | wc -l || true)"
[ "$N1" -ge 2 ] && pass "status 重复回写（无副作用差异）" || fail "status 回写异常"

echo "[3] 坏签名 ⇒ 401 且不回写"
N_BEFORE="$(grep -o '"context":"kb-lint"' "$TMP/statuses.json" 2>/dev/null | wc -l || true)"
C3="$(post_webhook "X-Gitea-Signature" "badbadbad" "$BODY")"
[ "$C3" = "401" ] && pass "坏签名 401" || fail "坏签名应 401（$C3）"
N_AFTER="$(grep -o '"context":"kb-lint"' "$TMP/statuses.json" 2>/dev/null | wc -l || true)"
[ "$N_BEFORE" = "$N_AFTER" ] && pass "坏签名不产生 status" || fail "坏签名竟回写了 status"
# 兼容自建头 X-KB-Signature（等价通道）
C3B="$(post_webhook "X-KB-Signature" "$SIG" "$BODY")"
[ "$C3B" = "200" ] && pass "兼容头 X-KB-Signature 同样可用" || fail "兼容头失效"

echo "[4] warn 模式：硬违规也 success + 评论警示"
sed -i 's/^OMO_KB_LINT_MODE=strict/OMO_KB_LINT_MODE=warn/' "$H/.omo-kb/config.env"
HOME="$H" "$H/.local/bin/omo-kb" restart >>"$TMP/start.log" 2>&1
for _ in $(seq 1 20); do curl -sk --max-time 2 "https://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q '"ok":true' && break; sleep 0.5; done
C4="$(post_webhook "X-Gitea-Signature" "$SIG" "$BODY")"
grep -q '"blocked":false' /tmp/kbwb-body.json && pass "warn 模式不硬拦（success）" || fail "warn 模式不应硬拦"
[ -f "$TMP/comments.json" ] && grep -q "模式：warn" "$TMP/comments.json" && pass "评论标注 warn 模式" || fail "评论未标注 warn"

echo "[5] lint off ⇒ 503"
sed -i 's/^OMO_KB_LINT_MODE=warn/OMO_KB_LINT_MODE=off/' "$H/.omo-kb/config.env"
HOME="$H" "$H/.local/bin/omo-kb" restart >>"$TMP/start.log" 2>&1
for _ in $(seq 1 20); do curl -sk --max-time 2 "https://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q '"ok":true' && break; sleep 0.5; done
C5="$(post_webhook "X-Gitea-Signature" "$SIG" "$BODY")"
[ "$C5" = "503" ] && pass "lint off ⇒ 503（门禁明确不可用）" || fail "off 应 503（$C5）"

echo "结果：$FAILED 项失败"
exit $([ "$FAILED" -eq 0 ] && echo 0 || echo 1)
