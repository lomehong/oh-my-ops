#!/usr/bin/env bash
# WEBVERIFY-1 契约探针：ops_web_verify 真浏览器全链（起本地 chrome + CDP + 真实验证）
# 纪律：无浏览器二进制时**显式 SKIP**（打印原因、退出 0），绝不静默"通过"。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
CHROME_PID=""; SRV_PID=""
cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  sleep 0.3                    # 等 chrome 落盘 profile 后再删（否则 rm 报 Directory not empty）
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT
FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=$((FAILED + 1)); }
skip() { echo "  ⏭ SKIP：$1"; exit 0; }

# ── 找浏览器二进制 ──
CHROME=""
for c in "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome; do
  [ -x "$c" ] && { CHROME="$c"; break; }
done
[ -n "$CHROME" ] || skip "本机无 Chrome/Chromium 二进制（安装方式见 CDP 指引：bunx playwright install chromium 或系统包管理器）"
echo "  浏览器：$CHROME"

PORT=$(( (RANDOM % 1000) + 18500 ))
CDP_PORT=$(( PORT + 1 ))

# ── 靶页（登录按钮 + SPA 异步渲染 + 故意注入错误与 404）──
cat > "$TMP/page.mjs" <<'EOF'
const page = (t, b, s = "") => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${t}</title></head><body>${b}<script>${s}</script></body></html>`;
Bun.serve({ port: Number(process.env.PAGE_PORT), hostname: "127.0.0.1", fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/") return new Response(page("验收靶页 · 首屏", `<h1 id="title">验收靶页 · 首屏</h1><div id="panel">加载中…</div>`,
    `console.error("探针：故意注入的业务错误");fetch("/api/missing").catch(()=>{});setTimeout(()=>{document.getElementById("panel").innerHTML='<table id="rows"><tr><td>ok</td></tr></table>';},300);`), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (u.pathname === "/api/missing") return new Response("nope", { status: 404 });
  return new Response("404", { status: 404 });
} });
console.log("PAGE_READY");
EOF
PAGE_PORT=$PORT bun "$TMP/page.mjs" >"$TMP/page.log" 2>&1 & SRV_PID=$!
for _ in $(seq 1 20); do grep -q PAGE_READY "$TMP/page.log" 2>/dev/null && break; sleep 0.2; done

# ── 起无头 chrome + CDP ──
"$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --remote-debugging-port="$CDP_PORT" --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$TMP/profile" about:blank >"$TMP/chrome.log" 2>&1 & CHROME_PID=$!
ready=false
for _ in $(seq 1 40); do
  if curl -sS --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" 2>/dev/null | grep -q webSocketDebuggerUrl; then ready=true; break; fi
  sleep 0.3
done
[ "$ready" = true ] && pass "CDP 端点就绪（127.0.0.1:$CDP_PORT）" || skip "CDP 未就绪（浏览器无法在本环境启动）：$(tail -2 "$TMP/chrome.log" | tr '\n' ' ')"

# ── 跑真实验证 ──
cat > "$TMP/run.mts" <<EOF
import { verifyPage } from "$REPO_ROOT/packages/ops-extension/src/web/verify.ts";
const url = "http://127.0.0.1:$PORT/";
const v = await verifyPage(
  { url, waitFor: "#rows", expectTitle: "验收靶页", expectText: "ok", expectSelector: "#rows", screenshotPath: "$TMP/shot.png", timeoutMs: 15000 },
  { endpoint: "http://127.0.0.1:$CDP_PORT" },
);
console.log(JSON.stringify({ ok: v.ok, url: v.url, assertions: v.assertions.map(a => a.kind + ":" + a.pass), console: v.consoleErrors.map(c => c.text), failed: v.failedRequests.map(f => f.url + "@" + f.status), shot: v.screenshot, notes: v.notes }, null, 1));
if (!v.ok) process.exit(3);
const has404 = v.failedRequests.some(f => f.url.includes("/api/missing") && f.status === 404);
const hasErr = v.consoleErrors.some(c => c.text.includes("故意注入"));
if (!has404 || !hasErr) { console.error("证据缺失：404=" + has404 + " console=" + hasErr); process.exit(4); }
const fs = await import("node:fs");
if (!fs.existsSync("$TMP/shot.png") || fs.statSync("$TMP/shot.png").size < 100) { console.error("截图缺失/过小"); process.exit(5); }
console.log("REAL_VERIFY_OK");
EOF
if (cd "$TMP" && timeout 120 bun "$TMP/run.mts" >"$TMP/out.log" 2>&1); then
  pass "真浏览器全链：断言全过 + 截图落盘 + 证据齐（$(grep -c REAL_VERIFY_OK "$TMP/out.log") 次标记）"
  grep -E '"(ok|console|failed)"' "$TMP/out.log" | head -6 | sed 's/^/    /'
else
  fail "真浏览器验证失败：$(tail -4 "$TMP/out.log" | tr '\n' ' ')"
fi

# ── 端点不可达必须给可执行指引（而非崩溃）──
cat > "$TMP/unreach.mts" <<EOF
import { verifyPage } from "$REPO_ROOT/packages/ops-extension/src/web/verify.ts";
const v = await verifyPage({ url: "http://127.0.0.1:$PORT/" }, { endpoint: "http://127.0.0.1:1" });
console.log(v.ok, /\bdocker run\b/.test(v.notes.join("\n")), v.assertions.some(a => a.kind === "endpoint" && !a.pass));
EOF
OUT="$(cd "$TMP" && timeout 60 bun "$TMP/unreach.mts" 2>&1 || true)"
[ "$OUT" = "false true true" ] && pass "端点不可达：ok=false + docker 指引 + endpoint 断言置败" || fail "不可达路径异常：$OUT"

echo "结果：$FAILED 项失败"
exit $([ "$FAILED" -eq 0 ] && echo 0 || echo 1)
