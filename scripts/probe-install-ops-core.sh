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
# 共用自举库随包（install.sh 会 source scripts/lib/bun.sh；CI 打包 `cp -r scripts` 已覆盖）
mkdir -p "$PKG/scripts/lib"; cp "$REPO_ROOT/scripts/lib/"*.sh "$PKG/scripts/lib/"
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

echo "[4] yuyi 配套 skills 部署（vendor/yuyi-skills → \$HOME/.omp/agent/skills）"
SK1="$H1/.omo/home/.omp/agent/skills"
count_dirs() { local n=0 d; for d in "$1"/*/; do [ -d "$d" ] && n=$((n + 1)); done; echo "$n"; }
NS="$(count_dirs "$REPO_ROOT/vendor/yuyi-skills")"
N1="$(count_dirs "$SK1")"
[ "$NS" -gt 0 ] && [ "$N1" -eq "$NS" ] && pass "skills 落点数量与 vendor 一致（$N1）" || fail "skills 落点数异常：$N1（vendor 为 $NS）"
[ -f "$SK1/yuyi-org-architect/references/contracts.md" ] && pass "技能内子目录随技能整棵落位" || fail "技能内子目录未落位（references/ 缺失）"
install_into "$H1" reinstall || fail "重装失败（见 $TMP/install-reinstall.log）"
[ ! -d "$SK1/yuyi-core/yuyi-core" ] && pass "重装未产生嵌套目录（整目录替换）" || fail "重装产生嵌套目录（cp -r 语义不对称回归）"
[ "$(count_dirs "$SK1")" -eq "$NS" ] && pass "重装后落点数不变（$NS）" || fail "重装后落点数异常"
H4="$TMP/h4"; mkdir -p "$H4"
HOME="$H4" bash "$PKG/scripts/install.sh" --name no-token >"$TMP/install-notoken.log" 2>&1 || fail "无 token 安装失败（见 $TMP/install-notoken.log）"
[ -d "$H4/.omo/home/.omp/agent/skills" ] && fail "无 token 仍部署 skills（门控失效）" || pass "无 token 不部署 skills（门控生效）"

echo "[5] KB 同步（OMO-KB-SYNC P1）：模块部署 + 启动器子命令"
EXT2="$H2/.omo/extensions/ops-pi"
for f in kb-cli.ts kb-sync.ts kb-credential.ts kb-enroll.ts; do
	[ -f "$EXT2/$f" ] && pass "扩展模块已部署：$f" || fail "缺少扩展模块：$f"
done
grep -q '^export OMO_DIR=' "$L" && pass "启动器导出 OMO_DIR" || fail "启动器未导出 OMO_DIR"
grep -q '^  kb)' "$L" && pass "启动器含 kb 子命令分支" || fail "启动器缺 kb 子命令分支"
grep -q 'kb sync --quiet' "$L" && pass "serve 带上 KB 定时同步循环" || fail "serve 未带 KB 定时同步"
grep -q 'kb/credential.json' "$L" && pass "omo status 展示 KB 同步状态" || fail "omo status 未展示 KB 状态"

echo
echo "[6] 安装器：Yuyi 凭据传递（--token-file 0600 强制；--token 告警）"
TF="$TMP/token-600"; printf 'probe-token-from-file\n' > "$TF"; chmod 600 "$TF"
TFW="$TMP/token-644"; printf 'x\n' > "$TFW"; chmod 644 "$TFW"
H6="$TMP/h6"; mkdir -p "$H6"
if HOME="$H6" bash "$PKG/scripts/install.sh" --token-file "$TFW" >"$TMP/tf-wide.log" 2>&1; then
  fail "--token-file 权限过宽（644）竟被接受"
else
  grep -q "权限过宽" "$TMP/tf-wide.log" && pass "--token-file 权限过宽即拒" || fail "拒绝原因不明确：$(head -2 "$TMP/tf-wide.log" | tr '\n' ' ')"
fi
if HOME="$H6" bash "$PKG/scripts/install.sh" --token-file "$TF" --name probe-tf >"$TMP/tf-ok.log" 2>&1; then
  if grep -q '"token": "probe-token-from-file"' "$H6/.yuyi/agent.json"; then pass "0600 令牌文件生效（写入 agent.json）"; else fail "令牌未落盘：$(cat "$H6/.yuyi/agent.json" 2>/dev/null | head -c 120)"; fi
else
  fail "0600 令牌文件安装失败：$(tail -3 "$TMP/tf-ok.log" | tr '\n' ' ')"
fi
HOME="$H6" bash "$PKG/scripts/install.sh" --token plain-inline-token --name probe-tf2 >"$TMP/tf-warn.log" 2>&1 || true
grep -q "shell history" "$TMP/tf-warn.log" && pass "--token 用法有泄密告警" || fail "--token 未告警（history/ps 泄密风险）"

echo "[7] 安装器守卫：HOME 被启动器重定向时必须快速失败"
TMPL="$(mktemp -d)"; mkdir -p "$TMPL/.omo/home"
if HOME="$TMPL/.omo/home" bash "$PKG/scripts/install.sh" >"$TMP/judge-home.log" 2>&1; then
  fail "HOME 重定向时安装器竟未拒绝（会把一切装进 <私有home>/.omo）"
else
  if grep -q "HOME 已被启动器重定向" "$TMP/judge-home.log"; then pass "HOME 重定向时快速失败并给出指引"; else fail "拒绝原因不明确：$(head -2 "$TMP/judge-home.log" | tr '\n' ' ')"; fi
fi
rm -rf "$TMPL"

if [ "$FAILED" -eq 0 ]; then echo "结果：全绿"; exit 0; fi
echo "结果：$FAILED 项失败"; exit 1
