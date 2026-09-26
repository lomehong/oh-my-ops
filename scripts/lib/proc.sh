#!/usr/bin/env bash
# proc.sh —— 「进程存活探测 / 收尾终止」跨平台共用库（验收探针专用）
#
# 背景（真机踩到，CIPORT-1）：
#   1) Windows/Git Bash 上 pid 文件可能装两种命名空间的 pid —— MSYS pid（bash 记的 $!）与原生
#      Windows pid（服务自写 --pid-file）；kill -0 只认前者，pgrep/pkill 在 Git Bash 不存在；
#   2) **EXIT trap 里的失败命令会点着 set -e**：断言全绿的探针照样 exit 1（test:ci 即红），
#      且服务（kill 不到位）与临时目录（Windows 文件句柄挡住 rm -rf）双双泄漏。
#
# 用法：
#   . "$REPO_ROOT/scripts/lib/proc.sh"
#   cleanup() { set +e; proc_kill "$(cat "$f" 2>/dev/null)"; rm -rf "$TMP" 2>/dev/null; return 0; }

pid_alive() { # $1=pid：双命名空间存活探测（tasklist 兜底要求镜像名为 bun，防 PID 复用误判）
  [ -n "${1:-}" ] || return 1
  kill -0 "$1" 2>/dev/null && return 0
  command -v tasklist >/dev/null 2>&1 || return 1
  tasklist //FI "PID eq $1" //FO CSV //NH 2>/dev/null | grep -qi bun
}

proc_kill() { # $1=pid：温柔终止（两个命名空间都覆盖），至多等 2s；退不干净则大声告警（绝不静默）
  local pid="${1:-}"
  local i=0
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  while [ "$i" -lt 10 ]; do
    if ! pid_alive "$pid"; then break; fi
    i=$((i + 1))
    if [ "$i" -eq 3 ]; then
      if command -v taskkill >/dev/null 2>&1; then taskkill //PID "$pid" //F //T >/dev/null 2>&1 || true; fi
    fi
    sleep 0.2
  done
  if pid_alive "$pid"; then
    echo "  ⚠ 未能停掉进程 PID $pid（请手动：taskkill //PID $pid //F）" >&2
  fi
  return 0
}
