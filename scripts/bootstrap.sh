#!/usr/bin/env bash
# oh-my-ops 一行安装入口。
#
#   curl -fsSL https://github.com/lomehong/oh-my-ops/releases/latest/download/install.sh | bash
#
# 可选：
#   指定版本：  OMO_VERSION=v0.4.3 curl -fsSL ... | bash
#   自定义镜像：OMO_MIRROR=https://ghproxy.cn curl -fsSL ... | bash
#   传参透传：  curl -fsSL ... | bash -s -- --token <yuyi-token> --name <设备名>
#
# 下载策略：直连 → OMO_MIRROR → 内置镜像列表，逐个回退；带重试与进度条。
set -euo pipefail

REPO="lomehong/oh-my-ops"
BASE="https://github.com/$REPO"
T0=$SECONDS

# ── 输出助手（非 TTY 时自动去色）
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  G=$'\033[32m' R=$'\033[31m' Y=$'\033[33m' B=$'\033[36m' D=$'\033[2m' N=$'\033[0m'
else
  G="" R="" Y="" B="" D="" N=""
fi
step() { printf '\n%s▸ %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '%s  ✓ %s%s\n' "$G" "$1" "$N"; }
warn() { printf '%s  ⚠ %s%s\n' "$Y" "$1" "$N"; }
die()  { printf '%s  ✗ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }

# ── 下载：多源回退（直连 → OMO_MIRROR → 内置镜像），重试 + 进度条
CURL_QUIET=""; [ -t 2 ] && CURL_QUIET="--progress-bar" || CURL_QUIET="-sS"
# --retry-all-errors 需 curl ≥ 7.71（老 curl 遇未知选项整条失败，logstash-124 实测）→ 能力探测后按需附加；
# 缺失时仅少了「非瞬态错误重试」，多源回退语义不变
CURL_RETRY_ALL=""
if curl --help all 2>/dev/null | grep -q -- --retry-all-errors; then
  CURL_RETRY_ALL="--retry-all-errors"
fi
# 下载内容有效性：gzip 魔数 / sha256 文件格式（镜像可能回 200 的 HTML 垃圾）
valid_download() {
  local f="$1"
  [ -s "$f" ] || return 1
  case "$f" in
    *.tar.gz)    head -c 2 "$f" | od -An -tx1 | grep -q "1f 8b" ;;
    *.sha256)    grep -qE "^[0-9a-f]{64} " "$f" ;;
    *)           return 0 ;;
  esac
}

fetch() { # $1=github绝对路径  $2=输出文件
  local url="$1" dest="$2" src tried=0
  local -a sources=()
  [ -n "${OMO_MIRROR:-}" ] && sources+=("$OMO_MIRROR")
  sources+=("direct" "https://ghproxy.cn" "https://gh-proxy.com")
  for src in "${sources[@]}"; do
    case "$src" in
      direct)            url="$1" ;;
      *)                 url="$src/$1" ;;
    esac
    tried=$((tried+1))
    printf '%s  ↓ [%s] %s%s\n' "$D" "$src" "$(basename "$dest")" "$N"
    if curl -fL $CURL_QUIET --retry 3 --retry-delay 2 $CURL_RETRY_ALL \
         --connect-timeout 10 -o "$dest" "$url" && valid_download "$dest"; then
      ok "下载成功（$src，第 $tried 次尝试）"
      return 0
    fi
    warn "源失败：$src"
    rm -f "$dest"
  done
  die "所有下载源均失败。手动安装：
  curl -L $BASE/releases/download/$VER/oh-my-ops-$VER.tar.gz -o oh-my-ops.tar.gz
  tar xzf oh-my-ops.tar.gz && cd oh-my-ops-$VER && bash scripts/install.sh
  （网络受限可设置镜像：OMO_MIRROR=https://ghproxy.cn …）"
}
# ── [1/4] 解析版本
VER="${OMO_VERSION:-}"
if [ -z "$VER" ]; then
  step "解析最新版本…"
  # 逐源解析 releases/latest 重定向（直连 → OMO_MIRROR → 内置镜像）；非 semver 响应视为该源失败（A6）
  sources=()
  [ -n "${OMO_MIRROR:-}" ] && sources+=("$OMO_MIRROR")
  sources+=("direct" "https://gh-proxy.com" "https://ghproxy.cn")
  for src in "${sources[@]}"; do
    case "$src" in
      direct) url="$BASE/releases/latest" ;;
      *)      url="$src/$BASE/releases/latest" ;;
    esac
    VER="$(basename "$(curl -fsSL -o /dev/null -w '%{url_effective}' --retry 2 --connect-timeout 8 "$url" 2>/dev/null || true)")"
    if semver_ok "$VER"; then { ok "版本 $VER（via $src）"; break; }
    else [ -n "$VER" ] && warn "源 $src 返回非 semver 版本「$VER」，跳过"
    fi
  done
fi
[ -n "$VER" ] || die "无法解析最新版本。手动指定：OMO_VERSION=v0.6.1 重试"
semver_ok "$VER" || die "版本「$VER」非 semver——拒绝下载。手动指定：OMO_VERSION=v0.6.1 重试"
case "$VER" in v*) ;; *) VER="v$VER" ;; esac
ok "版本 $VER"

# ── [2/4] 下载 + 校验
step "下载 $VER（tarball + sha256）…"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fetch "$BASE/releases/download/$VER/oh-my-ops-$VER.tar.gz"        "$WORK/oh-my-ops-$VER.tar.gz"
fetch "$BASE/releases/download/$VER/oh-my-ops-$VER.tar.gz.sha256" "$WORK/oh-my-ops-$VER.tar.gz.sha256"
( cd "$WORK" && sha256sum -c "oh-my-ops-$VER.tar.gz.sha256" >/dev/null ) \
  || die "sha256 校验失败（下载损坏），请重试"
ok "完整性校验通过"

# ── [3/4] 解压 + 安装（参数透传）
step "解压并安装…"
mkdir -p "$WORK/pkg"
tar xzf "$WORK/oh-my-ops-$VER.tar.gz" -C "$WORK/pkg"
PKG_DIR="$WORK/pkg/oh-my-ops-$VER"
[ -f "$PKG_DIR/scripts/install.sh" ] || die "包结构异常（缺 scripts/install.sh）"
bash "$PKG_DIR/scripts/install.sh" "$@"

# ── [4/4] 完成
ELAPSED=$((SECONDS - T0))
step "清理临时文件 ✓"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) warn "~/.local/bin 不在 PATH：export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac
printf '\n%s═══ ✓ omo 安装完成（%s，耗时 %ss）═══%s\n' "$G" "$VER" "$ELAPSED" "$N"
printf '  %somo%s               交互式\n' "$B" "$N"
printf '  %somo -p %s巡检本机%s  非交互巡检\n' "$B" "$D" "$N"
printf '  %somo status%s         状态\n' "$B" "$N"
