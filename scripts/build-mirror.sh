#!/usr/bin/env bash
# build-mirror.sh — 构建/刷新 OpsPi 品牌化 omp 镜像。用法：build-mirror.sh <mirror-dir> <system-pkg-dir>
# 由 install.sh 与 omo 启动器（自愈）共用。原子构建：失败不动现有镜像。
#
# 为什么 pi-natives* 必须实体拷贝：
#   bun 全局安装的包是指向 ~/.bun/install/cache 的 symlink，cache 里的
#   pi-natives 壳包缺 .node，且 cache 布局下 loader realpath 的向上解析
#   找不到平台包 → 原生模块加载必炸。镜像内两者都实体化后，
#   loader realpath 落在镜像内，向上即见平台包。
set -euo pipefail

MIR="${1:?usage: build-mirror.sh <mirror-dir> <system-pkg-dir>}"
SYS_DIR="${2:?usage: build-mirror.sh <mirror-dir> <system-pkg-dir>}"
PATCH="$HOME/.ops-pi/bin/patch-omp-brand.mjs"
STAGE="$MIR.new"

[ -f "$SYS_DIR/dist/cli.js" ] || { echo "✗ 系统产物不存在：$SYS_DIR/dist/cli.js"; exit 1; }
[ -f "$PATCH" ] || { echo "✗ 补丁脚本不存在：$PATCH（先运行 install.sh）"; exit 1; }

NM_SYS="$SYS_DIR/node_modules"
shopt -s nullglob

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# ── dist 整目录拷贝（cli.js 引用同级模板资产）+ package.json
mkdir -p "$STAGE"
cp -r "$SYS_DIR/dist" "$STAGE/dist"
cp "$SYS_DIR/package.json" "$STAGE/" 2>/dev/null || true

# ── node_modules 真实目录：pi-natives* 实体拷贝（系统→bun cache 依次找），其余 symlink
NM_MIR="$STAGE/node_modules"
rm -rf "$NM_MIR"
mkdir -p "$NM_MIR/@oh-my-pi"

first_existing() { # $1=base，候选：系统包 → bun cache
	local base="$1" c
	if [ -e "$NM_SYS/@oh-my-pi/$base" ]; then printf '%s' "$NM_SYS/@oh-my-pi/$base"; return 0; fi
	if [ -d "$HOME/.bun/install/cache/@oh-my-pi" ]; then
		while IFS= read -r c; do printf '%s' "$c"; return 0; done < <(find -L "$HOME/.bun/install/cache/@oh-my-pi" -maxdepth 1 -type d -name "$base" 2>/dev/null || true)
	fi
	return 1
}

for child in "$NM_SYS"/*; do
	base="$(basename "$child")"
	case "$base" in
		pi-natives*|@oh-my-pi) continue ;;
	esac
	ln -sfn "$child" "$NM_MIR/$base"
done
for child in "$NM_SYS/@oh-my-pi"/*; do
	base="$(basename "$child")"
	case "$base" in
		pi-natives*)
			if src="$(first_existing "$base")"; then cp -rL "$src" "$NM_MIR/@oh-my-pi/$base"
			else cp -rL "$child" "$NM_MIR/@oh-my-pi/$base"; fi
			;;
		*) ln -sfn "$child" "$NM_MIR/@oh-my-pi/$base" ;;
	esac
done

# ── 终检：loader 壳包存在 + 至少一个 pi-natives* 含 .node
[ -d "$NM_MIR/@oh-my-pi/pi-natives" ] || { echo "✗ 镜像缺 pi-natives（loader）"; exit 1; }
if ! find -L "$NM_MIR/@oh-my-pi" -maxdepth 2 -name "pi-natives*" -prune -exec find {} -name "*.node" -print -quit \; 2>/dev/null | grep -q .; then
	# 平台包缺失时的兜底：尝试 bun cache 里任意含 .node 的 pi-natives 平台包
	if [ -d "$HOME/.bun/install/cache/@oh-my-pi" ]; then
		while IFS= read -r c; do
			if find -L "$c" -name "*.node" -print -quit 2>/dev/null | grep -q .; then
				cp -rL "$c" "$NM_MIR/@oh-my-pi/$(basename "$c")"; break
			fi
		done < <(find -L "$HOME/.bun/install/cache/@oh-my-pi" -maxdepth 1 -type d -name "pi-natives-*" 2>/dev/null || true)
	fi
fi
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
trap - EXIT
echo "✓ 镜像已就绪：$MIR/dist/cli.js（品牌内置）"
