#!/usr/bin/env bash
# P4 契约验收：kb 服务 /ui 管理后台（KBUI-1，方案 docs/designs/omo-kb-web-ui-design.md）
# 覆盖执行记录 V0~V8：默认关 · 身份头门禁 · state 脱敏 · 页面签码→真实兑换闭环 ·
#                 配置校验/预检失败不重启回滚/合法保存自动重启 · 非白名单拒绝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 统一为原生形式（C:/…）：bun/node 是原生程序，MSYS 形式（/e/…）进不了它们的模块解析——
# 经 npm 跑时 PWD 恰好是原生形式所以「碰巧能过」，直接 `bash scripts/probe-kb-ui.sh` 就炸（真机踩到）。
command -v cygpath >/dev/null 2>&1 && REPO_ROOT="$(cygpath -m "$REPO_ROOT")"
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
HDR="X-Auth-Username: tester"

PORT=$(( (RANDOM % 2000) + 19000 ))
STUB_PORT=$(( PORT + 1 ))
H="$TMP/home"; mkdir -p "$H/.local/bin"

echo "installer: $INSTALLER"
[ -f "$REPO_ROOT/scripts/ui/index.html" ] || { echo "✗ 缺 scripts/ui/index.html"; exit 1; }

# ── 桩 Gitea：语义同 probe-install（缺权/校验失败/可达）──
cat > "$TMP/stub.mjs" <<EOF
Bun.serve({ port: $STUB_PORT, fetch(req) {
  const u = new URL(req.url);
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  if (u.pathname.endsWith("/admin/users") && req.method === "GET") return json([], 200);
  if (u.pathname.endsWith("/admin/users") && req.method === "POST") return json({ id: 9 }, 201);
  if (u.pathname.includes("/teams/search")) return json({ ok: true, data: [] }, 200);
  if (/\/teams\/\d+$/.test(u.pathname) && req.method === "POST") return json({ id: 7 }, 201);
  if (u.pathname.includes("/teams/7/repos/")) return json({}, 204);
  if (u.pathname.includes("/teams/7/members/")) return json({}, 204);
  if (u.pathname === "/api/v1/repos/acme/kb" || u.pathname.endsWith("/repos/acme/kb")) return json({ full_name: "acme/kb", private: true, default_branch: "main" }, 200);
  if (u.pathname.includes("/collaborators/")) return json({ message: "user does not exist" }, 404);
  return json({ version: "1.21.0" }, 200);
} });
console.log("STUB_READY");
EOF
bun "$TMP/stub.mjs" >"$TMP/stub.log" 2>&1 &
echo $! > "$TMP/pid-stub"
for _ in $(seq 1 20); do grep -q STUB_READY "$TMP/stub.log" 2>/dev/null && break; sleep 0.2; done

printf 'token good-token\n' > "$TMP/good.token"; chmod 600 "$TMP/good.token"

echo "[0] 配置库单测（kb-ui-config.mjs）"
bun -e '
import { validateValues, parseConfigEnv, renderConfigEnv, writeConfigEnvAtomic, maskConfigForUi, readConfigEnv } from "'"$REPO_ROOT"'/scripts/lib/kb-ui-config.mjs";
import * as fs from "node:fs";
import * as os from "node:os";
const A = (c, m) => { if (!c) { console.error("  ✗ " + m); process.exit(1); } console.log("  ✓ " + m); };
A(validateValues({ OMO_KB_REPO: "bad repo" }).ok === false, "坏 repo 被拒");
A(validateValues({ OMO_KB_ADMIN_TOKEN_FILE: "/x" }).ok === false, "非白名单键整单拒绝");
A(validateValues({ OMO_KB_REPO: "acme/kb", OMO_KB_PORT: "8787", OMO_KB_UI: "on" }).ok === true, "合法值通过");
// 临时目录走 os.tmpdir()：字面量 "/tmp" 是**当前盘符**下的 \tmp（Windows 上未必存在，真机踩到）
const f = fs.mkdtempSync(os.tmpdir() + "/kbui-") + "/config.env";
fs.writeFileSync(f, "# 注释保留\nOMO_KB_REPO=acme/kb\nOMO_KB_TEAM=old\n");
const parsed = readConfigEnv(f);
const out = renderConfigEnv(parsed, { OMO_KB_TEAM: "new", OMO_KB_UI: "on" });
A(out.includes("# 注释保留") && out.includes("OMO_KB_TEAM=new") && out.includes("OMO_KB_UI=on"), "渲染保留注释/原地替换/追加");
writeConfigEnvAtomic(f, out);
const can0600 = (() => { try { const d = fs.mkdtempSync(fs.realpathSync(os.tmpdir()) + "/omo-perm-"); const t = d + "/f"; fs.writeFileSync(t, "x", { mode: 0o600 }); fs.chmodSync(t, 0o600); const m = fs.statSync(t).mode & 0o777; fs.rmSync(d, { recursive: true, force: true }); return m === 0o600 || m === 0o400; } catch { return false; } })();
A(can0600 ? ((fs.statSync(f).mode & 0o777) === 0o600 && fs.existsSync(f + ".bak")) : fs.existsSync(f + ".bak"), can0600 ? "原子写 0600 + .bak" : "原子写 0600（本文件系统不可表达 ⇒ 降级：断言 .bak 与可读）");
A(maskConfigForUi({ OMO_KB_ADMIN_TOKEN_FILE: "/x/t" }).OMO_KB_ADMIN_TOKEN_FILE === "（已配置，不回显）", "凭据键掩码");
fs.rmSync(f, { force: true });
'

echo "[0b] 页面 JS 语法 + 渲染真执行（headless fixture）"
cat > "$TMP/extract-page.mjs" <<'JS'
import * as fs from "node:fs";
const [page, out] = [process.argv[2], process.argv[3]];
const m = /<script>\n([\s\S]*)\n<\/script>/.exec(fs.readFileSync(page, "utf8"));
if (m === null) { console.error("页面未找到 <script> 块"); process.exit(2); }
fs.writeFileSync(out, m[1]);
JS
# 提取用 bun（不依赖 python3 —— Windows 上 python3 常是 Microsoft Store 别名桩：存在但不可用）
if bun "$TMP/extract-page.mjs" "$REPO_ROOT/scripts/ui/index.html" "$TMP/kbui-page-check.mjs" >"$TMP/extract.log" 2>&1; then
  pass "页面 JS 已提取（bun）"
else
  fail "页面 JS 提取失败：$(tail -1 "$TMP/extract.log" | tr '\n' ' ')"
fi
# 产物写进 $TMP（勿用 /dev/null：Windows 上 bun 会把它落成 CWD 的 `nul` 实体文件，污染仓库根——真机踩到）
bun build "$TMP/kbui-page-check.mjs" --target=bun --outfile "$TMP/kbui-page-check.out.mjs" >/dev/null 2>&1 && pass "页面 JS 解析通过（防语法错整页废）" || fail "页面 JS 解析失败（语法错误）"
if bun "$REPO_ROOT/scripts/probe-kb-ui-render.mjs" "$REPO_ROOT/scripts/ui/index.html" >"$TMP/render.log" 2>&1; then
  grep -q "渲染验收：" "$TMP/render.log" && pass "渲染真执行全过（$(grep -o '渲染验收：[0-9]*/[0-9]*' "$TMP/render.log")）" || fail "渲染脚本输出异常"
else
  fail "渲染真执行不过：$(grep -E '✗' "$TMP/render.log" | head -2 | tr '\n' ' ')"
fi

echo "[1] UI 默认关：升级零变化"
HOME="$H" bash "$INSTALLER" --api "http://127.0.0.1:$STUB_PORT/api/v1" --repo acme/kb \
     --admin-token-file "$TMP/good.token" --self-signed auto --port "$PORT" --no-start >"$TMP/install.log" 2>&1 \
  && pass "安装成功（UI 默认 off）" || fail "安装失败：$(tail -3 "$TMP/install.log" | tr '\n' ' ')"
grep -q "^OMO_KB_UI=off" "$H/.omo-kb/config.env" && pass "config.env 含 OMO_KB_UI=off" || fail "缺 OMO_KB_UI=off"
HOME="$H" "$H/.local/bin/omo-kb" start >>"$TMP/start.log" 2>&1 || true
curl -sk --max-time 3 "https://127.0.0.1:$PORT/healthz" | grep -q '"ok":true' && pass "服务健康" || fail "服务未起"
[ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 "https://127.0.0.1:$PORT/ui")" = "404" ] && pass "UI off ⇒ /ui 404" || fail "/ui 未按默认关闭"
[ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 "https://127.0.0.1:$PORT/ui/api/state")" = "404" ] && pass "UI off ⇒ /ui/api 404" || fail "/ui/api 未关闭"

echo "[2] 开启 UI：身份头门禁"
sed -i 's/^OMO_KB_UI=off/OMO_KB_UI=on/' "$H/.omo-kb/config.env"
HOME="$H" "$H/.local/bin/omo-kb" restart >>"$TMP/start.log" 2>&1
for _ in $(seq 1 20); do curl -sk --max-time 2 "https://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q '"ok":true' && break; sleep 0.5; done
C0="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 "https://127.0.0.1:$PORT/ui")"
C1="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 "https://127.0.0.1:$PORT/ui/api/state")"
[ "$C0" = "401" ] && [ "$C1" = "401" ] && pass "无身份头 ⇒ 401（页面与 API）" || fail "无身份头应 401（/ui=$C0 /api=$C1）"
C301="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 "https://127.0.0.1:$PORT/ui" -H "$HDR")"
[ "$C301" = "301" ] && pass "带头 ⇒ /ui 301 → /ui/" || fail "/ui 应 301（$C301）"
curl -sk --max-time 3 "https://127.0.0.1:$PORT/ui/" -H "$HDR" | grep -q "omo-kb 管理后台" && pass "带头 ⇒ 页面 200（中文后台）" || fail "带头访问页面失败"
curl -skI --max-time 3 "https://127.0.0.1:$PORT/ui/" -H "$HDR" | grep -qi "cache-control:.*no-store" && pass "页面响应 no-store（防升级后旧页缓存）" || fail "页面缺 no-store"
PAGE="$(curl -sk --max-time 3 "https://127.0.0.1:$PORT/ui/" -H "$HDR")"
echo "$PAGE" | grep -q 'location.pathname.endsWith("/")' && pass "页面含前缀挂载 BASE 归一化（网关 /omo-kb 无斜杠场景安全）" || fail "页面缺 BASE 归一化"
echo "$PAGE" | grep -qE "fetch\(BASE \+ url" && pass "API 调用统一走 BASE 前缀" || fail "API 调用未走 BASE"
HOME="$H" "$H/.local/bin/omo-kb" logs 2>/dev/null | grep -q "auth=identity-header" && pass "LISTEN 行标注 auth=identity-header" || fail "LISTEN 行缺 auth 标注"

echo "[3] state 脱敏（秘密不回显）"
STATE="$(curl -sk --max-time 3 "https://127.0.0.1:$PORT/ui/api/state" -H "$HDR")"
echo "$STATE" | grep -q "good-token" && fail "state 泄漏令牌值" || pass "state 不含令牌值"
echo "$STATE" | grep -q '"pid"' && pass "state 含健康信息（pid/repo）" || fail "state 缺健康信息"
echo "$STATE" | grep -q '"actor":"tester"' && pass "actor=身份头值" || fail "actor 缺失"

echo "[4] 页面签码 → 真实兑换闭环"
CODE_RES="$(curl -sk --max-time 3 "https://127.0.0.1:$PORT/ui/api/code" -H "$HDR" -H 'Content-Type: application/json' -d '{"device":"probe-node","ttlMin":5}')"
CODE="$(printf '%s' "$CODE_RES" | grep -o '"code":"[A-Za-z0-9_-]\{32\}"' 2>/dev/null | cut -d'"' -f4 || true)"
[ -n "$CODE" ] && pass "签码成功（32 位，一次性返回）" || fail "签码失败：$(printf '%s' "$CODE_RES" | head -c 160)"
grep -q '"probe-node"' "$H/.omo-kb/registry.json" && pass "登记表落码记录" || fail "registry 无码记录"
grep -q '"event":"ui.code.issued"' "$H/.omo-kb/audit.jsonl" && pass "审计 ui.code.issued" || fail "审计缺签码事件"
ENROLL="$(curl -sk --max-time 8 "https://127.0.0.1:$PORT/enroll" -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\",\"device\":\"probe-node\"}")"
echo "$ENROLL" | grep -q '"ok":true' && pass "UI 签的码真实兑换成功（/enroll 闭环）" || fail "兑换失败：$(printf '%s' "$ENROLL" | head -c 160)"

echo "[3b] 登记表不可读必须显式暴露（不静默空表）"
cp "$H/.omo-kb/registry.json" "$TMP/registry.bak"
printf '{ 坏 JSON' > "$H/.omo-kb/registry.json"
STATE_ERR="$(curl -sk --max-time 3 "https://127.0.0.1:$PORT/ui/api/state" -H "$HDR")"
cp "$TMP/registry.bak" "$H/.omo-kb/registry.json"
echo "$STATE_ERR" | grep -q '"error"' && pass "登记表读取失败 ⇒ state 带 error（不静默）" || fail "空表无原因（静默降级）"
echo "$STATE_ERR" | grep -q '"file":"' && pass "state 回传登记表文件路径（可定位）" || fail "缺登记表路径"
curl -sk --max-time 3 "https://127.0.0.1:$PORT/ui/" -H "$HDR" | grep -q "登记表读取失败" && pass "页面展示登记表错误文案" || fail "页面未展示登记表错误"
echo "$STATE_ERR" | grep -q '"entries":\[\]' && pass "失败态回退空表（不崩）" || fail "失败态异常"
STATE_OK="$(curl -sk --max-time 3 "https://127.0.0.1:$PORT/ui/api/state" -H "$HDR")"
echo "$STATE_OK" | grep -q '"probe-node"' && pass "恢复后登记表数据回来（对照）" || fail "恢复后仍空"

echo "[5] 配置校验失败：硬停不写盘"
OLD_PID="$(echo "$STATE" 2>/dev/null | grep -o '"pid":[0-9]*' | cut -d: -f2 || true)"
CFG_BAD="$(curl -sk --max-time 5 "https://127.0.0.1:$PORT/ui/api/config" -H "$HDR" -H 'Content-Type: application/json' -d '{"values":{"OMO_KB_REPO":"bad repo!!"}}')"
echo "$CFG_BAD" | grep -q '"校验失败"' && pass "坏值被 400 拒绝" || fail "坏值未被拒：$(printf '%s' "$CFG_BAD" | head -c 120)"
NEW_PID="$(curl -sk --max-time 3 "https://127.0.0.1:$PORT/ui/api/state" -H "$HDR" 2>/dev/null | grep -o '"pid":[0-9]*' | cut -d: -f2 || true)"
[ "$OLD_PID" = "$NEW_PID" ] && pass "进程未重启（PID $OLD_PID）" || fail "坏值竟触发了重启"
grep -q "^OMO_KB_REPO=acme/kb" "$H/.omo-kb/config.env" && pass "config.env 未被改写" || fail "config.env 被污染"

echo "[6] 非白名单键拒绝"
W8="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://127.0.0.1:$PORT/ui/api/config" -H "$HDR" -H 'Content-Type: application/json' -d '{"values":{"OMO_KB_ADMIN_TOKEN_FILE":"/x"}}')"
[ "$W8" = "400" ] && pass "凭据键混入 ⇒ 400 整单拒绝" || fail "非白名单未拒（$W8）"

echo "[7] 合法改配 → 预检 → 自动重启生效"
RESP7="$(curl -sk --max-time 20 "https://127.0.0.1:$PORT/ui/api/config" -H "$HDR" -H 'Content-Type: application/json' -d '{"values":{"OMO_KB_TEAM":"new-team"}}')"
echo "$RESP7" | grep -q '"restarting":true' && pass "保存通过预检并触发切换" || fail "合法保存未触发重启：$(printf '%s' "$RESP7" | head -c 700)"
sleep 2
for _ in $(seq 1 20); do curl -sk --max-time 2 "https://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q '"ok":true' && break; sleep 0.5; done
STATE2="$(curl -sk --max-time 3 "https://127.0.0.1:$PORT/ui/api/state" -H "$HDR")"
NEW_PID2="$(echo "$STATE2" 2>/dev/null | grep -o '"pid":[0-9]*' | cut -d: -f2 || true)"
[ -n "$NEW_PID2" ] && [ "$NEW_PID2" != "$OLD_PID" ] && pass "服务已切换到新进程（PID $NEW_PID2）" || fail "PID 未变化（$OLD_PID → $NEW_PID2）"
echo "$STATE2" | grep -q '"OMO_KB_TEAM":"new-team"' && pass "新配置值回读生效" || fail "新值未生效"
[ "$(cat "$H/.omo-kb/service.pid")" = "$NEW_PID2" ] && pass "pid 文件指向新进程（stop 不断链）" || fail "pid 文件未更新"

echo "[8] 预检失败：回滚不重启"
curl -sk --max-time 15 "https://127.0.0.1:$PORT/ui/api/config" -H "$HDR" -H 'Content-Type: application/json' -d '{"values":{"OMO_KB_API":"http://127.0.0.1:1/api/v1"}}' >"$TMP/pre.log" 2>&1
grep -q "预检失败" "$TMP/pre.log" && pass "预检失败被拦（HTTP 层报错）" || fail "预检失败未被拦：$(head -c 160 "$TMP/pre.log")"
sleep 1
grep -q "^OMO_KB_API=http://127.0.0.1:$STUB_PORT/api/v1" "$H/.omo-kb/config.env" && pass "config.env 已回滚到改前内容" || fail "回滚失败"
curl -sk --max-time 3 "https://127.0.0.1:$PORT/healthz" | grep -q '"ok":true' && pass "服务不受影响" || fail "服务被打挂"
curl -sk --max-time 3 "https://127.0.0.1:$PORT/enroll" -o /dev/null && pass "/enroll 仍在（回归）" || fail "/enroll 丢失"

echo "[9] 发布清单断言（V10）"
grep -q 'ui/index.html' "$REPO_ROOT/.github/workflows/release.yml" && pass "release.yml 服务包含 ui/index.html 断言" || fail "发布清单未接 UI 页面"

echo "结果：$FAILED 项失败"
exit $([ "$FAILED" -eq 0 ] && echo 0 || echo 1)
