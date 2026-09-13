#!/usr/bin/env bash
# oh-my-ops 一行安装入口。
#
#   curl -fsSL https://github.com/lomehong/oh-my-ops/releases/latest/download/install.sh | bash
#
# 可选：
#   指定版本：  OMO_VERSION=v0.4.2 curl -fsSL ... | bash
#   传参透传：  curl -fsSL ... | bash -s -- --token <yuyi-token> --name <设备名>
#
# 行为：解析最新 Release → 下载 tarball + sha256 校验 → 临时目录解压 →
#       执行内部 scripts/install.sh（参数透传）→ 清理临时目录。
set -euo pipefail

REPO="lomehong/oh-my-ops"
BASE="https://github.com/$REPO"

say() { printf '%s\n' "$*"; }

# ── 解析版本：环境变量优先，否则跟随 releases/latest 重定向
VER="${OMO_VERSION:-}"
if [ -z "$VER" ]; then
  say "[1/4] 解析最新版本…"
  VER="$(basename "$(curl -fsSL -o /dev/null -w '%{url_effective}' "$BASE/releases/latest")")"
fi
case "$VER" in v*) ;; *) VER="v$VER" ;; esac
say "  版本：$VER"

# ── 下载 + 校验
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
say "[2/4] 下载 $VER …"
curl -fsSL "$BASE/releases/download/$VER/oh-my-ops-$VER.tar.gz"      -o "$WORK/oh-my-ops-$VER.tar.gz"
curl -fsSL "$BASE/releases/download/$VER/oh-my-ops-$VER.tar.gz.sha256" -o "$WORK/oh-my-ops-$VER.tar.gz.sha256"
( cd "$WORK" && sha256sum -c "oh-my-ops-$VER.tar.gz.sha256" >/dev/null ) || { say "✗ sha256 校验失败（下载损坏？）"; exit 1; }
say "  ✓ 校验通过"

say "[3/4] 解压并安装…"
mkdir -p "$WORK/pkg"
tar xzf "$WORK/oh-my-ops-$VER.tar.gz" -C "$WORK/pkg"
PKG_DIR="$WORK/pkg/oh-my-ops-$VER"
[ -f "$PKG_DIR/scripts/install.sh" ] || { say "✗ 包结构异常（缺 scripts/install.sh）"; exit 1; }
bash "$PKG_DIR/scripts/install.sh" "$@"

say "[4/4] 清理 ✓"
say
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) say "⚠ ~/.local/bin 不在 PATH，请先执行： export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac
say "═══ ✓ omo 安装完成（$VER）═══"
say "  omo            交互式"
say "  omo -p '巡检本机'  非交互巡检"
say "  omo status     状态"
