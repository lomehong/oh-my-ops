#!/usr/bin/env bash
# oh-my-ops 知识库**自注册服务**（kb-enroll）一键部署安装器
#
# 形态与 omo 安装器一致：私有域（可整体删除）+ 唯一对外痕迹（~/.local/bin/omo-kb 启动器 + 一个 systemd 单元）；
# 不装系统级依赖（bun 走共享自举；TLS 默认自签，也可用你已有的证书）。
#
#   curl -fsSL https://cdn.jsdelivr.net/gh/lomehong/oh-my-ops@main/scripts/install-enroll-service.sh -o /tmp/install-omo-kb.sh
#   bash /tmp/install-omo-kb.sh --api https://<gitea>/git/api/v1 --repo <owner>/<repo> \
#        --admin-user <站点管理员> --admin-password-file /root/admin.pw \
#        --self-signed "<本机IP或域名>" --host 0.0.0.0 --port 8787
#
# 参数：
#   --api <base>                 Gitea API 基址（含子路径，如 https://host/git/api/v1）**必填**
#   --repo <owner/repo>          知识库仓库 **必填**
#   --admin-user <u>             站点管理员账号（与服务端基本认证配套）
#   --admin-password-file <f>    站点管理员密码文件（0600）；与 --admin-token-file 二选一
#   --admin-token-file <f>       管理员令牌文件（0600，作用域需含 read:admin/write:admin 等）
#   --team <名>                  授权用团队名（默认 omo-kb-<repo 名>）
#   --permission read|write      团队/协作者权限（默认 write）
#   --grant team|collab          授权方式（默认 team）
#   --host <addr> --port <n>     监听地址/端口（默认 0.0.0.0:8787）
#   --self-signed <SAN>          自签证书的 SAN（IP 或域名）；与 --tls-cert/--tls-key 二选一
#   --tls-cert <f> --tls-key <f> 使用已有证书（key 须 0600）
#   --dir <路径>                 私有域（默认 ~/.omo-kb）
#   --version <v>                服务文件版本（默认取本机包内脚本；否则按此版本从 jsdelivr 拉取）
#   --system                     装 systemd **系统**单元（需 root），默认装用户单元
#   --no-start                   只布局不启动（探针/离线准备用）
#   --uninstall                  停止服务并卸载（私有域保留，除非 --purge）
#   --purge                      与 --uninstall 同用：连私有域一起删除
set -euo pipefail

REPO_SLUG="lomehong/oh-my-ops"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR="${OMO_KB_DIR:-$HOME/.omo-kb}"
API="" REPO="" ADMIN_USER="" ADMIN_PW_FILE="" ADMIN_TOKEN_FILE=""
TEAM="" PERMISSION="write" GRANT="team" HOST="0.0.0.0" PORT="8787"
SELF_SIGNED="" TLS_CERT="" TLS_KEY="" VERSION="" USE_SYSTEM=false NO_START=false
UNINSTALL=false PURGE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) API="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --admin-user) ADMIN_USER="$2"; shift 2 ;;
    --admin-password-file) ADMIN_PW_FILE="$2"; shift 2 ;;
    --admin-token-file) ADMIN_TOKEN_FILE="$2"; shift 2 ;;
    --team) TEAM="$2"; shift 2 ;;
    --permission) PERMISSION="$2"; shift 2 ;;
    --grant) GRANT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --self-signed) SELF_SIGNED="$2"; shift 2 ;;
    --tls-cert) TLS_CERT="$2"; shift 2 ;;
    --tls-key) TLS_KEY="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --system) USE_SYSTEM=true; shift ;;
    --no-start) NO_START=true; shift ;;
    --uninstall) UNINSTALL=true; shift ;;
    --purge) PURGE=true; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）"; exit 2 ;;
  esac
done

SERVICE_DIR="$DIR/service"
UNIT_NAME="omo-kb.service"
LAUNCHER="$HOME/.local/bin/omo-kb"
BINDIR="$HOME/.local/bin"
if [ "$USE_SYSTEM" = true ]; then UNIT_PATH="/etc/systemd/system/$UNIT_NAME"; else UNIT_PATH="$HOME/.config/systemd/user/$UNIT_NAME"; fi
systemctl_cmd() { if [ "$USE_SYSTEM" = true ]; then systemctl "$@"; else systemctl --user "$@"; fi; }

ok()   { echo "  ✓ $1"; }
info() { echo "    $1"; }
die()  { echo "✗ $1" >&2; exit 1; }

# ── 守卫：启动器会把 HOME 重定向到 <私有域>/home；在那个环境里跑安装器会错位（真机踩过）
case "${HOME:-}" in
  */".omo/home") die "检测到 HOME 已被启动器重定向（$HOME）——请在真实家目录下运行：HOME=/home/<用户> bash $0 …" ;;
esac

# ── 卸载路径
if [ "$UNINSTALL" = true ]; then
  echo "═══ 卸载 omo-kb 服务 ═══"
  if systemctl_cmd list-unit-files "$UNIT_NAME" >/dev/null 2>&1; then
    systemctl_cmd disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
    [ -w "$UNIT_PATH" ] || [ -w "$(dirname "$UNIT_PATH")" ] && rm -f "$UNIT_PATH" || true
    systemctl_cmd daemon-reload >/dev/null 2>&1 || true
    ok "已停止并移除单元 $UNIT_PATH"
  fi
  pkill -f "$SERVICE_DIR/ops-kb-enroll-server.mjs" 2>/dev/null && ok "已停止残留进程" || true
  rm -f "$LAUNCHER"; ok "已移除启动器 $LAUNCHER"
  if [ "$PURGE" = true ]; then rm -rf "$DIR"; ok "已删除私有域 $DIR（含登记表与审计）"; else info "私有域保留：$DIR（登记表/审计/证书仍在；--purge 可一并删除）"; fi
  exit 0
fi

# ── 必填校验
[ -n "$API" ] || die "缺少 --api"
[ -n "$REPO" ] || die "缺少 --repo"
if [ -z "$ADMIN_TOKEN_FILE" ] && { [ -z "$ADMIN_USER" ] || [ -z "$ADMIN_PW_FILE" ]; }; then
  die "缺少管理员凭据：--admin-token-file <0600> 或 --admin-user + --admin-password-file <0600>"
fi
for f in "$ADMIN_TOKEN_FILE" "$ADMIN_PW_FILE" "$TLS_KEY"; do
  if [ -n "$f" ]; then
    [ -f "$f" ] || die "文件不存在：$f"
    perm="$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f" 2>/dev/null || echo unknown)"
    case "$perm" in 600|400) ;; *) die "权限过宽（应 0600）：$f 当前 $perm" ;; esac
  fi
done

echo "═══ omo 知识库自注册服务（kb-enroll）安装 ═══"
info "私有域：$DIR"
info "API：$API"
info "仓库：$REPO"
echo

# ── 1) bun（共用自举）
. "$SELF_DIR/lib/bun.sh"
ensure_bun || exit 1

# ── 2) 布局服务文件（本机包内优先，否则按版本拉取；jsdelivr → fastly → raw）
mkdir -p "$SERVICE_DIR/lib" "$DIR/tls" "$DIR/logs" "$BINDIR"
FILE_BASE=""
for cand in "$SELF_DIR" "$SELF_DIR/.." "$SELF_DIR/../scripts"; do
  [ -f "$cand/ops-kb-enroll-server.mjs" ] && { FILE_BASE="$cand"; break; }
done
if [ -n "$FILE_BASE" ]; then
  cp "$FILE_BASE/ops-kb-enroll-server.mjs" "$FILE_BASE/ops-kb-provision.mjs" "$SERVICE_DIR/"
  cp "$FILE_BASE/lib/kb-gitea.mjs" "$FILE_BASE/lib/kb-registry.mjs" "$FILE_BASE/lib/kb-audit.mjs" "$SERVICE_DIR/lib/"
  ok "服务文件取自本机包（$FILE_BASE）"
else
  [ -n "$VERSION" ] || die "本机包内无服务文件：请用 --version <v> 指定版本（如 --version v0.11.0），或从发布包内运行本脚本"
  fetched=false
  for src in "https://cdn.jsdelivr.net/gh/$REPO_SLUG@$VERSION" "https://fastly.jsdelivr.net/gh/$REPO_SLUG@$VERSION" "https://raw.githubusercontent.com/$REPO_SLUG/$VERSION"; do
    if curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/ops-kb-enroll-server.mjs" -o "$SERVICE_DIR/ops-kb-enroll-server.mjs" \
       && curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/ops-kb-provision.mjs" -o "$SERVICE_DIR/ops-kb-provision.mjs" \
       && curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/lib/kb-gitea.mjs" -o "$SERVICE_DIR/lib/kb-gitea.mjs" \
       && curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/lib/kb-registry.mjs" -o "$SERVICE_DIR/lib/kb-registry.mjs" \
       && curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/lib/kb-audit.mjs" -o "$SERVICE_DIR/lib/kb-audit.mjs"; then
      ok "服务文件已下载（$src）"; fetched=true; break
    fi
  done
  [ "$fetched" = true ] || die "服务文件下载失败（三个源均不可达）；可在发布包内运行本脚本，或指定 --version"
fi

# 管理员凭据落到私有域（0600；避免引外部路径带来的权限/搬迁问题）
if [ -n "$ADMIN_TOKEN_FILE" ]; then
  install -m 600 "$ADMIN_TOKEN_FILE" "$DIR/admin.token"; ADMIN_MODE="token"
else
  install -m 600 "$ADMIN_PW_FILE" "$DIR/admin.pw"; ADMIN_MODE="password"
fi
ok "管理员凭据已落盘（$DIR/admin.$([ "$ADMIN_MODE" = token ] && echo token || echo pw)，0600）"

# ── 3) TLS：用已有证书，或自签（SAN 必填）
if [ -n "$TLS_CERT" ] && [ -n "$TLS_KEY" ]; then
  install -m 644 "$TLS_CERT" "$DIR/tls/cert.pem"; install -m 600 "$TLS_KEY" "$DIR/tls/key.pem"
  ok "使用已有证书：$TLS_CERT"
else
  [ -n "$SELF_SIGNED" ] || die "缺少 TLS：给 --self-signed <IP或域名>，或用 --tls-cert/--tls-key 提供证书"
  command -v openssl >/dev/null 2>&1 || die "无 openssl，无法自签：请提供 --tls-cert/--tls-key"
  san="IP:$SELF_SIGNED"
  case "$SELF_SIGNED" in *[a-zA-Z]*) san="DNS:$SELF_SIGNED" ;; esac
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$DIR/tls/key.pem" -out "$DIR/tls/cert.pem" \
    -subj "/CN=$SELF_SIGNED" -addext "subjectAltName=$san" >/dev/null 2>&1
  chmod 600 "$DIR/tls/key.pem"; chmod 644 "$DIR/tls/cert.pem"
  ok "已生成自签证书（SAN=$san，有效期 10 年）"
fi
FP="$(openssl x509 -in "$DIR/tls/cert.pem" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' || echo '')"

# ── 4) 配置（0600；不含秘密本体）
[ -n "$TEAM" ] || TEAM="omo-kb-$(printf '%s' "$REPO" | awk -F/ '{print $NF}')"
cat > "$DIR/config.env" <<EOF
# omo-kb 服务配置（由安装器生成；0600）。改后 omo-kb restart 生效。
OMO_KB_API=$API
OMO_KB_REPO=$REPO
OMO_KB_TEAM=$TEAM
OMO_KB_PERMISSION=$PERMISSION
OMO_KB_GRANT=$GRANT
OMO_KB_HOST=$HOST
OMO_KB_PORT=$PORT
OMO_KB_ADMIN_MODE=$ADMIN_MODE
OMO_KB_ADMIN_USER=$ADMIN_USER
OMO_KB_TLS_CERT=$DIR/tls/cert.pem
OMO_KB_TLS_KEY=$DIR/tls/key.pem
OMO_KB_REGISTRY=$DIR/registry.json
OMO_KB_AUDIT=$DIR/audit.jsonl
OMO_KB_LOG=$DIR/logs/service.log
EOF
chmod 600 "$DIR/config.env"; ok "配置已写入 $DIR/config.env（0600）"

# ── 5) 启动前自证：管理员凭据必须能调 /admin/*
if [ "$ADMIN_MODE" = token ]; then CRED_ARGS=(--header "Authorization: token $(cat "$DIR/admin.token")")
else CRED_ARGS=(--user "$ADMIN_USER:$(cat "$DIR/admin.pw")"); fi
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "${CRED_ARGS[@]}" "$API/admin/users?limit=1" || echo 000)"
[ "$code" = "200" ] || die "管理员凭据自证失败（GET /admin/users → HTTP $code）：请确认账号为站点管理员且凭据/作用域正确"
ok "管理员凭据自证 ✓ 200"

# ── 6) 启动器（唯一对外痕迹）
# 原子替换（同 install.sh：避免覆写正在执行的脚本）
LAUNCHER_TMP="$LAUNCHER.tmp.$$"
cat > "$LAUNCHER_TMP" <<'LAUNCHER_EOF'
#!/usr/bin/env bash
# omo-kb —— 知识库自注册服务的运维入口（由安装器生成）
set -euo pipefail
DIR="$HOME/.omo-kb"
[ -f "$DIR/config.env" ] && . "$DIR/config.env"
UNIT="omo-kb.service"
UNIT_PATH="$HOME/.config/systemd/user/$UNIT"
[ -f /etc/systemd/system/$UNIT ] && UNIT_PATH="/etc/systemd/system/$UNIT"
SYS=(); [ "$UNIT_PATH" = "/etc/systemd/system/$UNIT" ] && SYS=(sudo)
have_systemd() { command -v systemctl >/dev/null 2>&1; }
svc() { if [ "$UNIT_PATH" = "/etc/systemd/system/$UNIT" ]; then sudo systemctl "$@"; else systemctl --user "$@"; fi; }
cmd="${1:-status}"; shift || true
case "$cmd" in
  version) echo "omo-kb service launcher (dir=$DIR)" ;;
  status)
    echo "═══ omo-kb 服务 ═══"
    echo "  私有域：$DIR"
    echo "  监听：https://$OMO_KB_HOST:$OMO_KB_PORT（仓库 $OMO_KB_REPO）"
    if have_systemd && systemctl --user list-unit-files "$UNIT" >/dev/null 2>&1; then svc status --no-pager -l | head -12 || true; fi
    pid="$(cat "$DIR/service.pid" 2>/dev/null || true)"
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
      pid="$(command -v pgrep >/dev/null 2>&1 && pgrep -f "$DIR/service/ops-kb-enroll-server.mjs" | head -1 || true)"
      [ -n "$pid" ] && echo "$pid" > "$DIR/service.pid"
    fi
    [ -n "$pid" ] && echo "  进程：✓ PID $pid" || echo "  进程：✗ 未运行（omo-kb start 启动）"
    echo -n "  健康："; curl -sk --max-time 8 "https://127.0.0.1:$OMO_KB_PORT/healthz" || echo "（不可达）"; echo
    ;;
  health) curl -sk --max-time 8 "https://127.0.0.1:$OMO_KB_PORT/healthz"; echo ;;
  start)
    if have_systemd && [ -f "$UNIT_PATH" ]; then svc start "$UNIT" && echo "已启动（systemd）"; exit 0; fi
    mkdir -p "$DIR/logs"; cd "$DIR/service"
    # 三个标准流全部脱离调用方（真机踩到：服务继承调用方 stdout ⇒ 在管道里挂住）
    ADMIN_ARGS=(); if [ "$OMO_KB_ADMIN_MODE" = token ]; then ADMIN_ARGS=(--admin-token-file "$DIR/admin.token"); else ADMIN_ARGS=(--admin-user "$OMO_KB_ADMIN_USER" --admin-password-file "$DIR/admin.pw"); fi
    nohup bun ops-kb-enroll-server.mjs --api "$OMO_KB_API" --repo "$OMO_KB_REPO" --team "$OMO_KB_TEAM" \
      --permission "$OMO_KB_PERMISSION" --grant "$OMO_KB_GRANT" "${ADMIN_ARGS[@]}" \
      --registry "$OMO_KB_REGISTRY" --audit "$OMO_KB_AUDIT" --host "$OMO_KB_HOST" --port "$OMO_KB_PORT" \
      --tls-cert "$OMO_KB_TLS_CERT" --tls-key "$OMO_KB_TLS_KEY" >>"$OMO_KB_LOG" 2>&1 </dev/null &
    echo $! > "$DIR/service.pid"
    disown 2>/dev/null || true
    mypid="$(cat "$DIR/service.pid" 2>/dev/null || true)"
    for _ in $(seq 1 24); do
      # 必须「我们拉起的进程活着」且健康检查通过——否则可能是端口被别的实例占用（真机踩到：误判为启动成功）
      if kill -0 "$mypid" 2>/dev/null && curl -sk --max-time 2 "https://127.0.0.1:$OMO_KB_PORT/healthz" 2>/dev/null | grep -q '"ok":true'; then
        echo "已启动（nohup，PID $mypid，日志 $OMO_KB_LOG）"; exit 0
      fi
      if ! kill -0 "$mypid" 2>/dev/null; then
        echo "⚠ 拉起的进程已退出（PID $mypid）——常见：端口 $OMO_KB_PORT 被占用 / 证书 / 管理员凭据。最后几行日志："
        tail -3 "$OMO_KB_LOG" 2>/dev/null | sed 's/^/    /'
        exit 1
      fi
      sleep 0.5
    done
    echo "⚠ 12s 内未通过健康检查（PID $mypid 仍活着）：看 omo-kb logs"
    exit 0 ;;
  stop)
    if have_systemd && [ -f "$UNIT_PATH" ]; then svc stop "$UNIT" && echo "已停止（systemd）"; exit 0; fi
    stopped=false
    pid="$(cat "$DIR/service.pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null && stopped=true; fi
    if [ "$stopped" = false ] && command -v pgrep >/dev/null 2>&1; then
      p="$(pgrep -f "$DIR/service/ops-kb-enroll-server.mjs" | head -1 || true)"
      [ -n "$p" ] && kill "$p" 2>/dev/null && { pid="$p"; stopped=true; }
    fi
    rm -f "$DIR/service.pid"
    if [ "$stopped" = true ]; then
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done
      kill -0 "$pid" 2>/dev/null && { kill -9 "$pid" 2>/dev/null || true; echo "已强制停止 PID $pid"; } || echo "已停止"
    else
      echo "（未在运行）"
    fi ;;
  restart) "$0" stop || true; "$0" start ;;
  logs) tail -n "${1:-100}" "$OMO_KB_LOG" ;;
  cert) echo "证书指纹（SHA256，实例侧可用 --allow-insecure-tls 或加入信任库）："; openssl x509 -in "$OMO_KB_TLS_CERT" -noout -fingerprint -sha256 -dates ;;
  code)   bun "$DIR/service/ops-kb-provision.mjs" code --registry "$OMO_KB_REGISTRY" "$@" ;;
  list)   bun "$DIR/service/ops-kb-provision.mjs" list --registry "$OMO_KB_REGISTRY" "$@" ;;
  __provision) shift 0; bun "$DIR/service/ops-kb-provision.mjs" "$@" ;;
  create|rotate|revoke)
    AUTH=$( [ "$OMO_KB_ADMIN_MODE" = token ] && echo "--admin-token-file $DIR/admin.token" || echo "--admin-user $OMO_KB_ADMIN_USER --admin-password-file $DIR/admin.pw" )
    # shellcheck disable=SC2086
    bun "$DIR/service/ops-kb-provision.mjs" "$cmd" --api "$OMO_KB_API" --repo "$OMO_KB_REPO" --team "$OMO_KB_TEAM" --permission "$OMO_KB_PERMISSION" --grant "$OMO_KB_GRANT" --registry "$OMO_KB_REGISTRY" $AUTH "$@" ;;
  enroll-hint)
    fp="$(openssl x509 -in "$OMO_KB_TLS_CERT" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' || true)"
    echo "实例侧接入（每台一条命令）："
    echo "  # Owner：签一次性码（默认 30 分钟、单次消费；--device 可绑定设备名）"
    echo "  omo-kb code --op enroll --device <设备名>"
    echo "  # 实例：兑换并自证同步"
    echo "  omo kb enroll --server https://<本机可达地址>:$OMO_KB_PORT --code-file <0600 码文件>"
    [ -n "$fp" ] && echo "  （自签证书指纹：$fp；不可信时实例侧加 --allow-insecure-tls）" ;;
  *) echo "用法：omo-kb <status|health|start|stop|restart|logs|cert|enroll-hint|code|list|create|rotate|revoke>"; exit 2 ;;
esac
LAUNCHER_EOF
chmod 755 "$LAUNCHER_TMP"; mv -f "$LAUNCHER_TMP" "$LAUNCHER"; ok "启动器：$LAUNCHER"

# ── 7) systemd 单元（或说明手动启动）
if command -v systemctl >/dev/null 2>&1 && { [ "$USE_SYSTEM" = true ] || systemctl --user show-environment >/dev/null 2>&1; }; then
  {
    echo "[Unit]"
    echo "Description=omo 知识库自注册服务（kb-enroll）"
    echo "After=network-online.target"
    echo
    echo "[Service]"
    echo "Type=simple"
    echo "EnvironmentFile=$DIR/config.env"
    echo "WorkingDirectory=$SERVICE_DIR"
    echo "ExecStart=__BUN__ $SERVICE_DIR/ops-kb-enroll-server.mjs --api \${OMO_KB_API} --repo \${OMO_KB_REPO} --team \${OMO_KB_TEAM} --permission \${OMO_KB_PERMISSION} --grant \${OMO_KB_GRANT} --registry \${OMO_KB_REGISTRY} --audit \${OMO_KB_AUDIT} --host \${OMO_KB_HOST} --port \${OMO_KB_PORT} --tls-cert \${OMO_KB_TLS_CERT} --tls-key \${OMO_KB_TLS_KEY}__ADMIN_ARGS__"
    echo "Restart=on-failure"
    echo "RestartSec=3"
    echo
    echo "[Install]"
    echo "WantedBy=$([ "$USE_SYSTEM" = true ] && echo multi-user.target || echo default.target)"
  } > "$UNIT_PATH"
  sed -i "s|__BUN__|$(command -v bun)|; s|__ADMIN_ARGS__|$( [ "$ADMIN_MODE" = token ] && echo " --admin-token-file $DIR/admin.token" || echo " --admin-user $ADMIN_USER --admin-password-file $DIR/admin.pw" )|" "$UNIT_PATH"
  if [ "$USE_SYSTEM" = true ]; then
    [ "$(id -u)" = "0" ] || die "--system 需要 root（当前非 root）"
    systemctl daemon-reload; systemctl enable --now "$UNIT_NAME" >/dev/null 2>&1 || true
    ok "系统单元已安装：$UNIT_PATH"
  else
    systemctl --user daemon-reload; systemctl --user enable --now "$UNIT_NAME" >/dev/null 2>&1 || true
    ok "用户单元已安装：$UNIT_PATH"
    info "（用户单元在其会话退出后可能停止；常驻建议 sudo 重跑加 --system 或 loginctl enable-linger $USER）"
  fi
else
  info "未检测到可用 systemd：跳过单元安装（可用 omo-kb start 以 nohup 方式启动）"
fi

# ── 8) 启动 + 健康自证
if [ "$NO_START" = false ]; then
  sleep 1 || true
  if curl -sk --max-time 8 "https://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 || "$LAUNCHER" start >/dev/null 2>&1; then
    for _ in $(seq 1 10); do
      if curl -sk --max-time 5 "https://127.0.0.1:$PORT/healthz" | grep -q '"ok":true'; then ok "服务健康自证 ✓ https://127.0.0.1:$PORT/healthz"; break; fi
      sleep 1
    done
  fi
  curl -sk --max-time 5 "https://127.0.0.1:$PORT/healthz" | grep -q '"ok":true' || echo "  ⚠ 健康检查未通过：看 omo-kb logs 排查（常见：端口占用/证书/管理员凭据）"
fi

if ! printf '%s' "$PATH" | tr ':' '\n' | grep -qx "$BINDIR"; then
  echo
  echo "  ⚠ $BINDIR 不在当前 PATH：本次可直接用绝对路径，新终端建议加进 shell 配置："
  echo "      echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
fi

echo
echo "═══ 完成 ═══"
echo "  启动器：$LAUNCHER（或 PATH 含 ~/.local/bin 时直接 omo-kb）"
echo "  子命令：status | health | logs | restart | cert | enroll-hint"
echo "  签码：  omo-kb code --op enroll --device <设备名>"
[ -n "$FP" ] && echo "  证书指纹（SHA256）：$FP"
echo "  实例侧：omo kb enroll --server https://<本机可达地址>:$PORT --code-file <0600 码文件>"
