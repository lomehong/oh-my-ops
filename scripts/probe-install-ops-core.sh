#!/usr/bin/env bash
# probe-install-ops-core.sh —— 安装器回归守卫（对应 2026-09-16 生产回归）
#
# 覆盖两处真实缺陷：
#   ① ops-core 安装：`cp -r <src> <dest>` 在 dest 已存在时生成 dest/src 并保留旧平铺文件 →
#      裸 import "@ops-pi/core" 命中旧 index.ts（缺 AuditLog 等新导出）→ 扩展整体加载失败 → ops_* 全灭。
#   ② 启动器 serve 后台分支：未加引号 heredoc 里 `$0`/`$@` 被生成期展开 → 写死安装器临时路径。
#
# 用法：bash scripts/probe-install-ops-core.sh [--installer <install.sh 路径>]
#   --installer 用于对旧版安装器跑红（例：--installer <(git show HEAD:scripts/install.sh) 的落盘副本）
# 全沙箱：临时「发布布局」+ 临时 HOME，不触碰真实 ~/.omo、~/.local/bin、~/.yuyi。退出码 0=全绿。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$REPO_ROOT/scripts/install.sh"
if [ "${1:-}" = "--installer" ] && [ -n "${2:-}" ]; then INSTALLER="$2"; fi

command -v bun >/dev/null 2>&1 || { echo "✗ 需要 bun 做模块解析断言"; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=$((FAILED + 1)); }

# ── 组装发布布局（含 stub 运行时，满足 install.sh 的版本断言）
PKG="$TMP/pkg"; mkdir -p "$PKG"
cp -r "$REPO_ROOT/packages" "$REPO_ROOT/vendor" "$PKG/"
mkdir -p "$PKG/scripts"; cp "$INSTALLER" "$PKG/scripts/install.sh"
printf '#!/usr/bin/env bash\necho "omp/18.1.18 (probe-stub)"\n' > "$PKG/omp-single"; chmod +x "$PKG/omp-single"

install_into() { HOME="$1" bash "$PKG/scripts/install.sh" --token probe-token --name probe-dev >"$TMP/install-$2.log" 2>&1; }
exports_of() { (cd "$1/.omo/extensions/ops-pi" && bun -e 'import("@ops-pi/core").then(m=>console.log(Object.keys(m).sort().join(","))).catch(e=>console.log("RESOLVE_FAIL: "+e.message))'); }

echo "installer: $INSTALLER"

echo "[1] 干净机安装"
H1="$TMP/h1"; mkdir -p "$H1"
install_into "$H1" clean || fail "安装器执行失败（见 $TMP/install-clean.log）"
CORE1="$H1/.omo/extensions/ops-pi/node_modules/@ops-pi/core"
[ -f "$CORE1/package.json" ] && pass "core/package.json 随包安装" || fail "core/package.json 缺失"
[ -d "$CORE1/src" ] && pass "core/src 就位" || fail "core/src 缺失"
EX1="$(exports_of "$H1")"
case "$EX1" in *AuditLog*) pass "干净机解析含新导出 AuditLog";; *) fail "干净机解析异常：$EX1";; esac

echo "[2] 升级路径（core 目录已存在旧平铺文件）"
H2="$TMP/h2"; CORE2="$H2/.omo/extensions/ops-pi/node_modules/@ops-pi/core"; mkdir -p "$CORE2"
printf 'export const CredentialVault = {};\n' > "$CORE2/index.ts"   # 旧版布局残留
printf 'export const exec = {};\n' > "$CORE2/exec.ts"
install_into "$H2" upgrade || fail "安装器执行失败（见 $TMP/install-upgrade.log）"
EX2="$(exports_of "$H2")"
case "$EX2" in *AuditLog*) pass "升级后解析含新导出 AuditLog（旧文件已被清理）";; *) fail "升级后解析异常（回归复现）：$EX2";; esac
[ -e "$CORE2/index.ts" ] && fail "旧平铺 core/index.ts 仍残留" || pass "旧平铺文件已清理"
[ -e "$CORE2/exec.ts" ] && fail "旧平铺 core/exec.ts 仍残留" || pass "旧平铺 exec.ts 已清理"

echo "[3] 启动器 serve 后台分支（\$0/\$@ 转义）"
L="$H2/.local/bin/omo"
if [ -f "$L" ]; then
	pass "启动器已生成"
	bash -n "$L" 2>/dev/null && pass "启动器语法通过 bash -n" || fail "启动器语法错误"
	grep -qF 'exec "$0" --profile ops "$@"' "$L" && pass "serve 分支保留字面量 \$0/\$@" || fail "serve 分支 \$0/\$@ 被生成期展开"
	if grep -qF 'scripts/install.sh" --profile ops' "$L"; then fail "启动器写死了安装器路径（生成期展开 bug）"; else pass "启动器未写死安装器路径"; fi
else
	fail "启动器缺失"
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "结果：全绿"; exit 0; fi
echo "结果：$FAILED 项失败"; exit 1
