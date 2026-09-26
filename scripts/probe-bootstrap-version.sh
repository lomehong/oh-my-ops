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
command -v bun >/dev/null 2>&1 || { echo "✗ 需要 bun 起假代理（测试链统一依赖 bun；不依赖 python3 —— Windows 上 python3 常是 Microsoft Store 别名桩：存在但不可用）"; exit 1; }

. "$REPO_ROOT/scripts/lib/proc.sh"
TMP="$(mktemp -d)"
# 收尾：杀假代理（pkill 在 Windows Git Bash 不存在 ⇒ pid 文件 + 双命名空间 kill，见 lib/proc.sh）。
# set +e 是硬要求：EXIT trap 里任何失败命令会点着 set -e，把「全绿」翻成 exit 1（真机踩到）。
cleanup() {
  set +e
  for f in "$TMP"/pid-*; do
    [ -f "$f" ] && proc_kill "$(cat "$f" 2>/dev/null)"
  done
  rm -rf "$TMP" 2>/dev/null || true
  return 0
}
trap cleanup EXIT
FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=$((FAILED + 1)); }

# ── 假代理：模拟「200 直返、无重定向」的镜像，以及「302 资产重定向」两种形态（bun 桩，与 probe-kb-* 同款）
cat > "$TMP/proxy.mjs" <<'JS'
const mode = process.argv[2];              // page | redirect
const port = Number(process.argv[3]);
const tag = process.argv[4];               // 例 v0.9.1
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p.endsWith("/releases/latest/download/install.sh")) {
      // 策略① 判据：302 的 Location 带 /download/<tag>/；page 模式则 200 无 Location
      if (mode === "redirect") return new Response(null, { status: 302, headers: { Location: `https://github.com/x/y/releases/download/${tag}/install.sh` } });
      return new Response(null, { status: 200 });
    }
    if (p.endsWith("/releases/latest")) {
      // 策略② 判据：200 页面内含 /releases/tag/<tag>
      const body = `<html><a href="/lomehong/oh-my-ops/releases/tag/${tag}">Latest</a></html>`;
      return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    return new Response(null, { status: 404 });
  },
});
console.log("PROXY_READY");
JS

start_proxy() { # $1=mode $2=tag → 打印端口（pid 落盘，供 trap/stop 终止；不用 pkill —— Windows Git Bash 无此命令）
  local mode="$1" tag="$2" port=$(( 20000 + RANDOM % 20000 ))
  bun "$TMP/proxy.mjs" "$mode" "$port" "$tag" >"$TMP/proxy-$mode.log" 2>&1 &
  echo $! > "$TMP/pid-$mode"
  for _ in $(seq 1 40); do
    grep -q PROXY_READY "$TMP/proxy-$mode.log" 2>/dev/null && { echo "$port"; return 0; }
    sleep 0.1
  done
  echo ""; return 1
}
stop_proxy() { # $1=mode
  if [ -f "$TMP/pid-$1" ]; then proc_kill "$(cat "$TMP/pid-$1" 2>/dev/null)"; rm -f "$TMP/pid-$1"; fi
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
	stop_proxy redirect
fi

echo "[3] OMO_VERSION 指定版本时不做解析（绕行路径仍可用）"
OUT3="$(run_resolve OMO_VERSION=v9.9.9)"
[ "$OUT3" = "v9.9.9" ] && pass "--resolve-only 与 OMO_VERSION 协同正常" || fail "解析异常：$OUT3"

echo
if [ "$FAILED" -eq 0 ]; then echo "结果：全绿"; exit 0; fi
echo "结果：$FAILED 项失败"; exit 1
