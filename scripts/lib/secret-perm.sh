#!/usr/bin/env bash
# secret-perm.sh —— 「秘密文件权限」能力探测与断言（安装器共用；与 lib/secret-perm.mjs 同一策略）
#
# 背景：POSIX 上 0600 是硬要求；但 Windows/Git Bash 的文件系统**无法表达** 0600
# （Node 以 mode 0o600 写文件，stat 仍返回 666；bash `chmod 600` 得到 644）⇒ 在无法表达的
# 平台上「硬拦」等于把整条工具链锁死。策略（CIPORT-1）：
#   - 能力探测在**运行时实测**（临时文件 chmod 600 → stat），不看平台名；
#   - 能表达 ⇒ 权限过宽即拒（POSIX 严格性完全保留）；
#   - 不能表达 ⇒ stderr **大声一次性警告**后放行（绝不静默降级）。
#
# 用法：. "$SELF_DIR/lib/secret-perm.sh"
#   check_secret_perm <file> <用途> <修复后缀>   # 不合格时打印 ✗ 并 return 1（调用方决定是否退出）
#   can_express_0600                             # 供桩/探针直接断言

_OMO_PERM_CACHE=""
can_express_0600() {
	if [ -n "$_OMO_PERM_CACHE" ]; then [ "$_OMO_PERM_CACHE" = yes ]; return; fi
	local dir probe mode
	dir="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/omo-perm-probe.$$")"
	mkdir -p "$dir" 2>/dev/null || true
	probe="$dir/f"
	(umask 077; : > "$probe") 2>/dev/null || true
	chmod 600 "$probe" 2>/dev/null || true
	mode="$(stat -c %a "$probe" 2>/dev/null || stat -f %Lp "$probe" 2>/dev/null || echo unknown)"
	rm -rf "$dir" 2>/dev/null || true
	if [ "$mode" = "600" ] || [ "$mode" = "400" ]; then _OMO_PERM_CACHE=yes; else _OMO_PERM_CACHE=no; fi
	[ "$_OMO_PERM_CACHE" = yes ]
}

_OMO_PERM_WARNED=""
check_secret_perm() {
	local file="$1" what="${2:-秘密}" fix="${3:-重跑}"
	[ -n "$file" ] || return 0
	local perm
	perm="$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file" 2>/dev/null || echo unknown)"
	case "$perm" in 600|400) return 0 ;; esac
	if can_express_0600; then
		echo "✗ ${what}文件权限过宽（应 0600）：$file 当前 $perm —— 修复：chmod 600 $file 后$fix" >&2
		return 1
	fi
	if [ -z "$_OMO_PERM_WARNED" ]; then
		_OMO_PERM_WARNED=1
		echo "  ⚠ 本文件系统无法表达 0600（Windows/Git Bash 已知短板）：${what}文件 $file 实际权限 $perm 不受约束" >&2
		echo "  ⚠ 已降级放行；POSIX 主机上同一检查仍会硬拦。请确保该文件所在目录仅本账号可读。" >&2
	fi
	return 0
}
