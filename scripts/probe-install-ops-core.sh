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

# 判活：僵尸进程在 /proc 里仍有目录但 cmdline 为空 ⇒ 以「cmdline 非空」为准
alive() { [ -s "/proc/$1/cmdline" ]; }

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
grep -q 'kb/credential.json' "$L" && pass "omo status 展示 KB 同步状态" || fail "omo status 未展示 KB 状态"

echo
echo "[5b] 启动器 KB 循环：命令能真跑通（曾误传 bun 路径 ⇒ Script not found）"
HB="$TMP/hb"; mkdir -p "$HB"
install_into "$HB" b >/dev/null 2>&1 || true
if HOME="$HB" "$HB/.local/bin/omo" kb sync --quiet >"$TMP/kb-loop-cmd.log" 2>&1; then pass "启动器 kb sync 可执行（本地模式）"; else fail "启动器 kb sync 失败：$(tail -2 "$TMP/kb-loop-cmd.log" | tr '\n' ' ')"; fi
grep -q "Script not found" "$TMP/kb-loop-cmd.log" && fail "出现 bun 误调用（Script not found）" || pass "无 bun 误调用"
if grep -q 'sync --quiet' "$PKG/scripts/install.sh" && grep -q 'kb-cli.ts' "$PKG/scripts/install.sh"; then pass "循环调用形态正确（bun + kb-cli.ts）"; else fail "循环调用形态异常"; fi

echo "[5c] 服务模式 KB 循环：实跑生成的循环并断言无错"
HC="$TMP/hc"; mkdir -p "$HC"
install_into "$HC" c >/dev/null 2>&1 || true
rm -f /tmp/omo-kb-sync.pid; : > /tmp/omo-kb-sync.log
HOME="$HC" OMO_KB_INTERVAL=2 "$HC/.local/bin/omo" serve >/dev/null 2>&1 || true
sleep 4
if [ -f /tmp/omo-kb-sync.log ]; then
  if grep -qE "Script not found|command not found|exit=127" /tmp/omo-kb-sync.log; then fail "循环日志出现调用错误：$(grep -m1 -E 'Script not found|command not found' /tmp/omo-kb-sync.log)"; else pass "循环日志无调用错误（$(grep -c 'exit=' /tmp/omo-kb-sync.log) 轮已执行）"; fi
else fail "循环未产出日志"; fi
KBPID="$(cat /tmp/omo-kb-sync.pid 2>/dev/null || true)"; [ -n "$KBPID" ] && kill "$KBPID" 2>/dev/null || true
# 清理本探针起的循环（不依赖 procps：纯 /proc 扫描）；否则它们会持续往共享日志写 Module not found（沙箱目录已删）
for f in /proc/[0-9]*/cmdline; do
  [ -r "$f" ] || continue
  p="\${f#/proc/}"; p="\${p%/cmdline}"
  c="$(tr '\0' ' ' < "$f" 2>/dev/null || true)"
  case "$c" in *kb-cli.ts*"*"*sync*|*"bun kb sync"*) kill "$p" 2>/dev/null || true ;; esac
done
sleep 0.5
LEFT=0; for f in /proc/[0-9]*/cmdline; do c="$(tr '\0' ' ' < "$f" 2>/dev/null || true)"; case "$c" in *kb-cli.ts*"*"*sync*|*"bun kb sync"*) LEFT=$((LEFT+1)) ;; esac; done
[ "$LEFT" -eq 0 ] && pass "探针收尾：无遗留 KB 循环" || fail "探针遗留 KB 循环 $LEFT 个"

echo "[5d] 旧服务识别：启动器变更后 status 必须提示重启（真机踩到：升级后旧循环仍跑旧代码）"
HD="$TMP/hd"; mkdir -p "$HD"
install_into "$HD" d >/dev/null 2>&1 || true
sleep 60 & FAKE_PID=$!
echo "$FAKE_PID" > /tmp/omo-serve.pid                 # 一个**真实存活**的 PID（模拟在跑的旧服务）
printf '%s' "deadbeef-stale" > /tmp/omo-serve.stamp  # 与当前启动器指纹必然不同 ⇒ 应判定为「升级前」
out="$(HOME="$HD" "$HD/.local/bin/omo" status 2>&1 || true)"
if echo "$out" | grep -q "升级前"; then pass "status 识别旧服务并提示重启"; else fail "status 未提示旧服务：$(echo "$out" | grep -E '服务|知识库' | head -2 | tr '\n' ' ')"; fi
rm -f /tmp/omo-serve.stamp /tmp/omo-serve.pid; kill "$FAKE_PID" 2>/dev/null || true

echo "[5e] 安装/重启清理遗留 KB 循环（旧版孤儿会一直按旧代码写日志）"
HE="$TMP/he"; mkdir -p "$HE"
sleep 60 & STALE_KB=$!
echo "$STALE_KB" > /tmp/omo-kb-sync.pid
printf 'stale' > /tmp/omo-serve.stamp
install_into "$HE" e >/dev/null 2>&1 || true
sleep 1
if alive "$STALE_KB"; then fail "安装后遗留 KB 循环仍在（PID $STALE_KB）"; else pass "安装时已清理遗留 KB 循环"; fi
[ -e /tmp/omo-kb-sync.pid ] && fail "遗留 pid 文件未清理" || pass "遗留 pid 文件已清理"
[ -e /tmp/omo-serve.stamp ] && fail "遗留 serve 指纹未清理（旧服务会误判）" || pass "遗留 serve 指纹已清理"
kill "$STALE_KB" 2>/dev/null || true
# 兜底分支：孤儿已覆盖 pid 文件（不可达）⇒ 只能按命令行特征清（两种形态各验一次）
bash -c 'exec -a "bun kb sync" tail -f /dev/null /dev/null' >/dev/null 2>&1 &
O1=$!
bash -c 'exec -a "bun /p/kb-cli.ts" tail -f /dev/null /dev/null' >/dev/null 2>&1 &   # kb-cli 在 sync 之前
O2=$!
sleep 0.6
install_into "$HE" e2 >/dev/null 2>&1 || true
sleep 1
if alive "$O1"; then fail "旧形态孤儿（bun kb sync）未被清理"; else pass "旧形态孤儿（bun kb sync）已清理"; fi
if alive "$O2"; then fail "kb-cli 形态孤儿未被清理"; else pass "kb-cli 形态孤儿已清理"; fi
kill "$O1" "$O2" 2>/dev/null || true

echo "[5f] 启动器必须**原子替换**（原地覆写会让正在执行的脚本读到新内容 ⇒ 真机 [3/5] 处 Script not found \"kb\"）"
HF="$TMP/hf"; mkdir -p "$HF"
install_into "$HF" f >/dev/null 2>&1 || true
L="$HF/.local/bin/omo"; [ -x "$L" ] || L="/usr/local/bin/omo"
INO1="$(stat -c %i "$L" 2>/dev/null || echo 0)"
install_into "$HF" f2 >/dev/null 2>&1 || true
INO2="$(stat -c %i "$L" 2>/dev/null || echo 0)"
if [ "$INO1" != "0" ] && [ "$INO1" != "$INO2" ]; then pass "重装后启动器 inode 变化（原子替换，非原地覆写）"; else fail "inode 未变化（$INO1→$INO2）：可能仍是原地覆写"; fi
grep -q 'cat > "$BIN_TMP"' "$PKG/scripts/install.sh" && pass "安装器使用临时文件 + mv" || fail "安装器未见临时文件写法"

echo "[5g] 安装输出必须干净（未加引号 heredoc 内的反引号会被当命令替换执行）"
HG="$TMP/hg"; mkdir -p "$HG"
install_into "$HG" g >/dev/null 2>&1 || true
LOG="$TMP/install-g.log"
if grep -qE "Script not found|command not found" "$LOG" 2>/dev/null; then
  fail "安装输出含杂散命令执行：$(grep -m1 -E 'Script not found|command not found' "$LOG")"
else
  pass "安装输出无杂散命令执行（Script not found / command not found）"
fi

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
