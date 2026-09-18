#!/usr/bin/env bash
# P0 契约验收：kb-enroll **服务安装器**（一键部署形态与 omo 一致 + 起服务自证健康）
# 校验：HOME 重定向守卫 · 私有域布局与权限 · 令牌路径 + 4 项作用域自检（桩 Gitea）· 启动器 · TLS 自签 · /healthz 可服务 · 卸载
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$REPO_ROOT/scripts/install-enroll-service.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"; pkill -f "$TMP/" 2>/dev/null || true' EXIT
FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=$((FAILED + 1)); }

echo "installer: $INSTALLER"
[ -f "$INSTALLER" ] || { echo "✗ 缺安装器"; exit 1; }
[ -f "$REPO_ROOT/scripts/lib/bun.sh" ] || { echo "✗ 缺共用自举库 scripts/lib/bun.sh"; exit 1; }

PORT=$(( (RANDOM % 2000) + 18000 ))
STUB_PORT=$(( PORT + 1 ))
H="$TMP/home"; mkdir -p "$H/.local/bin"

# ── 桩 Gitea：/admin/users 返回 200（供安装器的管理员自证）
cat > "$TMP/stub.mjs" <<EOF
// 桩 Gitea：按真实的"校验失败/缺权"语义应答，供作用域自检判定
Bun.serve({ port: $STUB_PORT, fetch(req) {
  const u = new URL(req.url);
  const auth = req.headers.get("authorization") ?? "";
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  // 缺权令牌（probe 用它验证"必须被拦"）：任何写端点返回 403 + scope 提示
  if (auth.startsWith("token scoped-")) {
    return json({ message: "token does not have at least one of required scope(s), required=[write:admin], token scope=read:repository" }, 403);
  }
  if (u.pathname.endsWith("/admin/users") && req.method === "GET") return json([], 200);
  if (u.pathname.endsWith("/admin/users") && req.method === "POST") return json({ message: "[Username]: Required" }, 422);
  if (u.pathname.includes("/collaborators/")) return json({ message: "user does not exist [name: __omo_scope_probe__]" }, 404);
  if (u.pathname.endsWith("/teams") && req.method === "POST") return json({ message: "[Name]: Required" }, 422);
  return json({}, 200);
} });
console.log("STUB_READY");
EOF
bun "$TMP/stub.mjs" >"$TMP/stub.log" 2>&1 &
STUB_PID=$!
for _ in $(seq 1 20); do grep -q STUB_READY "$TMP/stub.log" 2>/dev/null && break; sleep 0.3; done
kill -0 "$STUB_PID" 2>/dev/null && pass "桩 Gitea 就绪（:$STUB_PORT）" || fail "桩 Gitea 未就绪"

echo "[1] 守卫：HOME 被启动器重定向时必须快速失败"
mkdir -p "$TMP/redirected/.omo/home"
if HOME="$TMP/redirected/.omo/home" bash "$INSTALLER" --api "http://127.0.0.1:$STUB_PORT/api/v1" --repo acme/kb --admin-user root --admin-password-file "$TMP/pw" >"$TMP/guard.log" 2>&1; then
  fail "HOME 重定向时安装器竟未拒绝"
else
  grep -q "HOME 已被启动器重定向" "$TMP/guard.log" && pass "HOME 重定向时快速失败并给出指引" || fail "拒绝原因不明确：$(head -2 "$TMP/guard.log" | tr '\n' ' ')"
fi

echo "[2] 必填校验与凭据权限"
printf 'pw\n' > "$TMP/pw"; chmod 644 "$TMP/pw"
if HOME="$H" bash "$INSTALLER" --api "http://127.0.0.1:$STUB_PORT/api/v1" --repo acme/kb --admin-user root --admin-password-file "$TMP/pw" --self-signed 127.0.0.1 --no-start >"$TMP/wide.log" 2>&1; then
  fail "凭据文件 0644 竟被接受"
else
  grep -q "权限过宽" "$TMP/wide.log" && pass "凭据文件权限过宽即拒" || fail "拒绝原因不明确：$(head -2 "$TMP/wide.log" | tr '\n' ' ')"
fi
chmod 600 "$TMP/pw"
if HOME="$H" bash "$INSTALLER" --api "http://127.0.0.1:$STUB_PORT/api/v1" --repo acme/kb --admin-user root --admin-password-file "$TMP/pw" --no-start >"$TMP/missing.log" 2>&1; then
  fail "缺 TLS 参数竟被接受"
else
  grep -q "缺少 TLS" "$TMP/missing.log" && pass "缺 TLS 时明确拒绝" || fail "拒绝原因不明确：$(head -2 "$TMP/missing.log" | tr '\n' ' ')"
fi

echo "[2b] 缺权令牌必须被拦（403+scope ⇒ 指出缺哪个作用域并给重签命令）"
printf 'scoped-bad\n' > "$TMP/scoped.token"; chmod 600 "$TMP/scoped.token"
if HOME="$H" bash "$INSTALLER" --api "http://127.0.0.1:$STUB_PORT/api/v1" --repo acme/kb \
     --admin-token-file "$TMP/scoped.token" --self-signed 127.0.0.1 --port "$PORT" --no-start >"$TMP/neg.log" 2>&1; then
  fail "缺权令牌竟被接受"
else
  grep -q "作用域不足" "$TMP/neg.log" && pass "缺权令牌被拦并提示作用域" || fail "拦截原因不明确：$(head -3 "$TMP/neg.log" | tr '\n' ' ')"
  grep -q "generate-access-token" "$TMP/neg.log" && pass "给出重签命令（令牌优先）" || fail "未给重签指引"
fi

echo "[2c] 非法 SAN 必须被拦（真机：把模板里的 <本机IP> 原样粘进来 ⇒ openssl 失败而脚本静默退出）"
printf 'token good-token\n' > "$TMP/good.token"; chmod 600 "$TMP/good.token"
if HOME="$H" bash "$INSTALLER" --api "http://127.0.0.1:$STUB_PORT/api/v1" --repo acme/kb \
     --admin-token-file "$TMP/good.token" --self-signed "<本机IP>" --port "$PORT" --no-start >"$TMP/badsan.log" 2>&1; then
  fail "非法 SAN 竟被接受"
else
  grep -q "证书 SAN 非法" "$TMP/badsan.log" && pass "非法 SAN 被拦并给出正确写法" || fail "拦截原因不明确：$(tail -3 "$TMP/badsan.log" | tr '\n' ' ')"
fi

echo "[3] 一键安装（--no-start）：布局/权限/证书/启动器"
printf 'token good-token\n' > "$TMP/good.token"; chmod 600 "$TMP/good.token"
if HOME="$H" bash "$INSTALLER" --api "http://127.0.0.1:$STUB_PORT/api/v1" --repo acme/kb \
     --admin-token-file "$TMP/good.token" --self-signed auto --port "$PORT" --no-start >"$TMP/install.log" 2>&1; then
  pass "安装器执行成功"
else
  fail "安装器执行失败：$(tail -5 "$TMP/install.log" | tr '\n' ' ')"
fi
for f in service/ops-kb-enroll-server.mjs service/ops-kb-provision.mjs service/lib/kb-gitea.mjs service/lib/kb-registry.mjs service/lib/kb-audit.mjs config.env admin.pw tls/cert.pem tls/key.pem; do
  [ -e "$H/.omo-kb/$f" ] && pass "布局：$f" || fail "缺文件：$f"
done
[ "$(stat -c %a "$H/.omo-kb/config.env")" = "600" ] && pass "config.env 0600" || fail "config.env 权限 $(stat -c %a "$H/.omo-kb/config.env" 2>/dev/null)"
[ "$(stat -c %a "$H/.omo-kb/admin.pw")" = "600" ] && pass "admin.pw 0600" || fail "admin.pw 权限异常"
[ "$(stat -c %a "$H/.omo-kb/tls/key.pem")" = "600" ] && pass "TLS 私钥 0600" || fail "TLS 私钥权限异常"
[ -x "$H/.local/bin/omo-kb" ] && pass "启动器可执行：~/.local/bin/omo-kb" || fail "启动器缺失/不可执行"
grep -q '"ok":true' "$TMP/install.log" || grep -q "完成" "$TMP/install.log" && pass "安装输出含完成段" || fail "安装输出异常"
grep -q "凭据与作用域自证：4/4 通过" "$TMP/install.log" && pass "令牌路径 + 4 项作用域自检通过" || fail "作用域自检未通过：$(grep -E '作用域|✗' "$TMP/install.log" | head -3 | tr '\n' ' ')"

echo "[4] 起服务并自证健康（启动器路径）"
HOME="$H" "$H/.local/bin/omo-kb" start >"$TMP/start.log" 2>&1 || true
healthy=false
for _ in $(seq 1 25); do
  if curl -sk --max-time 3 "https://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q '"ok":true'; then healthy=true; break; fi
  sleep 0.6
done
[ "$healthy" = true ] && pass "服务健康自证 ✓ https://127.0.0.1:$PORT/healthz" || fail "服务未起或 healthz 不通：$(tail -3 "$H/.omo-kb/logs/service.log" 2>/dev/null | tr '\n' ' ')"
echo "[5] 启动器子命令"
hout="$(HOME="$H" "$H/.local/bin/omo-kb" health 2>&1 || true)"
echo "$hout" | grep -q '"ok":true' && pass "omo-kb health" || fail "omo-kb health 异常（实际输出：$(echo "$hout" | head -2 | tr '\n' ' ')）"
HOME="$H" "$H/.local/bin/omo-kb" cert 2>/dev/null | grep -qi "SHA256 Fingerprint" && pass "omo-kb cert（指纹可查）" || fail "omo-kb cert 异常"
HOME="$H" "$H/.local/bin/omo-kb" enroll-hint 2>/dev/null | grep -q "omo kb enroll" && pass "omo-kb enroll-hint（实例侧接入命令）" || fail "omo-kb enroll-hint 异常"
out="$(HOME="$H" "$H/.local/bin/omo-kb" code --op enroll --device probe-node --ttl 30 2>&1 || true)"
echo "$out" | grep -q "只显示这一次" && pass "omo-kb code 签码" || fail "omo-kb code 异常：$(echo "$out" | head -2 | tr '\n' ' ')"
echo "$out" | grep -qi "omo-kb code" && pass "签码输出含签发提示" || true

echo "[6] 停止与卸载（--purge）"
HOME="$H" "$H/.local/bin/omo-kb" stop >"$TMP/stop.log" 2>&1 || true
down=false
for _ in $(seq 1 15); do
  curl -sk --max-time 2 "https://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 || { down=true; break; }
  sleep 0.4
done
[ "$down" = true ] && pass "omo-kb stop 生效（端口不再应答）" || fail "stop 后服务仍可访问：$(tail -2 "$TMP/stop.log" | tr '\n' ' ')"
HOME="$H" bash "$INSTALLER" --uninstall --purge >"$TMP/uninstall.log" 2>&1 && pass "卸载执行成功" || fail "卸载失败：$(tail -3 "$TMP/uninstall.log" | tr '\n' ' ')"
[ -e "$H/.omo-kb" ] && fail "卸载后私有域仍在" || pass "私有域已删除（--purge）"
[ -e "$H/.local/bin/omo-kb" ] && fail "卸载后启动器仍在" || pass "启动器已移除"

kill "$STUB_PID" 2>/dev/null || true
if [ "$FAILED" -eq 0 ]; then echo "结果：全绿"; exit 0; fi
echo "结果：$FAILED 项失败"; exit 1
