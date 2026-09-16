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
#
# 受限网络取包（2026-09-16 对端实测）：部分企业网络**按主机放行**——`github.com:443` 可能不通，而
# `api.github.com` / `objects.githubusercontent.com` / `codeload.github.com` / 镜像站可用。此时 release
# 资产可用 **API 端点**取到同一产物（同一哈希，需 token）：
#   curl -L -H "Authorization: Bearer <token>" -H "Accept: application/octet-stream" \
#        "https://api.github.com/repos/lomehong/oh-my-ops/releases/assets/<asset_id>" -o oh-my-ops.tar.gz
# （asset_id 从 `GET /repos/<o>/<r>/releases/tags/<tag>` 的 assets[].id 取）
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
# semver 校验：接受 v 前缀可选、三段数字、可选 -prerelease
semver_ok() { [[ "$1" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; }
step() { printf '\n%s▸ %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '%s  ✓ %s%s\n' "$G" "$1" "$N"; }
warn() { printf '%s  ⚠ %s%s\n' "$Y" "$1" "$N"; }
die()  { printf '%s  ✗ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }
if ! grep -q "bootstrap-end" "$0" 2>/dev/null; then echo "  ✗ 脚本下载不完整（网络截断？）请重试" >&2; exit 1; fi

# ── 参数预扫描：--resolve-only（仅解析并打印版本后退出；供运维排查与回归守卫用）
#    其余参数原样透传给 install.sh（install.sh 对未知参数忽略）
RESOLVE_ONLY=false
_fwd=()
for _a in "$@"; do
  case "$_a" in
    --resolve-only) RESOLVE_ONLY=true ;;
    *)              _fwd+=("$_a") ;;
  esac
done
set -- ${_fwd[@]+"${_fwd[@]}"}

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
# 版本解析三策略（历史只认 302 重定向 → 代理/镜像以 200 直返页面时 basename 恒为 "latest"，
# 对端 2026-09-16 实测三源全落 latest、安装被拒）：
#   ① 资产重定向：releases/latest/download/install.sh 的 Location 头 → /download/vX.Y.Z
#   ② 页面解析：releases/latest 返回 200 HTML 时抓页面内 /releases/tag/vX.Y.Z
#   ③ 兜底：url_effective 的 basename（原有策略，直连正常时命中）
resolve_version() { # $1=源基址（direct=https://github.com/owner/repo；镜像=镜像前缀+该 URL）
  local base="$1" v
  v="$(curl -fsSI --retry 2 --connect-timeout 8 "$base/releases/latest/download/install.sh" 2>/dev/null \
        | tr -d '\r' | sed -n 's/^[Ll]ocation: //p' | tail -1 \
        | grep -oE '/download/v[0-9]+\.[0-9]+\.[0-9]+' | head -1 | sed 's#.*/download/##')"
  semver_ok "${v:-}" && { printf '%s' "$v"; return 0; }
  v="$(curl -fsSL --retry 2 --connect-timeout 8 "$base/releases/latest" 2>/dev/null \
        | grep -oE '/releases/tag/v[0-9]+\.[0-9]+\.[0-9]+' | head -1 | sed 's#.*/tag/##')"
  semver_ok "${v:-}" && { printf '%s' "$v"; return 0; }
  v="$(basename "$(curl -fsSL -o /dev/null -w '%{url_effective}' --retry 2 --connect-timeout 8 "$base/releases/latest" 2>/dev/null || true)")"
  printf '%s' "${v:-}"
}
VER="${OMO_VERSION:-}"
if [ -z "$VER" ]; then
  step "解析最新版本…"
  sources=()
  [ -n "${OMO_MIRROR:-}" ] && sources+=("$OMO_MIRROR")
  sources+=("direct" "https://gh-proxy.com" "https://ghproxy.cn")
  for src in "${sources[@]}"; do
    case "$src" in
      direct) base_url="$BASE" ;;
      *)      base_url="$src/$BASE" ;;
    esac
    VER="$(resolve_version "$base_url")"
    if semver_ok "$VER"; then { ok "版本 $VER（via $src）"; break; }
    else [ -n "$VER" ] && warn "源 $src 返回非 semver 版本「$VER」，跳过"
    fi
  done
  # 末位回退：GitHub API（直连被代理、镜像全挂时仍可能可达；未鉴权有 60 次/时/IP 限额）
  if ! semver_ok "${VER:-}"; then
    VER="$(curl -fsSL --retry 2 --connect-timeout 8 "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
          | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
    semver_ok "${VER:-}" && ok "版本 $VER（via api.github.com）"
  fi
fi
[ -n "$VER" ] || die "无法解析最新版本。手动指定：OMO_VERSION=v0.9.1 重试"
semver_ok "$VER" || die "版本「$VER」非 semver——拒绝下载。手动指定：OMO_VERSION=v0.9.1 重试"
case "$VER" in v*) ;; *) VER="v$VER" ;; esac
ok "版本 $VER"
if [ "$RESOLVE_ONLY" = true ]; then printf '%s\n' "$VER"; exit 0; fi

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
# bootstrap-end
