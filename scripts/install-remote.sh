#!/usr/bin/env bash
# install-remote.sh —— 由 KB 控制面分发的安装入口（KBCP-P0-3）
#
# 输入（由后台生成的命令提供）：
#   OMO_CONTROL_PLANE       控制面公开地址
#   OMO_TLS_PIN             sha256//<自签 CA 公钥 SPKI pin>
#   OMO_TLS_CA_FILE         服务端自签 CA PEM（命令已下载到 0600 临时文件）
#   OMO_INSTALL_TOKEN_FILE  一次性安装令牌（0600；命令从该文件读取）
#   OMO_INSTALL_DEVICE      可选设备名（缺省 hostname）
#   OMO_INSTALL_UPGRADE=1   显式允许覆盖既有 ~/.omo（升级）
#   OMO_INSTALL_DRY_RUN=1   仅下载/校验，不执行安装（测试用）
#
# 纪律：
#   - 禁止 `-k`；现代 curl 用 --cacert + --pinnedpubkey；el7 legacy 用 openssl 校验 CA pin + --cacert + --config 头文件。
#   - 先取 manifest，再取脚本；脚本执行前由命令层校验 script_sha256（本脚本假定已校验）。
#   - 分阶段上报；失败不伪报成功。
set -euo pipefail

CP="${OMO_CONTROL_PLANE:?缺少 OMO_CONTROL_PLANE}"
PIN="${OMO_TLS_PIN:?缺少 OMO_TLS_PIN}"
CA="${OMO_TLS_CA_FILE:?缺少 OMO_TLS_CA_FILE}"
TOKEN_FILE="${OMO_INSTALL_TOKEN_FILE:?缺少 OMO_INSTALL_TOKEN_FILE}"
DEVICE="${OMO_INSTALL_DEVICE:-$(hostname 2>/dev/null || echo unknown)}"
TMPD="${OMO_INSTALL_TMPDIR:-$(mktemp -d)}"
OWN_TMP=0
MODERN=no
if [ -z "${OMO_INSTALL_TMPDIR:-}" ]; then OWN_TMP=1; fi
cleanup() { set +e; if [ "$OWN_TMP" = "1" ]; then rm -rf "$TMPD"; fi; return 0; }
trap cleanup EXIT

fail() { # $1=stage $2=reason
  local stage="$1" reason="$2"
  echo "  ✗ [$stage] $reason" >&2
  report "$stage" false "$reason" || true
  exit 1
}
pass() { echo "  ✓ $1"; }
info() { echo "  · $1"; }

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

report() { # $1=stage $2=ok(true|false) $3=reason
  # 早期失败（CA/token 缺失）时尚无可用的 TLS/header 文件，无法上报；不要因此二次失败。
  [ -n "${HDR:-}" ] && [ -n "${CFG:-}" ] && [ -n "${MODERN:-}" ] || return 0
  local stage="$1" ok="$2" reason="${3:-}" body
  body="{\"stage\":\"$(json_escape "$stage")\",\"ok\":$ok,\"device\":\"$(json_escape "$DEVICE")\",\"reason\":\"$(json_escape "$reason")\"}"
  curl_post "$CP/install/report" "$body" "$TMPD/report.json" >/dev/null 2>&1 || true
}

# ── curl 能力与 TLS 信任 ─────────────────────────────────────────────
[ -s "$CA" ] || fail tls_trust "CA 文件缺失：$CA"
[ -s "$TOKEN_FILE" ] || fail tls_trust "安装令牌文件缺失：$TOKEN_FILE"
TOKEN="$(cat "$TOKEN_FILE")"
[ -n "$TOKEN" ] || fail tls_trust "安装令牌为空"
umask 077
HDR="$TMPD/headers"
CFG="$TMPD/curl.cfg"
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$HDR"
# curl --config 的 header 语法（legacy 用；内容 0600，不进入 argv）
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$CFG"
chmod 600 "$HDR" "$CFG"

CURL_VERSION="$(curl --version 2>/dev/null | head -1 | awk '{print $2}')"
CURL_MAJOR="$(printf '%s' "$CURL_VERSION" | cut -d. -f1)"
CURL_MINOR="$(printf '%s' "$CURL_VERSION" | cut -d. -f2)"
HELP="$(curl --help all 2>/dev/null || curl --help 2>/dev/null || true)"
MODERN=no
if printf '%s' "$HELP" | grep -q -- '--pinnedpubkey' && { [ "$CURL_MAJOR" -gt 7 ] || { [ "$CURL_MAJOR" -eq 7 ] && [ "$CURL_MINOR" -ge 55 ]; }; }; then
  MODERN=yes
elif [ "$CURL_MAJOR" -lt 7 ] || { [ "$CURL_MAJOR" -eq 7 ] && [ "$CURL_MINOR" -lt 29 ]; }; then
  fail platform "curl $CURL_VERSION 过旧：需要 ≥7.29（legacy）或 ≥7.55（modern）"
fi
if [ "$MODERN" = "no" ]; then
  command -v openssl >/dev/null 2>&1 || fail platform "el7 legacy 需要 openssl 校验 CA pin，但本机无 openssl"
  PIN_B64="${PIN#sha256//}"
  CA_PIN="$(openssl x509 -in "$CA" -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | openssl dgst -sha256 -binary 2>/dev/null | openssl base64 -A 2>/dev/null || true)"
  [ -n "$CA_PIN" ] && [ "$CA_PIN" = "$PIN_B64" ] || fail tls_trust "CA 公钥 pin 不匹配（legacy）"
fi
pass "TLS 模式：$( [ "$MODERN" = yes ] && echo "modern curl $CURL_VERSION" || echo "legacy curl $CURL_VERSION + openssl pin" )"

curl_fetch() { # $1=url $2=out
  if [ "$MODERN" = "yes" ]; then
    curl -fsS --cacert "$CA" --pinnedpubkey "$PIN" --header @"$HDR" "$1" -o "$2"
  else
    curl -fsS --cacert "$CA" --config "$CFG" "$1" -o "$2"
  fi
}
curl_post() { # $1=url $2=json $3=out
  if [ "$MODERN" = "yes" ]; then
    curl -fsS --cacert "$CA" --pinnedpubkey "$PIN" --header @"$HDR" -H 'Content-Type: application/json' -X POST -d "$2" "$1" -o "$3"
  else
    curl -fsS --cacert "$CA" --config "$CFG" -H 'Content-Type: application/json' -X POST -d "$2" "$1" -o "$3"
  fi
}

# ── 平台与制品 ────────────────────────────────────────────────────────
OS="${OMO_INSTALL_OS:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
ARCH="${OMO_INSTALL_ARCH:-$(uname -m)}"
case "$ARCH" in
  amd64) ARCH="x86_64" ;;
  arm64) ARCH="aarch64" ;;
esac
case "$OS/$ARCH" in
  linux/x86_64|linux/aarch64|darwin/x86_64|darwin/aarch64) ;;
  *) fail platform "不支持的平台：$OS/$ARCH" ;;
esac
info "平台：$OS/$ARCH"

curl_fetch "$CP/install/manifest?os=$OS&arch=$ARCH" "$TMPD/manifest.json" || fail manifest "无法获取 manifest"
ART_NAME="$(sed -n 's/.*"artifact_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMPD/manifest.json" | head -1)"
ART_HASH="$(sed -n 's/.*"artifact_sha256"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$TMPD/manifest.json" | head -1)"
ART_SIZE="$(sed -n 's/.*"artifact_size"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$TMPD/manifest.json" | head -1)"
[ -n "$ART_NAME" ] && [ -n "$ART_HASH" ] || fail manifest "manifest 缺 artifact_name/artifact_sha256"
pass "manifest：$ART_NAME"
report manifest true ""

curl_fetch "$CP/install/artifacts/$ART_NAME" "$TMPD/pkg.tar.gz" || fail downloaded "制品下载失败"
ACTUAL_SIZE="$(stat -c%s "$TMPD/pkg.tar.gz" 2>/dev/null || stat -f%z "$TMPD/pkg.tar.gz" 2>/dev/null || echo "")"
[ -z "$ART_SIZE" ] || [ "$ACTUAL_SIZE" = "$ART_SIZE" ] || fail downloaded "制品大小不符（期望 $ART_SIZE，实际 $ACTUAL_SIZE）"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_HASH="$(sha256sum "$TMPD/pkg.tar.gz" | awk '{print $1}')"
else
  ACTUAL_HASH="$(shasum -a 256 "$TMPD/pkg.tar.gz" | awk '{print $1}')"
fi
[ "$ACTUAL_HASH" = "$ART_HASH" ] || fail downloaded "制品 sha256 不符"
pass "制品校验：${ACTUAL_HASH:0:16}…"
report downloaded true ""

mkdir -p "$TMPD/pkg"
tar -xzf "$TMPD/pkg.tar.gz" -C "$TMPD/pkg" || fail installed "解包失败"
if [ -f "$TMPD/pkg/scripts/install.sh" ]; then
  INSTALL_SH="$TMPD/pkg/scripts/install.sh"
elif [ -f "$TMPD/pkg/install.sh" ]; then
  INSTALL_SH="$TMPD/pkg/install.sh"
else
  fail installed "安装包内缺 scripts/install.sh 或 install.sh"
fi

if [ "${OMO_INSTALL_DRY_RUN:-0}" = "1" ]; then
  echo "  · DRY_RUN=1：已下载并校验，未执行安装"
  exit 0
fi

if [ -d "$HOME/.omo" ] && [ "${OMO_INSTALL_UPGRADE:-0}" != "1" ]; then
  fail installed "检测到既有 ~/.omo；如需升级，请使用后台的升级命令（OMO_INSTALL_UPGRADE=1）"
fi
info "执行安装器：$INSTALL_SH"
if ! HOME="$HOME" bash "$INSTALL_SH" >"$TMPD/install.log" 2>&1; then
  tail -20 "$TMPD/install.log" >&2 || true
  fail installed "安装器执行失败（日志已在上方）"
fi
pass "安装完成"
report installed true ""

OMO_BIN="$(command -v omo 2>/dev/null || true)"
if [ -z "$OMO_BIN" ] && [ -x "$HOME/.local/bin/omo" ]; then OMO_BIN="$HOME/.local/bin/omo"; fi
if [ -z "$OMO_BIN" ] && [ -x "/usr/local/bin/omo" ]; then OMO_BIN="/usr/local/bin/omo"; fi
[ -n "$OMO_BIN" ] || fail enrolled "安装完成但找不到 omo 启动器"

# KB 接入：用受 TLS pin 保护的 curl 取回凭据，再交给 omo 落盘（不在客户端重复 TLS 实现）
# CA 持久化到私有域（0600）：后续 `omo kb status --report` 用同一信任锚连接控制面
CA_DIR="$HOME/.omo/kb"
mkdir -p "$CA_DIR"
chmod 700 "$CA_DIR" 2>/dev/null || true
cp "$CA" "$CA_DIR/control-plane-ca.pem"
chmod 600 "$CA_DIR/control-plane-ca.pem" 2>/dev/null || true
export OMO_KB_CA_FILE="$CA_DIR/control-plane-ca.pem"
ENROLL_BODY="{\"device\":\"$(json_escape "$DEVICE")\"}"
curl_post "$CP/install/enroll" "$ENROLL_BODY" "$TMPD/enroll.json" || fail enrolled "KB 接入请求失败（服务不可达/令牌失效）"
if ! "$OMO_BIN" kb enroll --response-file "$TMPD/enroll.json" >"$TMPD/enroll.log" 2>&1; then
  tail -20 "$TMPD/enroll.log" >&2 || true
  fail enrolled "凭据落盘失败"
fi
pass "KB 接入完成"

if "$OMO_BIN" kb status >"$TMPD/status.log" 2>&1; then
  pass "KB 自证完成"
else
  tail -20 "$TMPD/status.log" >&2 || true
  fail verified "KB 自证失败"
fi
report verified true ""
echo "  ✓ 安装与 KB 接入完成：$DEVICE"
