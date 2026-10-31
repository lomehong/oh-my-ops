#!/usr/bin/env bash
# KBCP 契约验收：KB 控制面安装分发 + 管理 token + 双监听 + 实例上报 + 审计过滤 + 门禁/密钥轮换 + 安装包装脚本 e2e
# 覆盖票据：KBCP-P0-2/P0-3/P0-4/P0-6/P1-1/P1-2/P1-3（el7 为模拟分支；真机 el7 探针另行记账）
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v cygpath >/dev/null 2>&1 && REPO_ROOT="$(cygpath -m "$REPO_ROOT")"
INSTALLER="$REPO_ROOT/scripts/install-enroll-service.sh"
. "$REPO_ROOT/scripts/lib/proc.sh"
TMP="$(mktemp -d)"
cleanup() {
  set +e
  for f in "$TMP/pid-stub" "${H:-}/.omo-kb/service.pid"; do [ -f "$f" ] && proc_kill "$(cat "$f" 2>/dev/null)"; done
  rm -rf "$TMP" 2>/dev/null || true
  return 0
}
trap cleanup EXIT
FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=$((FAILED + 1)); }

PORT=$(( (RANDOM % 2000) + 20000 ))
STUB_PORT=$(( PORT + 1 ))
UI_PORT=$(( PORT + 2 ))
H="$TMP/home"; mkdir -p "$H/.local/bin"
UI="http://127.0.0.1:$UI_PORT"
CP="https://127.0.0.1:$PORT"
HDR="X-Auth-Username: cp-tester"

echo "installer: $INSTALLER"
# 桩 Gitea（与 kb-ui 探针同语义：建号/团队/授权/自证）
cat > "$TMP/stub.mjs" <<EOF
const protections = []; const hooks = [];
Bun.serve({ port: $STUB_PORT, async fetch(req) {
  const u = new URL(req.url);
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  if (u.pathname.endsWith("/admin/users") && req.method === "GET") return json([], 200);
  if (u.pathname.endsWith("/admin/users") && req.method === "POST") return json({ id: 9 }, 201);
  if (u.pathname.includes("/teams/search")) return json({ ok: true, data: [] }, 200);
  if (/\/teams\/\d+$/.test(u.pathname) && req.method === "POST") return json({ id: 7 }, 201);
  if (u.pathname.includes("/teams/7/repos/")) return json({}, 204);
  if (u.pathname.includes("/teams/7/members/")) return json({}, 204);
  if (u.pathname.endsWith("/repos/acme/kb")) return json({ full_name: "acme/kb", private: true, default_branch: "main" }, 200);
  if (u.pathname.includes("/collaborators/")) return json({ message: "user does not exist" }, 404);
  if (u.pathname.endsWith("/branch_protections") && req.method === "GET") return json(protections, 200);
  if (u.pathname.endsWith("/branch_protections") && req.method === "POST") { const b = await req.json(); protections.push(b); return json(b, 201); }
  if (u.pathname.includes("/branch_protections/") && req.method === "PATCH") return json({ branch_name: "main" }, 200);
  if (u.pathname.endsWith("/hooks") && req.method === "GET") return json(hooks, 200);
  if (u.pathname.endsWith("/hooks") && req.method === "POST") { const b = await req.json(); b.id = 5; hooks.push(b); return json(b, 201); }
  return json({ version: "1.21.0" }, 200);
} });
console.log("STUB_READY");
EOF
bun "$TMP/stub.mjs" >"$TMP/stub.log" 2>&1 &
echo $! > "$TMP/pid-stub"
for _ in $(seq 1 20); do grep -q STUB_READY "$TMP/stub.log" 2>/dev/null && break; sleep 0.2; done

printf 'token good-token\n' > "$TMP/good.token"; chmod 600 "$TMP/good.token"
HOME="$H" bash "$INSTALLER" --api "http://127.0.0.1:$STUB_PORT/api/v1" --repo acme/kb \
     --admin-token-file "$TMP/good.token" --self-signed 127.0.0.1 --port "$PORT" --no-start >"$TMP/install.log" 2>&1 \
  || { echo "安装失败：$(tail -3 "$TMP/install.log")"; exit 1; }
sed -i 's/^OMO_KB_UI=off/OMO_KB_UI=on/' "$H/.omo-kb/config.env"
sed -i "s/^OMO_KB_UI_PORT=.*/OMO_KB_UI_PORT=$UI_PORT/" "$H/.omo-kb/config.env"
printf '\nOMO_KB_WEBHOOK_SECRET=test-secret\nOMO_KB_LINT_MODE=warn\n' >> "$H/.omo-kb/config.env"
HOME="$H" "$H/.local/bin/omo-kb" start >>"$TMP/start.log" 2>&1 || true
for _ in $(seq 1 30); do curl -sk --max-time 2 "$CP/healthz" 2>/dev/null | grep -q '"ok":true' && break; sleep 0.5; done
ADMIN="$(cat "$H/.omo-kb/control-plane/admin.token")"
AUTH="Authorization: Bearer $ADMIN"

echo "[0] 管理 token 与双监听"
[ "$(curl -sS -o /dev/null -w '%{http_code}' "$UI/ui/api/state")" = "401" ] && pass "管理 API 无 token ⇒ 401" || fail "管理 API 未要求 token"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$CP/ui")" = "404" ] && pass "主监听不暴露 /ui" || fail "主监听暴露 /ui"
STATE="$(curl -sS --max-time 3 "$UI/ui/api/state" -H "$AUTH" -H "$HDR")"
echo "$STATE" | grep -q '"actor":"cp-tester"' && pass "管理 token + yufu 头 actor 可辨" || fail "actor 异常"
PIN="$(printf '%s' "$STATE" | grep -o '"tlsPin":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
[ -n "$PIN" ] && pass "state 返回 TLS SPKI pin" || fail "state 缺 TLS pin"

echo "[1] 登记版本并上传制品"
V="v-test-cp"
R="$(curl -sS --max-time 5 "$UI/ui/api/installers" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"version\":\"$V\",\"channel\":\"stable\",\"manifest\":{\"version\":\"$V\",\"platforms\":[]}}")"
echo "$R" | grep -q '"ok":true' && pass "登记安装版本" || fail "登记失败：$(printf '%s' "$R" | head -c 200)"
mkdir -p "$TMP/dummyroot/scripts"
printf '#!/usr/bin/env bash\necho dummy-install\n' > "$TMP/dummyroot/scripts/install.sh"
tar czf "$TMP/dummy.tar.gz" -C "$TMP/dummyroot" .
ART_EXPECT="$(sha256sum "$TMP/dummy.tar.gz" | awk '{print $1}')"
UP="$(curl -sS --max-time 20 -X POST "$UI/ui/api/installers/$V/artifacts?name=dummy.tar.gz&os=linux&arch=x86_64" -H "$AUTH" --data-binary @"$TMP/dummy.tar.gz")"
echo "$UP" | grep -q '"ok":true' && pass "上传制品并本地重算哈希" || fail "上传失败：$(printf '%s' "$UP" | head -c 200)"
echo "$UP" | grep -q '"sha256"' && pass "上传响应含服务端 sha256" || fail "上传响应缺 sha256"
ART_HASH="$(printf '%s' "$UP" | grep -o '"sha256":"[0-9a-f]*"' | cut -d'"' -f4)"
[ "$ART_HASH" = "$ART_EXPECT" ] && pass "制品哈希与内容一致" || fail "制品哈希不一致"

echo "[2] 安装令牌与 manifest/script/artifact"
TOK_RES="$(curl -sS --max-time 5 "$UI/ui/api/install-tokens" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"version\":\"$V\",\"channel\":\"stable\",\"device\":\"probe-install\"}")"
TOKEN="$(printf '%s' "$TOK_RES" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
[ -n "$TOKEN" ] && pass "生成一次性安装令牌" || fail "令牌生成失败：$(printf '%s' "$TOK_RES" | head -c 200)"
echo "$TOK_RES" | grep -q 'pinnedpubkey' && pass "命令含 cacert+pin 安装入口" || fail "命令缺 pin 入口"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$CP/install/manifest" -H "Authorization: Bearer bad")" = "401" ] && pass "错误安装令牌 401" || fail "错误令牌未拒绝"
M="$(curl -sk --max-time 5 "$CP/install/manifest?os=linux&arch=x86_64" -H "Authorization: Bearer $TOKEN")"
echo "$M" | grep -q '"artifact_name":"dummy.tar.gz"' && pass "manifest 返回平台制品" || fail "manifest 缺 artifact_name"
echo "$M" | grep -q '"script_sha256"' && pass "manifest 含 script_sha256" || fail "manifest 缺 script_sha256"
S="$(curl -sk --max-time 5 "$CP/install/script" -H "Authorization: Bearer $TOKEN")"
echo "$S" | grep -q 'OMO_TLS_PIN' && pass "script 端点返回安装脚本" || fail "script 端点异常"
curl -sk --max-time 10 "$CP/install/artifacts/dummy.tar.gz" -H "Authorization: Bearer $TOKEN" -o "$TMP/downloaded.tar.gz"
[ "$(sha256sum "$TMP/downloaded.tar.gz" | awk '{print $1}')" = "$ART_HASH" ] && pass "artifact 端点返回制品" || fail "artifact 内容不符"
[ "$(curl -sk --path-as-is -o /dev/null -w '%{http_code}' "$CP/install/artifacts/..%2Fdummy.tar.gz" -H "Authorization: Bearer $TOKEN")" = "400" ] || [ "$(curl -sk --path-as-is -o /dev/null -w '%{http_code}' "$CP/install/artifacts/..%2Fdummy.tar.gz" -H "Authorization: Bearer $TOKEN")" = "404" ] && pass "制品路径穿越拒绝" || fail "路径穿越未拒绝"

echo "[3] install-remote.sh 现代 TLS 路径 dry-run"
printf '%s' "$TOKEN" > "$TMP/install.token"; chmod 600 "$TMP/install.token"
CA="$H/.omo-kb/tls/cert.pem"
printf '%s' "$S" > "$TMP/install-remote.sh"; chmod 700 "$TMP/install-remote.sh"
mkdir -p "$TMP/dry"
if OMO_CONTROL_PLANE="$CP" OMO_TLS_PIN="$PIN" OMO_TLS_CA_FILE="$CA" OMO_INSTALL_TOKEN_FILE="$TMP/install.token" \
   OMO_INSTALL_DEVICE="probe-install" OMO_INSTALL_DRY_RUN=1 OMO_INSTALL_TMPDIR="$TMP/dry" \
   OMO_INSTALL_OS="linux" OMO_INSTALL_ARCH="x86_64" \
   bash "$TMP/install-remote.sh" >"$TMP/dry.log" 2>&1; then
  pass "安装脚本 dry-run 完成（cacert+pin/manifest/artifact 校验）"
else
  fail "dry-run 失败：$(tail -8 "$TMP/dry.log" | tr '\n' ' ')"
fi

echo "[4] 安装接入与 report"
E="$(curl -sk --max-time 8 "$CP/install/enroll" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"device":"probe-install"}')"
echo "$E" | grep -q '"ok":true' && pass "安装令牌兑换凭据" || fail "安装接入失败：$(printf '%s' "$E" | head -c 240)"
echo "$E" | grep -q '"credential"' && pass "返回 credential" || fail "响应缺 credential"
REPORT_TOKEN="$(printf '%s' "$E" | grep -o '"report_token":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
INSTALL_ID="$(printf '%s' "$E" | grep -o '"installId":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
[ -n "$REPORT_TOKEN" ] && [ -n "$INSTALL_ID" ] && pass "返回实例上报令牌与 installId" || fail "响应缺 report_token/installId"
REP="$(curl -sk --max-time 5 "$CP/install/report" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"stage":"verified","ok":true,"device":"probe-install","version":"v-test-cp"}')"
echo "$REP" | grep -q '"ok":true' && pass "report verified 成功" || fail "report 失败"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$CP/install/manifest" -H "Authorization: Bearer $TOKEN")" = "409" ] && pass "完成后安装令牌重放 409" || fail "完成后仍可重放"

echo "[4b] 实例上报令牌（长期状态上报）"
ST="$(curl -sk --max-time 5 "$CP/install/report" -H "Authorization: Bearer $REPORT_TOKEN" -H 'Content-Type: application/json' -d '{"stage":"status","device":"probe-install","ok":true,"lastSync":"2026-10-30T00:00:00Z","version":"v-test-cp"}')"
echo "$ST" | grep -q '"ok":true' && pass "report token 上报状态成功（安装令牌完成后仍可用）" || fail "report token 上报失败：$(printf '%s' "$ST" | head -c 200)"
ST2="$(curl -sk --max-time 5 "$CP/install/report" -H "Authorization: Bearer $REPORT_TOKEN" -H 'Content-Type: application/json' -d '{"stage":"status","device":"probe-install","ok":true}')"
echo "$ST2" | grep -q '"ok":true' && pass "重复上报幂等" || fail "重复上报失败"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$CP/install/report" -H "Authorization: Bearer $REPORT_TOKEN" -H 'Content-Type: application/json' -d '{"stage":"status","device":"other-device","ok":true}')" = "403" ] && pass "上报令牌设备不匹配 403" || fail "设备不匹配未拒绝"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$CP/install/report" -H "Authorization: Bearer omoreport_bogus" -H 'Content-Type: application/json' -d '{"stage":"status","device":"probe-install","ok":true}')" = "401" ] && pass "伪造上报令牌 401" || fail "伪造上报令牌未拒绝"
INST="$(curl -sS --max-time 5 "$UI/ui/api/instances" -H "$AUTH" -H "$HDR")"
echo "$INST" | grep -q 'probe-install' && pass "实例页数据出现" || fail "实例未登记"
echo "$INST" | grep -q '"online":false' && pass "不宣称实时在线" || fail "实例视图缺 online=false"
echo "$INST" | grep -q '"reportToken":true' && pass "实例页显示上报令牌已签发（不含哈希）" || fail "实例缺 reportToken 标记"
echo "$INST" | grep -q 'omoreport_' && fail "实例页泄露上报令牌明文" || pass "实例页不含上报令牌明文"

echo "[4c] 审计过滤与安装历史"
AU="$(curl -sS --max-time 5 "$UI/ui/api/audit?event=install.&installId=$INSTALL_ID&limit=50" -H "$AUTH" -H "$HDR")"
echo "$AU" | grep -q '"event":"install.manifest"' && pass "审计含 manifest 阶段" || fail "审计缺 manifest"
echo "$AU" | grep -q '"event":"install.script"' && pass "审计含 script 阶段" || fail "审计缺 script"
echo "$AU" | grep -q '"event":"install.artifact"' && pass "审计含 artifact 阶段" || fail "审计缺 artifact"
echo "$AU" | grep -q '"event":"install.report"' && pass "审计含 report 阶段" || fail "审计缺 report"
echo "$AU" | grep -q "$REPORT_TOKEN" && fail "审计泄露上报令牌" || pass "审计不含上报令牌"
AU2="$(curl -sS --max-time 5 "$UI/ui/api/audit?event=install.&actor=nobody&limit=50" -H "$AUTH" -H "$HDR")"
echo "$AU2" | grep -q '"audit":\[\]' && pass "actor 过滤生效" || fail "actor 过滤异常：$(printf '%s' "$AU2" | head -c 160)"

echo "[4b2] registry 有记录 ≠ 在线；旋转/吊销入审计（AC-M02/M03）"
MANUAL_CODE="$(bun "$REPO_ROOT/scripts/ops-kb-provision.mjs" code --registry "$H/.omo-kb/registry.json" --op enroll --device manual-only --raw)"
MANUAL_ENROLL="$(curl -sk --max-time 8 "$CP/enroll" -H 'Content-Type: application/json' -d "{\"code\":\"$MANUAL_CODE\",\"device\":\"manual-only\"}")"
echo "$MANUAL_ENROLL" | grep -q '"ok":true' && pass "手工码兑换成功（仅登记，无上报）" || fail "手工兑换失败：$(printf '%s' "$MANUAL_ENROLL" | head -c 200)"
MANUAL_INST="$(curl -sS --max-time 5 "$UI/ui/api/instances" -H "$AUTH" -H "$HDR")"
echo "$MANUAL_INST" | grep -q 'manual-only' && fail "registry 条目被误显示为实例（在线）" || pass "★ registry 有记录但未上报 ⇒ 不出现在实例页"
ROT="$(curl -sS --max-time 5 "$UI/ui/api/instances/$INSTALL_ID/rotate" -H "$AUTH" -H "$HDR" -X POST)"
echo "$ROT" | grep -q '"code"' && pass "实例轮换签发一次性码" || fail "实例轮换失败：$(printf '%s' "$ROT" | head -c 160)"
AU_INST="$(curl -sS --max-time 5 "$UI/ui/api/audit?event=ui.instance.&installId=$INSTALL_ID&limit=20" -H "$AUTH" -H "$HDR")"
echo "$AU_INST" | grep -q '"event":"ui.instance.rotate"' && pass "轮换入审计" || fail "轮换未入审计"
echo "$AU_INST" | grep -q '"actor":"cp-tester"' && pass "审计 actor 可辨（yufu 头）" || fail "审计 actor 缺失"
echo "$AU_INST" | grep -q '"code"' && fail "审计泄露一次性码" || pass "审计不含一次性码"

echo "[4b3] 吊销实例后上报令牌即时失效"
RV="$(curl -sS --max-time 5 "$UI/ui/api/instances/$INSTALL_ID/revoke" -H "$AUTH" -H "$HDR" -X POST)"
echo "$RV" | grep -q '"code"' && pass "实例吊销签发 revoke 码" || fail "实例吊销失败：$(printf '%s' "$RV" | head -c 160)"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$CP/install/report" -H "Authorization: Bearer $REPORT_TOKEN" -H 'Content-Type: application/json' -d '{"stage":"status","device":"probe-install","ok":true}')" = "403" ] && pass "吊销后上报 403" || fail "吊销后上报未拒绝"
INST2="$(curl -sS --max-time 5 "$UI/ui/api/instances" -H "$AUTH" -H "$HDR")"
echo "$INST2" | grep -q '"status":"revoked"' && pass "实例状态标记 revoked" || fail "实例未标记 revoked"
echo "$INST2" | grep -q '"reportToken":false' && pass "吊销后令牌标记失效" || fail "吊销后令牌仍标记可用"

echo "[5] 门禁 apply/status（Gitea 分支保护 + webhook）"
G="$(curl -sS --max-time 10 "$UI/ui/api/gate/apply" -H "$AUTH" -H "$HDR" -X POST)"
echo "$G" | grep -q '"ok":true' && pass "门禁 apply 成功" || fail "门禁 apply 失败：$(printf '%s' "$G" | head -c 220)"
GS="$(curl -sS --max-time 5 "$UI/ui/api/gate" -H "$AUTH" -H "$HDR")"
echo "$GS" | grep -q '"branchProtection":{"configured":true' && pass "分支保护 observed=true" || fail "分支保护未观测到"
echo "$GS" | grep -q '"webhook":{"configured":true' && pass "webhook observed=true" || fail "webhook 未观测到"

echo "[6] webhook 验签与 secret 轮换（双密钥 24h 宽限）"
sign() { printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>console.log(require("node:crypto").createHmac("sha256",process.argv[1]).update(d).digest("hex")))' "$2"; }
WB_BODY='{"action":"closed","pull_request":{"base":{"ref":"main"},"head":{"sha":"0000000000000000000000000000000000000000"}},"repository":{"full_name":"acme/kb"}}'
OLD_SECRET="test-secret"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$CP/kb/webhook" -H 'Content-Type: application/json' -H "X-Gitea-Signature: $(sign "$WB_BODY" "$OLD_SECRET")" --data-binary "$WB_BODY")" = "200" ] && pass "旧密钥签名被接受（轮换前）" || fail "旧密钥签名被拒"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$CP/kb/webhook" -H 'Content-Type: application/json' -H "X-Gitea-Signature: $(sign "$WB_BODY" "wrong")" --data-binary "$WB_BODY")" = "401" ] && pass "错误签名 401" || fail "错误签名未拒绝"
ROT="$(curl -sS --max-time 10 "$UI/ui/api/secret/rotate" -H "$AUTH" -H "$HDR" -X POST)"
echo "$ROT" | grep -q '"secret":"whsec_' && pass "轮换返回新密钥（仅本次）" || fail "轮换失败：$(printf '%s' "$ROT" | head -c 220)"
NEW_SECRET="$(printf '%s' "$ROT" | grep -o '"secret":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
echo "$ROT" | grep -q '"previousExpiresAt"' && pass "返回旧密钥宽限截止时间" || fail "缺 previousExpiresAt"
for _ in $(seq 1 60); do
  SB="$(curl -sk --max-time 2 "$UI/ui/api/state" -H "$AUTH" 2>/dev/null || true)"
  echo "$SB" | grep -q '"previousActive":true' && break
  sleep 0.5
done
echo "$SB" | grep -q '"previousActive":true' && pass "重启后旧密钥宽限生效（previousActive=true）" || fail "重启后宽限标记缺失"
CLOSE_EARLY="$(curl -sS --max-time 5 "$UI/ui/api/secret/close" -H "$AUTH" -H "$HDR" -X POST)"
echo "$CLOSE_EARLY" | grep -q "尚未观测到新密钥验签成功" && pass "★ 未观测到新密钥验签 ⇒ 关闭宽限被拒" || fail "关闭宽限条件未生效：$(printf '%s' "$CLOSE_EARLY" | head -c 160)"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$CP/kb/webhook" -H 'Content-Type: application/json' -H "X-Gitea-Signature: $(sign "$WB_BODY" "$NEW_SECRET")" --data-binary "$WB_BODY")" = "200" ] && pass "新密钥签名被接受" || fail "新密钥签名被拒"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$CP/kb/webhook" -H 'Content-Type: application/json' -H "X-Gitea-Signature: $(sign "$WB_BODY" "$OLD_SECRET")" --data-binary "$WB_BODY")" = "200" ] && pass "旧密钥在宽限内仍接受" || fail "旧密钥宽限失效"
GS2="$(curl -sS --max-time 5 "$UI/ui/api/gate" -H "$AUTH" -H "$HDR")"
echo "$GS2" | grep -q '"lastVerifiedAt"' && pass "健康面显示最近成功验签" || fail "缺最近验签时间"
CLOSE="$(curl -sS --max-time 5 "$UI/ui/api/secret/close" -H "$AUTH" -H "$HDR" -X POST)"
echo "$CLOSE" | grep -q '"ok":true' && pass "★ 验签成功后关闭宽限" || fail "关闭宽限失败：$(printf '%s' "$CLOSE" | head -c 200)"
for _ in $(seq 1 60); do
  SB2="$(curl -sk --max-time 2 "$UI/ui/api/state" -H "$AUTH" 2>/dev/null || true)"
  echo "$SB2" | grep -q '"previousActive":false' && break
  sleep 0.5
done
echo "$SB2" | grep -q '"previousActive":false' && pass "重启后宽限已关闭" || fail "宽限关闭未生效"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$CP/kb/webhook" -H 'Content-Type: application/json' -H "X-Gitea-Signature: $(sign "$WB_BODY" "$OLD_SECRET")" --data-binary "$WB_BODY")" = "401" ] && pass "关闭后旧密钥 401" || fail "关闭后旧密钥仍可用"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$CP/kb/webhook" -H 'Content-Type: application/json' -H "X-Gitea-Signature: $(sign "$WB_BODY" "$NEW_SECRET")" --data-binary "$WB_BODY")" = "200" ] && pass "关闭后新密钥仍有效" || fail "关闭后新密钥失效"
AU3="$(curl -sS --max-time 5 "$UI/ui/api/audit?event=ui.gate.secret&limit=20" -H "$AUTH" -H "$HDR")"
echo "$AU3" | grep -q '"event":"ui.gate.secret.rotated"' && pass "轮换入审计" || fail "轮换未入审计"
echo "$AU3" | grep -q '"event":"ui.gate.secret.window_closed"' && pass "关闭宽限入审计" || fail "关闭未入审计"
echo "$AU3" | grep -q "$NEW_SECRET" && fail "审计泄露新密钥" || pass "审计不含密钥本体"

echo "[7] 安装包装脚本端到端（临时 HOME；失败注入；el7 legacy 模拟）"
REAL_CURL="$(command -v curl)"
# 7.0 真实安装包：install.sh 安装 omo 垫片（调用真实 enroll/report 客户端代码；git 自证在 e2e 中以本地状态替代）
mkdir -p "$TMP/e2e-root/scripts"
cat > "$TMP/shim.ts" <<SHIMEOF
import * as fs from "node:fs";
import * as path from "node:path";
import { enroll, loadKbInstallState, reportInstallStatus } from "file:///$REPO_ROOT/packages/ops-extension/src/kb-enroll.ts";
import { loadKbCredential } from "file:///$REPO_ROOT/packages/ops-extension/src/kb-credential.ts";
const argv = process.argv.slice(2);
const omoDir = path.join(process.env.HOME ?? "", ".omo");
const device = process.env.OMO_INSTALL_DEVICE ?? "e2e-device";
if (argv[0] === "kb" && argv[1] === "enroll") {
  const i = argv.indexOf("--response-file");
  if (i < 0) { console.error("shim: 缺 --response-file"); process.exit(2); }
  const r = await enroll({ server: "https://shim.invalid", code: "", device, responseFile: argv[i + 1] }, omoDir);
  fs.writeFileSync(path.join(omoDir, "kb", "state.json"), JSON.stringify({ lastSyncAt: new Date().toISOString(), ok: true, mainBranch: "main", instanceBranch: "instance/" + device, actions: ["e2e: 跳过 git 自证（无 git 远端）"] }, null, 2));
  console.log(r.message);
  process.exit(0);
}
if (argv[0] === "kb" && argv[1] === "status") {
  const install = await loadKbInstallState(omoDir);
  const cred = await loadKbCredential(omoDir);
  if (install === undefined || cred === undefined) { console.error("shim: 凭据或安装态缺失"); process.exit(1); }
  if (argv.includes("--report")) {
    const r = await reportInstallStatus(install, { device, ok: true, lastSync: new Date().toISOString(), version: install.version });
    if (!r.ok) { console.error("shim report: " + r.message); process.exit(1); }
    console.log(r.message);
  } else {
    console.log("shim status ok: " + cred.username + " install=" + install.installId);
  }
  process.exit(0);
}
console.error("shim: unsupported " + argv.join(" "));
process.exit(2);
SHIMEOF
cat > "$TMP/e2e-root/scripts/install.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "\$HOME/.omo/kb" "\$HOME/.omo/home" "\$HOME/.omo/knowledge" "\$HOME/.local/bin"
cat > "\$HOME/.local/bin/omo" <<'SHIM'
#!/usr/bin/env bash
exec bun "$TMP/shim.ts" "\$@"
SHIM
chmod 700 "\$HOME/.local/bin/omo"
EOF
tar czf "$TMP/e2e.tar.gz" -C "$TMP/e2e-root" .
E2E_EXPECT="$(sha256sum "$TMP/e2e.tar.gz" | awk '{print $1}')"
EV="v-e2e"
curl -sS --max-time 5 "$UI/ui/api/installers" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"version\":\"$EV\",\"channel\":\"stable\",\"manifest\":{\"version\":\"$EV\",\"platforms\":[]}}" >/dev/null
UP2="$(curl -sS --max-time 20 -X POST "$UI/ui/api/installers/$EV/artifacts?name=e2e.tar.gz&os=linux&arch=x86_64" -H "$AUTH" --data-binary @"$TMP/e2e.tar.gz")"
echo "$UP2" | grep -q "\"sha256\":\"$E2E_EXPECT\"" && pass "e2e 安装包已登记（服务端哈希一致）" || fail "e2e 包登记失败"

issue_e2e_token() {
  local res
  res="$(curl -sS --max-time 5 "$UI/ui/api/install-tokens" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"version\":\"$EV\",\"channel\":\"stable\",\"device\":\"e2e-device\"}")"
  printf '%s' "$res" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4
}
run_installer() { # $1=HOME $2=token $3=pin; 其余 KEY=VALUE 追加为环境
  local home="$1" tok="$2" pin="$3"; shift 3
  printf '%s' "$tok" > "$TMP/e2e.token"; chmod 600 "$TMP/e2e.token"
  env HOME="$home" REAL_CURL="$REAL_CURL" "$@" \
    OMO_CONTROL_PLANE="$CP" OMO_TLS_PIN="$pin" OMO_TLS_CA_FILE="$H/.omo-kb/tls/cert.pem" \
    OMO_INSTALL_TOKEN_FILE="$TMP/e2e.token" OMO_INSTALL_DEVICE="e2e-device" \
    OMO_INSTALL_OS="linux" OMO_INSTALL_ARCH="x86_64" \
    bash "$TMP/install-remote.sh"
}

# 7.1 现代 curl：错误 pin ⇒ 早期失败且未落盘
FAIL_HOME="$TMP/e2e-fail-pin"; mkdir -p "$FAIL_HOME"
if run_installer "$FAIL_HOME" "$(issue_e2e_token)" "sha256//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" >"$TMP/e2e-failpin.log" 2>&1; then
  fail "错误 pin 仍安装成功"
else
  pass "错误 pin 安装失败（未放行）"
fi
[ ! -d "$FAIL_HOME/.omo" ] && pass "失败注入：未执行安装（无 ~/.omo）" || fail "失败后仍创建了 ~/.omo"

# 7.2 既有 ~/.omo 默认拒绝覆盖
PRE_HOME="$TMP/e2e-pre"; mkdir -p "$PRE_HOME/.omo"
if run_installer "$PRE_HOME" "$(issue_e2e_token)" "$PIN" >"$TMP/e2e-pre.log" 2>&1; then
  fail "既有 ~/.omo 未被拦截"
else
  grep -q "检测到既有 ~/.omo" "$TMP/e2e-pre.log" && pass "既有 ~/.omo 默认拒绝覆盖（提示 --upgrade）" || fail "拦截原因不符：$(tail -3 "$TMP/e2e-pre.log" | tr '\n' ' ')"
fi

# 7.3 el7 legacy 模拟：假 curl 谎报 7.29 且 --help 无 pinnedpubkey；正确 pin 走 openssl 校验
FAKEBIN="$TMP/fakebin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/curl" <<'FAKECURL'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    --version) echo "curl 7.29.0 (x86_64-redhat-linux-gnu) libcurl/7.29.0 NSS/3.53"; exit 0;;
    --help) echo "Usage: curl [options...] <url>"; echo " -f, --fail  Fail silently"; exit 0;;
  esac
done
exec "$REAL_CURL" "$@"
FAKECURL
chmod 700 "$FAKEBIN/curl"
LEGACY_HOME="$TMP/e2e-legacy"; mkdir -p "$LEGACY_HOME"
if run_installer "$LEGACY_HOME" "$(issue_e2e_token)" "$PIN" PATH="$FAKEBIN:$PATH" >"$TMP/e2e-legacy.log" 2>&1; then
  pass "el7 legacy 路径安装成功（openssl pin + --config 头文件）"
else
  fail "legacy 安装失败：$(tail -8 "$TMP/e2e-legacy.log" | tr '\n' ' ')"
fi
grep -q "legacy curl 7.29.0" "$TMP/e2e-legacy.log" && pass "确认走 legacy 分支" || fail "未走 legacy 分支"
[ -f "$LEGACY_HOME/.omo/kb/credential.json" ] && pass "legacy：凭据落盘" || fail "legacy：凭据缺失"
[ -f "$LEGACY_HOME/.omo/kb/control-plane-ca.pem" ] && pass "legacy：CA 已保存到私有域" || fail "legacy：CA 未保存"

# 7.4 el7 legacy 错误 pin ⇒ openssl 校验早期拒绝
if run_installer "$TMP/e2e-legacy-bad" "$(issue_e2e_token)" "sha256//WRONG" PATH="$FAKEBIN:$PATH" >"$TMP/e2e-legacy-bad.log" 2>&1; then
  fail "legacy 错误 pin 仍安装成功"
else
  grep -q "CA 公钥 pin 不匹配（legacy）" "$TMP/e2e-legacy-bad.log" && pass "legacy 错误 pin 明确拒绝" || fail "legacy 错误 pin 拒绝原因不符"
fi

# 7.5 curl 过旧 ⇒ 明确失败
OLD_HOME="$TMP/e2e-old"; mkdir -p "$OLD_HOME" "$TMP/fakebin-old"
cat > "$TMP/fakebin-old/curl" <<'OLDCURL'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    --version) echo "curl 7.20.0 (x86_64-redhat-linux-gnu) libcurl/7.20.0"; exit 0;;
    --help) echo "Usage: curl [options...] <url>"; exit 0;;
  esac
done
exit 1
OLDCURL
chmod 700 "$TMP/fakebin-old/curl"
if run_installer "$OLD_HOME" "$(issue_e2e_token)" "$PIN" PATH="$TMP/fakebin-old:$PATH" >"$TMP/e2e-old.log" 2>&1; then
  fail "curl 过旧仍安装成功"
else
  grep -q "过旧" "$TMP/e2e-old.log" && pass "curl 过旧明确失败（≥7.29/≥7.55）" || fail "过旧拒绝原因不符"
fi

# 7.6 现代 curl 全流程（成功；随后用上报令牌做一次 TLS 状态上报）
OK_HOME="$TMP/e2e-ok"; mkdir -p "$OK_HOME"
OK_LOG="$TMP/e2e-ok.log"
if run_installer "$OK_HOME" "$(issue_e2e_token)" "$PIN" >"$OK_LOG" 2>&1; then
  pass "现代 curl 端到端安装成功（临时 HOME）"
else
  fail "现代端到端安装失败：$(tail -10 "$OK_LOG" | tr '\n' ' ')"
fi
grep -q "modern curl" "$OK_LOG" && pass "确认走 modern 分支（cacert+pin）" || fail "未走 modern 分支"
grep -q "KB 接入完成" "$OK_LOG" && pass "KB 接入（真实 enroll 客户端落盘）" || fail "KB 接入未完成"
grep -q "KB 自证完成" "$OK_LOG" && pass "自证通过（本地状态）" || fail "自证失败"
[ -f "$OK_HOME/.omo/kb/credential.json" ] && pass "凭据落盘" || fail "凭据缺失"
[ -f "$OK_HOME/.omo/kb/install.json" ] && pass "安装态落盘（installId/reportToken）" || fail "安装态缺失"
grep -q '"reportToken": *"omoreport_' "$OK_HOME/.omo/kb/install.json" && pass "上报令牌已落盘（只存本机）" || fail "上报令牌未落盘"
grep -q 'control-plane-ca.pem' "$OK_HOME/.omo/kb/install.json" && pass "安装态记录 CA 路径" || fail "安装态缺 CA 路径"
grep -q '检测到既有' "$OK_LOG" && fail "成功路径误报既有目录" || pass "成功路径无既有目录误报"

REPORT_OUT="$(HOME="$OK_HOME" OMO_INSTALL_DEVICE="e2e-device" "$OK_HOME/.local/bin/omo" kb status --report 2>&1 || true)"
echo "$REPORT_OUT" | grep -q "已上报实例状态" && pass "★ 安装令牌完成后，上报令牌经 TLS(CA) 上报成功" || fail "上报失败：$(printf '%s' "$REPORT_OUT" | tail -3 | tr '\n' ' ')"
INST3="$(curl -sS --max-time 5 "$UI/ui/api/instances" -H "$AUTH" -H "$HDR")"
echo "$INST3" | grep -q '"device":"e2e-device"' && pass "实例表出现端到端设备" || fail "实例表缺 e2e-device"
echo "$INST3" | grep -q '"lastSync"' && pass "上报携带最近同步时间" || fail "实例缺 lastSync"

echo "结果：$FAILED 项失败"
exit $([ "$FAILED" -eq 0 ] && echo 0 || echo 1)
