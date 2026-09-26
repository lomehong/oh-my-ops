#!/usr/bin/env bash
# omo-kb 舰队接入（P4）：把「服务机签码 → 各实例接入」压成两条命令。
#
#   服务机： omo-kb-fleet.sh service [设备名…]        # 自检 → 逐设备签一次性码 → 打印每台实例的一条命令
#   实例：   omo-kb-fleet.sh instance --server <URL> --code <码> [--device <名>] [--verify-tls] [--dry-run]
#
# 说明：兑码文件强制 0600（脚本自动建）；自签证书默认 --allow-insecure-tls（内网），加 --verify-tls 可强制校验。
set -euo pipefail

MODE="${1:-}"
if [ -z "$MODE" ]; then sed -n '2,9p' "$0" | sed 's/^#\{1,\} \{0,1\}//'; exit 2; fi
shift

die()  { echo "✗ $*" >&2; exit 1; }
ok()   { echo "  ✓ $*"; }
info() { echo "  · $*"; }
warn() { echo "  ⚠ $*"; }

# ─────────────────────────────── 实例侧 ───────────────────────────────
if [ "$MODE" = "instance" ]; then
  SERVER="" CODE="" DEVICE="" DRY="no" VERIFY_TLS="no"
  while [ $# -gt 0 ]; do
    case "$1" in
      --server)     SERVER="$2"; shift 2 ;;
      --code)       CODE="$2";   shift 2 ;;
      --code-file)  CODE="$(cat "$2")"; shift 2 ;;
      --device)     DEVICE="$2"; shift 2 ;;
      --verify-tls) VERIFY_TLS="yes"; shift ;;
      --dry-run)    DRY="yes"; shift ;;
      *) die "未知参数：$1（见脚本头部用法）" ;;
    esac
  done
  [ -n "$SERVER" ] || die "缺 --server（例：--server https://172.26.5.123:8787）"
  [ -n "$CODE" ]   || die "缺 --code（或 --code-file <0600 文件>）"

  CODE_FILE="$(mktemp "${TMPDIR:-/tmp}/omo-kb-enroll.XXXXXX")"; chmod 600 "$CODE_FILE"
  printf '%s' "$CODE" > "$CODE_FILE"
  trap 'rm -f "$CODE_FILE"' EXIT

  ARGS=(kb enroll --server "$SERVER" --code-file "$CODE_FILE")
  [ -n "$DEVICE" ] && ARGS+=(--device "$DEVICE")
  [ "$VERIFY_TLS" = "yes" ] || ARGS+=(--allow-insecure-tls)

  if ! command -v omo >/dev/null 2>&1; then
    trap - EXIT                      # 保留码文件：本机还没装 omo，装好后可直接复用
    echo "✗ 本机没有 omo（agent 未安装）。先装再重试："
    echo "    cd /tmp && rm -rf omo-src && mkdir omo-src && cd omo-src"
    echo "    curl -fL 'https://gh-proxy.com/https://github.com/lomehong/oh-my-ops/releases/download/<版本>/oh-my-ops-<版本>.tar.gz' | tar xz --strip-components=1"
    echo "    bash scripts/install.sh"
    echo "  码已存 0600：$CODE_FILE ——装好后： bash $0 instance --server '$SERVER' --code-file '$CODE_FILE'"
    exit 3
  fi
  if [ "$DRY" = "yes" ]; then
    ok "dry-run：将执行 omo ${ARGS[*]}"
    info "码文件：$CODE_FILE（0600）"
    exit 0
  fi
  echo "── 兑换并自证 ──"
  omo "${ARGS[@]}"
  echo "── 接入现状 ──"
  omo kb status || true
  exit 0
fi

# ─────────────────────────────── 服务侧 ───────────────────────────────
if [ "$MODE" = "service" ]; then
  CFG="${OMO_KB_CONFIG:-$HOME/.omo-kb/config.env}"
  [ -f "$CFG" ] || die "找不到服务配置 $CFG —— 本机是服务机吗？（或设 OMO_KB_CONFIG=<路径>）"
  # shellcheck disable=SC1090
  . "$CFG"
  LAUNCHER="$HOME/.local/bin/omo-kb"
  [ -x "$LAUNCHER" ] || die "找不到启动器 $LAUNCHER（先跑 install.sh）"
  TOKEN_FILE="$HOME/.omo-kb/admin.token"
  [ -f "$TOKEN_FILE" ] || die "找不到管理员令牌 $TOKEN_FILE"

  # 实例要按「证书 SAN」连（自签证书只对 SAN 内的地址有效）
  SAN="$(openssl x509 -in "$OMO_KB_TLS_CERT" -noout -text 2>/dev/null | sed -n 's/.*IP Address:\([0-9.]*\).*/\1/p' | head -1 || true)"
  [ -n "$SAN" ] || SAN="$(openssl x509 -in "$OMO_KB_TLS_CERT" -noout -text 2>/dev/null | sed -n 's/.*DNS:\([^,]*\).*/\1/p' | head -1 || true)"
  # 兜底取本机 IP：`hostname -I` 只有 GNU 有（Windows Git Bash / macOS / BSD 都没有），叠加 pipefail 会**静默退出**；
  # 服务机必有 bun（安装器硬依赖），用它读首个非回环 IPv4
  [ -n "$SAN" ] || SAN="$(bun -e 'import os from "node:os"; for (const l of Object.values(os.networkInterfaces()).flat()) { if (l && l.family === "IPv4" && !l.internal) { console.log(l.address); break; } }' 2>/dev/null || true)"
  [ -n "$SAN" ] || die "证书里取不到 SAN、本机也读不到 IP：请用 OMO_KB_SERVER=https://<地址>:<端口> 显式指定"
  SERVER="${OMO_KB_SERVER:-https://${SAN}:${OMO_KB_PORT}}"

  echo "═══ 服务侧自检（$OMO_KB_API）═══"
  AUTH=(-H "Authorization: token $(cat "$TOKEN_FILE")")
  probe() { # $1=描述 $2=期望码正则；其余=curl 参数
    local desc="$1" expect="$2"; shift 2
    local code
    code="$(curl -sS -o /tmp/omo-kb-fleet.json -w '%{http_code}' --max-time 20 "${AUTH[@]}" "$@" 2>/tmp/omo-kb-fleet.err || true)"
    [ -n "$code" ] || code=000
    if [ "$code" = "000" ]; then
      die "$desc：**API 不可达**（$(head -1 /tmp/omo-kb-fleet.err 2>/dev/null)）—— 先修本机到 $OMO_KB_API 的连通性"
    fi
    if [ "$code" = "403" ] && grep -q scope /tmp/omo-kb-fleet.json 2>/dev/null; then
      die "$desc：令牌缺权 —— $(head -c 200 /tmp/omo-kb-fleet.json)（重签令牌，勾 read:admin,write:admin,write:repository,write:organization）"
    fi
    if printf '%s' "$code" | grep -qE "$expect"; then ok "$desc（HTTP $code）"
    else warn "$desc：HTTP $code（未能判定，继续）"; fi
  }
  probe "API 可达"                 "200|401|403" "$OMO_KB_API/version"
  probe "read:admin"               "200"         "$OMO_KB_API/admin/users?limit=1"
  probe "write:admin"              "422|400"     -X POST -H 'Content-Type: application/json' -d '{}' "$OMO_KB_API/admin/users"
  probe "write:repository"         "404|422|400" -X PUT -H 'Content-Type: application/json' -d '{"permission":"read"}' "$OMO_KB_API/repos/$OMO_KB_REPO/collaborators/__omo_scope_probe__"
  probe "write:organization"       "422|400"     -X POST -H 'Content-Type: application/json' -d '{}' "$OMO_KB_API/orgs/${OMO_KB_REPO%%/*}/teams"
  rm -f /tmp/omo-kb-fleet.json /tmp/omo-kb-fleet.err

  # 设备清单：给了就用给的，没给就签一张「任意设备」码
  if [ $# -gt 0 ]; then DEVICES=("$@"); else DEVICES=(""); fi
  OUTDIR="$HOME/omo-kb-enroll"; mkdir -p "$OUTDIR"; chmod 700 "$OUTDIR"
  FLEET_URL="${OMO_KB_FLEET_URL:-https://cdn.jsdelivr.net/gh/lomehong/oh-my-ops@main/scripts/omo-kb-fleet.sh}"

  echo
  echo "═══ 签发一次性码（30 分钟 · 单次消费）═══"
  for d in "${DEVICES[@]}"; do
    name="${d:-any}"; name="$(printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '_')"
    ERRF="$(mktemp)"; trap 'rm -f "$ERRF"' RETURN
    if [ -n "$d" ]; then
      CODE="$("$LAUNCHER" code --op enroll --device "$d" --ttl 30 --raw 2>"$ERRF")" || CODE=""
    else
      CODE="$("$LAUNCHER" code --op enroll --ttl 30 --raw 2>"$ERRF")" || CODE=""
    fi
    if [ -z "$CODE" ]; then
      if grep -q "\-\-raw" "$ERRF" 2>/dev/null; then
        die "服务包过旧（不支持 --raw）：在本机重跑一次安装器即可升级（登记表与凭据保留）：
      curl -fL '<服务包地址>/omo-kb-service-vX.Y.Z.tar.gz' | tar xz --strip-components=1 && bash install.sh --api $OMO_KB_API --repo $OMO_KB_REPO --admin-token-file $TOKEN_FILE --tls-cert $OMO_KB_TLS_CERT --tls-key $OMO_KB_TLS_KEY --host $OMO_KB_HOST --port $OMO_KB_PORT
      （或先备份 $OMO_KB_REGISTRY；错误原文：$(head -1 "$ERRF")）"
      fi
      die "签发失败：$(head -3 "$ERRF" | tr '\n' ' ')"
    fi
    FILE="$OUTDIR/$name.code"; printf '%s' "$CODE" > "$FILE"; chmod 600 "$FILE"
    ok "设备 ${d:-（任意）} → 码文件 $FILE（0600）"
    echo "      实例侧一条命令："
    echo "        curl -fsSL '$FLEET_URL' | bash -s -- instance --server '$SERVER' --code '$CODE'"
    echo "      （更稳妥：把 $FILE scp 到实例，然后 --code-file <路径> 替代 --code）"
  done
  echo
  info "服务地址（证书 SAN）：$SERVER"
  info "登记表：$OMO_KB_REGISTRY（只存 sha256）；查看：$LAUNCHER list"
  exit 0
fi

die "未知模式：$MODE（应为 service 或 instance）"
