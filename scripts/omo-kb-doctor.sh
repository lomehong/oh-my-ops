#!/usr/bin/env bash
# omo-kb-doctor.sh —— omo 实例的**只读体检**（知识库同步 + 服务模式相关）
#
# 用途：批量升级前后确认「装对了、跑对了、没留孤儿」。**只读**：不写任何文件、不重启任何服务。
#   bash scripts/omo-kb-doctor.sh [--dir <私有域>]      # 默认 $OMO_DIR 或 $HOME/.omo
#
# 退出码：0 = 全部通过；1 = 存在需要处理的问题（⚠ 不视为失败，✗ 视为失败）。
set -uo pipefail

DIR="${OMO_DIR:-$HOME/.omo}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

FAIL=0
ok()   { echo "  ✓ $1"; }
warn() { echo "  ⚠ $1"; }
bad()  { echo "  ✗ $1"; FAIL=1; }

echo "═══ omo 知识库体检 ═══"
echo "  私有域：$DIR"
echo

# ── 1) 基本布局
[ -x "$DIR/runtime/omp-single" ] && ok "运行时：$("$DIR/runtime/omp-single" --version 2>/dev/null | head -1)" || bad "缺运行时：$DIR/runtime/omp-single"
[ -f "$DIR/extensions/ops-pi/index.ts" ] && ok "扩展目录：$DIR/extensions/ops-pi" || bad "缺扩展：$DIR/extensions/ops-pi/index.ts"
KBCLI="$DIR/extensions/ops-pi/kb-cli.ts"
[ -f "$KBCLI" ] && ok "KB 模块：kb-cli.ts / kb-sync.ts / kb-credential.ts 就位" || bad "缺 KB 模块（kb-cli.ts）——需重跑安装器"
LAUNCHER="$(command -v omo 2>/dev/null || true)"; [ -n "$LAUNCHER" ] && ok "启动器：$LAUNCHER" || warn "omo 不在 PATH（可用绝对路径调用）"

# ── 2) 凭据与同步状态
CRED="$DIR/kb/credential.json"; STATE="$DIR/kb/state.json"
if [ -f "$CRED" ]; then
  PERM="$(stat -c %a "$CRED" 2>/dev/null || echo '?')"
  REPO="$(sed -n 's/.*"repo"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CRED" | head -1)"
  USER_="$(sed -n 's/.*"username"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CRED" | head -1)"
  KIND="$(sed -n 's/.*"kind"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CRED" | head -1)"
  [ "$PERM" = "600" ] && ok "凭据：$USER_（$KIND）@ $REPO  [0600]" || bad "凭据文件权限异常：$PERM（应为 600）"
  [ -f "$DIR/home/.git-credentials" ] && ok "git store 凭据文件存在（0600）" || warn "git store 凭据文件缺失（下次 sync 会自动重建）"
else
  warn "凭据：未配置（本地模式）——启用远端同步需 enroll 或 Owner 发放凭据"
fi
if [ -f "$STATE" ]; then
  LAST="$(sed -n 's/.*"lastSyncAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATE" | head -1)"
  OK_="$(sed -n 's/.*"ok"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "$STATE" | head -1)"
  if [ ! -f "$CRED" ]; then
    ok "最后同步：$LAST ✓（**本地模式**：未配置远端，此记录非远端同步结果）"
  elif [ "$OK_" = "true" ]; then ok "最后同步：$LAST ✓"
  else warn "最后同步：$LAST ✗（看图 kb/state.json 或 omo kb status）"; fi
else
  warn "尚无同步记录（kb/state.json 不存在）"
fi

# ── 3) KB 循环：进程形态与存活（纯 /proc，不依赖 procps）
GOOD_LOOPS=""; BAD_LOOPS=""
for f in /proc/[0-9]*/cmdline; do
  [ -r "$f" ] || continue
  pid="${f#/proc/}"; pid="${pid%/cmdline}"
  cmd="$(tr '\0' ' ' < "$f" 2>/dev/null || true)"
  case "$cmd" in
    *"bun kb sync"*) BAD_LOOPS="$BAD_LOOPS $pid"; continue ;;
  esac
  case "$cmd" in *kb-cli.ts*) case "$cmd" in *sync*) GOOD_LOOPS="$GOOD_LOOPS $pid" ;; esac ;; esac
done
if [ -n "${GOOD_LOOPS// /}" ]; then ok "KB 同步循环：运行中（PID${GOOD_LOOPS}；调用形态正确：bun + kb-cli.ts）"
else
  if [ -f "$CRED" ]; then warn "KB 同步循环未在运行（已配凭据）：omo serve 会拉起；若服务在跑而循环缺位，重跑 omo serve"
  else ok "KB 同步循环未在运行（未配凭据=本地模式；循环由 omo serve 拉起，装好凭据后会真正同步）"; fi
fi
[ -n "${BAD_LOOPS// /}" ] && warn "发现**旧形态** KB 循环（PID${BAD_LOOPS}）：它们会往日志写 Script not found；安装器/omo serve 会自动清理" || true

# ── 4) 服务：存活 + 是否「升级前启动的旧进程」
SERVE_PID="$(cat /tmp/omo-serve.pid 2>/dev/null || true)"
if [ -n "$SERVE_PID" ] && kill -0 "$SERVE_PID" 2>/dev/null; then
  ok "服务：运行中（PID $SERVE_PID）"
  if [ -n "${LAUNCHER:-}" ] && command -v sha256sum >/dev/null 2>&1; then
    CUR="$(sha256sum "$LAUNCHER" | cut -d' ' -f1)"; OLD="$(cat /tmp/omo-serve.stamp 2>/dev/null || true)"
    if [ -n "$OLD" ] && [ "$CUR" != "$OLD" ]; then
      warn "该服务是**升级前**启动的（启动器已变更）：kill $SERVE_PID && omo serve（否则 KB 循环仍走旧代码）"
    else ok "服务与当前启动器一致（非旧进程）"; fi
  fi
else
  warn "服务未运行（omo serve 启动；无服务时 KB 定时同步也不会跑）"
fi

# ── 5) 同步日志：最近一轮是否干净
LOG=/tmp/omo-kb-sync.log
if [ -f "$LOG" ]; then
  BADN="$(grep -cE 'Script not found|command not found' "$LOG" 2>/dev/null)"; BADN="${BADN:-0}"
  LASTBLOCK="$(awk '/^\[kb\]/{buf=""} {buf=buf $0 "\n"} END{printf "%s", buf}' "$LOG" 2>/dev/null | tail -6)"
  if printf '%s' "$LASTBLOCK" | grep -qE 'error:|not found|exit=[1-9]'; then
    bad "同步日志**最近一轮**未干净（见下方；$LOG）"
  elif printf '%s' "$LASTBLOCK" | grep -q 'exit=0'; then
    ok "同步日志最近一轮 exit=0（历史上出现过 $BADN 行错误，若在升级前属旧版本遗留）"
  else
    warn "同步日志最近一轮未显示 exit=0（可能仍在执行第一轮）"
  fi
  printf '%s' "$LASTBLOCK" | sed 's/^/      /'
else
  warn "尚无同步日志（$LOG）：服务起过且循环执行一轮后才会生成"
fi

echo
if [ "$FAIL" -eq 0 ]; then echo "═══ 结论：未发现阻断性问题 ═══"; exit 0; fi
echo "═══ 结论：发现问题（见上方 ✗）═══"; exit 1
