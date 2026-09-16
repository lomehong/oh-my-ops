#!/usr/bin/env bash
# probe-bootstrap-version.sh —— bootstrap.sh 版本解析回归守卫（对端 2026-09-16 实测故障）
#
# 故障：解析只认 `releases/latest` 的 302 重定向（取 url_effective basename）。当直连被代理或镜像
# 以 **200 直返页面（无重定向）** 应答时，basename 恒为 "latest" → 三源全落 latest → 安装被拒。
#
# 本守卫用本地「假代理」确定性复现该形态（不起网络依赖）：
#   场景 1（策略② 页面解析）：资产 URL 200 无 Location；`releases/latest` 200 HTML 内含 tag 链接 → 应解析出 v0.9.1
#   场景 2（策略① 资产重定向）：资产 URL 302 → Location 含 /download/v0.9.2 → 应解析出 v0.9.2
#   场景 3（--resolve-only 透传）：带 --resolve-only 时仅打印版本、不下载
# 用法：bash scripts/probe-bootstrap-version.sh [--bootstrap <bootstrap.sh 路径>]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOOT="$REPO_ROOT/scripts/bootstrap.sh"
if [ "${1:-}" = "--bootstrap" ] && [ -n "${2:-}" ]; then BOOT="$2"; fi
command -v python3 >/dev/null 2>&1 || { echo "✗ 需要 python3 起假代理"; exit 1; }

TMP="$(mktemp -d)"; trap 'for f in "$TMP"/pid-*; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done; rm -rf "$TMP"' EXIT
FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=$((FAILED + 1)); }

# ── 假代理：模拟「200 直返、无重定向」的镜像，以及「302 资产重定向」两种形态
cat > "$TMP/proxy.py" <<'PY'
import http.server, socketserver, sys, json
MODE = sys.argv[1]          # page | redirect
PORT = int(sys.argv[2])
TAG = sys.argv[3]           # 例 v0.9.1
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"      # 关闭 keep-alive：单请求即关，避免阻塞后续断言
    def log_message(self, *a): pass
    def _p(self): return self.path
    def do_HEAD(self): self._send(head=True)
    def do_GET(self): self._send(head=False)
    def _send(self, head):
        p = self._p()
        if p.endswith("/releases/latest/download/install.sh"):
            if MODE == "redirect":
                self.send_response(302); self.send_header("Location", f"https://github.com/x/y/releases/download/{TAG}/install.sh")
            else:
                self.send_response(200)
            self.send_header("Content-Length", "0"); self.end_headers(); return
        if p.endswith("/releases/latest"):
            body = (f'<html><a href="/lomehong/oh-my-ops/releases/tag/{TAG}">Latest</a></html>').encode()
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head: self.wfile.write(body)
            return
        self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()
class S(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
with S(("127.0.0.1", PORT), H) as s:
    s.serve_forever()
PY

start_proxy() { # $1=mode $2=tag → 打印端口（pid 落盘，供父 shell 终止）
  local mode="$1" tag="$2" port=$(( 20000 + RANDOM % 20000 ))
  python3 "$TMP/proxy.py" "$mode" "$port" "$tag" >"$TMP/proxy-$mode.log" 2>&1 &
  echo $! > "$TMP/pid-$mode"
  for _ in $(seq 1 40); do
    (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null && { exec 3<&- 3>&-; echo "$port"; return 0; }
    sleep 0.1
  done
  echo ""; return 1
}
stop_proxy() { # $1=mode
  [ -f "$TMP/pid-$1" ] && kill "$(cat "$TMP/pid-$1")" 2>/dev/null || true
  rm -f "$TMP/pid-$1"
}
run_resolve() { # $1=env 前缀参数…；输出最后一行
  local out
  out="$(env "$@" timeout 30 bash "$BOOT" --resolve-only 2>&1 | tail -1 || true)"
  printf '%s' "$out"
}

echo "bootstrap: $BOOT"

echo "[1] 假代理「200 直返页面、无重定向」→ 策略② 页面解析"
P1="$(start_proxy page v0.9.1)" || fail "假代理未起来"
if [ -n "$P1" ]; then
	OUT1="$(run_resolve OMO_MIRROR="http://127.0.0.1:$P1")"
	[ "$OUT1" = "v0.9.1" ] && pass "解析出 v0.9.1（无重定向也能解析）" || fail "解析异常：$OUT1"
	stop_proxy page
fi

echo "[2] 假代理「资产 302 重定向」→ 策略① Location 解析"
P2="$(start_proxy redirect v0.9.2)" || fail "假代理未起来"
if [ -n "$P2" ]; then
	OUT2="$(run_resolve OMO_MIRROR="http://127.0.0.1:$P2")"
	[ "$OUT2" = "v0.9.2" ] && pass "解析出 v0.9.2（资产 Location 命中）" || fail "解析异常：$OUT2"
	stop_proxy page
fi

echo "[3] OMO_VERSION 指定版本时不做解析（绕行路径仍可用）"
OUT3="$(run_resolve OMO_VERSION=v9.9.9)"
[ "$OUT3" = "v9.9.9" ] && pass "--resolve-only 与 OMO_VERSION 协同正常" || fail "解析异常：$OUT3"

echo
if [ "$FAILED" -eq 0 ]; then echo "结果：全绿"; exit 0; fi
echo "结果：$FAILED 项失败"; exit 1
