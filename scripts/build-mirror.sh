#!/usr/bin/env bash
# build-mirror.sh — 构建/刷新 OpsPi 品牌化 omp 镜像。用法：build-mirror.sh <mirror-dir> <system-pkg-dir>
# 由 install.sh 与 omo 启动器（自愈）共用。原子构建：失败不动现有镜像。
#
# node_modules 解析覆盖三种布局：
#   ① npm -g     ：依赖嵌套在 pi-coding-agent/node_modules/
#   ② bun -g     ：依赖提升到 global/node_modules/（pi-coding-agent 的上一级）
#   ③ bun cache  ：~/.bun/install/cache/<pkg>@<ver>@@@N（symlink 真身，兜底前缀匹配）
# pi-natives* 必须实体拷贝：cache 副本缺 .node，且 cache 布局下 loader realpath
# 的向上解析看不到平台包。其他包若是指向 cache 且含 .node 的 symlink，同样实体化。
set -euo pipefail

MIR="${1:?usage: build-mirror.sh <mirror-dir> <system-pkg-dir>}"
SYS_DIR="${2:?usage: build-mirror.sh <mirror-dir> <system-pkg-dir>}"
PATCH="$HOME/.ops-pi/bin/patch-omp-brand.mjs"
STAGE="$MIR.new"

[ -f "$SYS_DIR/dist/cli.js" ] || { echo "✗ 系统产物不存在：$SYS_DIR/dist/cli.js"; exit 1; }
[ -f "$PATCH" ] || { echo "✗ 补丁脚本不存在：$PATCH（先运行 install.sh）"; exit 1; }

has_node() { find -L "$1" -name "*.node" -print -quit 2>/dev/null | grep -q .; }

# ── 候选「包目录」根（子项即包；去重、优先级递减）
#   ① npm -g 嵌套：pi-coding-agent/node_modules
#   ② bun -g 提升（scoped 包）：global/node_modules
#   ③ bun -g 提升（非 scoped）：dirname(pi-coding-agent)
#   ④ 显式 bun 全局目录
NM_ROOTS=("$SYS_DIR/node_modules")
_gp="$(dirname "$SYS_DIR")"
case "$(basename "$_gp")" in
	@*) NM_ROOTS+=("$(dirname "$_gp")") ;;
	*) NM_ROOTS+=("$_gp") ;;
esac
NM_ROOTS+=("$HOME/.bun/install/global/node_modules")
NM_ROOTS=($(printf '%s\n' "${NM_ROOTS[@]}" | awk '!seen[$0]++'))

# find_pkg <scope相对路径> → 第一个命中的真实路径；NM 根都未命中时用 bun cache 前缀兜底
find_pkg() {
	local rel="$1" r c
	for r in "${NM_ROOTS[@]}"; do
		[ -e "$r/$rel" ] && { printf '%s' "$r/$rel"; return 0; }
	done
	if [[ "$rel" == @*/* ]]; then
		local scope="${rel%%/*}" base="${rel#*/}"
		[ -d "$HOME/.bun/install/cache/$scope" ] || return 1
		while IFS= read -r c; do printf '%s' "$c"; return 0; done \
			< <(find -L "$HOME/.bun/install/cache/$scope" -maxdepth 1 -type d -name "$base@*" 2>/dev/null | sort | tail -1)
	fi
	return 1
}

# ── dist 整目录拷贝（cli.js 引用同级模板资产）+ package.json
mkdir -p "$STAGE"
cp -r "$SYS_DIR/dist" "$STAGE/dist"
cp "$SYS_DIR/package.json" "$STAGE/" 2>/dev/null || true

# ── node_modules 真实目录；顶层按 base 去重（先命中者优先）
NM_MIR="$STAGE/node_modules"
rm -rf "$NM_MIR"
mkdir -p "$NM_MIR/@oh-my-pi"
declare -A SEEN=()

link_or_copy() { # $1=dest  $2=src；cache symlink 且含 .node → 实体拷贝
	if [[ "$(readlink -f "$2")" == "$HOME/.bun/install/cache/"* ]] && has_node "$2"; then
		cp -rL "$2" "$1"
	else
		ln -sfn "$2" "$1"
	fi
}

for r in "${NM_ROOTS[@]}"; do
	[ -d "$r" ] || continue
	for child in "$r"/*; do
		base="$(basename "$child")"
		[ -n "${SEEN[$base]:-}" ] && continue
		case "$base" in pi-natives*|@oh-my-pi) continue ;; esac
		SEEN[$base]=1
		link_or_copy "$NM_MIR/$base" "$child"
	done
	for child in "$r/@oh-my-pi"/*; do
		base="$(basename "$child")"
		[ -n "${SEEN[$base]:-}" ] && continue
		SEEN[$base]=1
		case "$base" in
			pi-natives*)
				if src="$(find_pkg "@oh-my-pi/$base")"; then cp -rL "$src" "$NM_MIR/@oh-my-pi/$base"
				else cp -rL "$child" "$NM_MIR/@oh-my-pi/$base"; fi
				;;
			*) link_or_copy "$NM_MIR/@oh-my-pi/$base" "$child" ;;
		esac
	done
done
unset SEEN

# ── 兜底：镜像里仍无任何 pi-natives* → 从 bun cache 前缀匹配补
if [ -z "$(find "$NM_MIR/@oh-my-pi" -maxdepth 1 -name "pi-natives*" -print -quit 2>/dev/null)" ] \
	&& [ -d "$HOME/.bun/install/cache/@oh-my-pi" ]; then
	while IFS= read -r c; do
		b="$(basename "$c")"; b="${b%%@*}"
		[ -e "$NM_MIR/@oh-my-pi/$b" ] && continue
		cp -rL "$c" "$NM_MIR/@oh-my-pi/$b"
	done < <(find -L "$HOME/.bun/install/cache/@oh-my-pi" -maxdepth 1 -type d -name "pi-natives*" 2>/dev/null || true)
fi

# ── 终检：loader 壳包存在 + 至少一个 pi-natives* 含 .node
[ -d "$NM_MIR/@oh-my-pi/pi-natives" ] || { echo "✗ 镜像缺 pi-natives（loader）。已搜索：${NM_ROOTS[*]} + bun cache" >&2; exit 1; }
if ! find -L "$NM_MIR/@oh-my-pi" -name "*.node" -print -quit 2>/dev/null | grep -q .; then
	echo "✗ 镜像内无任何 pi-natives 原生文件（.node）。" >&2
	echo "  目标机修复：重装 omp 的 natives 后重跑安装，例如" >&2
	echo "    cd \"\$(dirname \"\$(readlink -f \"\$(command -v omp)\")\")/..\" && bun install @oh-my-pi/pi-natives" >&2
	exit 1
fi

# ── 品牌补丁打进镜像副本
node "$PATCH" --target "$STAGE/dist/cli.js" >/dev/null

# ── 原子换入
rm -rf "$MIR"
mv "$STAGE" "$MIR"
echo "✓ 镜像已就绪：$MIR/dist/cli.js（品牌内置）"
