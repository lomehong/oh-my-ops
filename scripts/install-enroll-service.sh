#!/usr/bin/env bash
# oh-my-ops 知识库**自注册服务**（kb-enroll）一键部署安装器
#
# 形态与 omo 安装器一致：私有域（可整体删除）+ 唯一对外痕迹（~/.local/bin/omo-kb 启动器 + 一个 systemd 单元）；
# 不装系统级依赖（bun 走共享自举；TLS 默认自签，也可用你已有的证书）。
#
#   curl -fsSL https://cdn.jsdelivr.net/gh/lomehong/oh-my-ops@main/scripts/install-enroll-service.sh -o /tmp/install-omo-kb.sh
#   bash /tmp/install-omo-kb.sh --api https://<gitea>/git/api/v1 --repo <owner>/<repo> \
#        --admin-token-file /root/omo-kb.token \
#        --self-signed "<本机IP或域名>" --host 0.0.0.0 --port 8787
#
# 参数：
#   --api <base>                 Gitea API 基址（含子路径，如 https://host/git/api/v1）**必填**
#   --repo <owner/repo>          知识库仓库 **必填**
#   --admin-token-file <f>       **推荐**：管理员令牌文件（0600）。作用域需含
#                                read:admin,write:admin,write:repository,write:organization
#                                生成（在 Git 服务器上，无需交出密码）：
#                                  gitea admin user generate-access-token --username <站点管理员> \\
#                                        --name omo-kb-enroll --scopes read:admin,write:admin,write:repository,write:organization \\
#                                        --raw > /root/omo-kb.token && chmod 600 /root/omo-kb.token
#                                或 UI：站点管理员 → 用户设置 → 应用 → 生成令牌 → 勾上述 4 个作用域
#   --admin-user <u>             备选：站点管理员账号（与服务端基本认证配套）
#   --admin-password-file <f>    备选：站点管理员密码文件（0600）——不如令牌：不可限权、不可单独吊销
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
# 秘密文件权限：能力探测 + 断言（POSIX 硬拦；无法表达 0600 的文件系统降级并告警）
. "$SELF_DIR/lib/secret-perm.sh"
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

# 落盘路径取「双端可读」形态（Windows/Git Bash 下为 C:/…，而非 /tmp/…）：
# MSYS 的 argv 路径转换只发生在 bash 拉起原生程序时；bun/node **从配置文件里读到的** /tmp/… 会被原生
# Windows 解析成 <盘符>:\tmp\…（真机踩到：/ui 改配置的预检 --check 读证书 ENOENT，配置回滚）。C:/… 在
# MSYS bash（tail/rm/[ -f ]）与原生程序下都直接可用；POSIX 上 cygpath 不存在，原样返回。
native_path() { [ -n "${1:-}" ] || return 0; if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1" 2>/dev/null || printf '%s' "$1"; else printf '%s' "$1"; fi; }

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
  # 残留进程：pid 文件里的号可能是 MSYS pid（启动器写的 $!）也可能是原生 Windows pid（服务自写 --pid-file），
  # 两套命名空间互不认账 ⇒ kill 与 taskkill 都试；判「已停」以端口不再应答为准。
  # （pkill/pgrep 在 Windows Git Bash 不存在，不能依赖；详见 2026-09-26 真机复现）
  stop_residual() {
    local pid killed=false port="$PORT"
    if [ -f "$DIR/config.env" ]; then
      port="$(sed -n 's/^OMO_KB_PORT=//p' "$DIR/config.env" | head -1)"
      [ -n "$port" ] || port="$PORT"
    fi
    pid="$(cat "$DIR/service.pid" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null && killed=true || true
      if command -v taskkill >/dev/null 2>&1 && command -v tasklist >/dev/null 2>&1; then
        # 防 PID 复用误杀：仅当该 PID 的镜像名确为 bun 时才强杀
        if tasklist //FI "PID eq $pid" //FO CSV //NH 2>/dev/null | grep -qi bun; then
          taskkill //F //PID "$pid" >/dev/null 2>&1 && killed=true || true
        fi
      fi
    fi
    for _ in $(seq 1 15); do
      curl -sk --max-time 1 "https://127.0.0.1:$port/healthz" >/dev/null 2>&1 || break
      sleep 0.3
    done
    if curl -sk --max-time 1 "https://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      info "端口 $port 仍在应答（PID ${pid:-未知}）——请手动排查：netstat -ano | grep :$port"
    elif [ "$killed" = true ]; then ok "已停止残留进程（PID $pid）"
    else info "无残留进程（$port 已静默）"; fi
  }
  stop_residual
  rm -f "$LAUNCHER"; ok "已移除启动器 $LAUNCHER"
  if [ "$PURGE" = true ]; then
    rm -rf "$DIR" 2>/dev/null || true
    if [ -e "$DIR" ]; then sleep 1; rm -rf "$DIR" 2>/dev/null || true; fi
    if [ -e "$DIR" ]; then
      die "私有域删除失败（仍有进程占用目录）：$DIR —— 结束占用进程后重跑本命令"
    fi
    ok "已删除私有域 $DIR（含登记表与审计）"
  else info "私有域保留：$DIR（登记表/审计/证书仍在；--purge 可一并删除）"; fi
  exit 0
fi

# ── 必填校验
[ -n "$API" ] || die "缺少 --api"
[ -n "$REPO" ] || die "缺少 --repo"
if [ -z "$ADMIN_TOKEN_FILE" ] && { [ -z "$ADMIN_USER" ] || [ -z "$ADMIN_PW_FILE" ]; }; then
  die "缺少管理员凭据：请用 --admin-token-file <0600>（推荐；作用域见 --help）；备选 --admin-user + --admin-password-file <0600>"
fi
for f in "$ADMIN_TOKEN_FILE" "$ADMIN_PW_FILE" "$TLS_KEY"; do
  if [ -n "$f" ]; then
    [ -f "$f" ] || die "文件不存在：$f"
    check_secret_perm "$f" "凭据" "重跑本条命令" || exit 1
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
  cp "$FILE_BASE/lib/kb-gitea.mjs" "$FILE_BASE/lib/kb-registry.mjs" "$FILE_BASE/lib/kb-audit.mjs" "$FILE_BASE/lib/kb-auth.mjs" "$FILE_BASE/lib/kb-ui-config.mjs" "$FILE_BASE/lib/kb-lint.mjs" "$FILE_BASE/lib/secret-perm.mjs" "$SERVICE_DIR/lib/"
  mkdir -p "$SERVICE_DIR/ui"
  cp "$FILE_BASE/ui/index.html" "$SERVICE_DIR/ui/index.html"
  ok "服务文件取自本机包（$FILE_BASE）"
else
  [ -n "$VERSION" ] || die "本机包内无服务文件：请用 --version <v> 指定版本（如 --version v0.11.0），或从发布包内运行本脚本"
  fetched=false
  for src in "https://cdn.jsdelivr.net/gh/$REPO_SLUG@$VERSION" "https://fastly.jsdelivr.net/gh/$REPO_SLUG@$VERSION" "https://raw.githubusercontent.com/$REPO_SLUG/$VERSION"; do
    if curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/ops-kb-enroll-server.mjs" -o "$SERVICE_DIR/ops-kb-enroll-server.mjs" \
       && curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/ops-kb-provision.mjs" -o "$SERVICE_DIR/ops-kb-provision.mjs" \
       && curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/lib/kb-gitea.mjs" -o "$SERVICE_DIR/lib/kb-gitea.mjs" \
       && curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/lib/kb-registry.mjs" -o "$SERVICE_DIR/lib/kb-registry.mjs" \
       && curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/lib/kb-audit.mjs" -o "$SERVICE_DIR/lib/kb-audit.mjs" \
       && curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/lib/kb-auth.mjs" -o "$SERVICE_DIR/lib/kb-auth.mjs" \
       && curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/lib/kb-lint.mjs" -o "$SERVICE_DIR/lib/kb-lint.mjs" \
       && curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/lib/secret-perm.mjs" -o "$SERVICE_DIR/lib/secret-perm.mjs" \
       && curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/lib/kb-ui-config.mjs" -o "$SERVICE_DIR/lib/kb-ui-config.mjs" \
       && { mkdir -p "$SERVICE_DIR/ui" && curl -fsSL --retry 2 --connect-timeout 8 "$src/scripts/ui/index.html" -o "$SERVICE_DIR/ui/index.html"; }; then
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
ok "管理员凭据已落盘（$DIR/admin.$([ "$ADMIN_MODE" = token ] && echo token || echo pw)，0600）$([ "$ADMIN_MODE" = token ] && echo "（令牌模式：可限权、可单独吊销）" || "")"

# ── 3) TLS：用已有证书，或自签（SAN 必填）
if [ -n "$TLS_CERT" ] && [ -n "$TLS_KEY" ]; then
  install -m 644 "$TLS_CERT" "$DIR/tls/cert.pem"; install -m 600 "$TLS_KEY" "$DIR/tls/key.pem"
  ok "使用已有证书：$TLS_CERT"
else
    [ -n "$SELF_SIGNED" ] || die "缺少 TLS：给 --self-signed <IP或域名|auto>，或用 --tls-cert/--tls-key 提供证书"
    command -v openssl >/dev/null 2>&1 || die "无 openssl，无法自签：请提供 --tls-cert/--tls-key"
    # --self-signed auto：取本机首个 IP（真机踩到：把模板里的 <本机IP> 原样粘进来）
    if [ "$SELF_SIGNED" = "auto" ]; then
      # 取 IP 的机制必须跨平台且失败可诊断：`hostname -I` 只有 GNU 有（Windows Git Bash / macOS / BSD 都没有），
      # 叠加 `set -o pipefail` 会让赋值整体失败 ⇒ **安装器无声退出**（2026-09-26 真机复现：日志停在上一步、无 ✗ 无 die）。
      # bun 是安装器的硬依赖（步骤 1 已确保在 PATH），读网卡最稳；读不到再退 GNU hostname。
      SELF_SIGNED="$(bun -e 'import os from "node:os"; for (const l of Object.values(os.networkInterfaces()).flat()) { if (l && l.family === "IPv4" && !l.internal) { console.log(l.address); break; } }' 2>/dev/null || true)"
      if [ -z "$SELF_SIGNED" ] && command -v hostname >/dev/null 2>&1; then
        SELF_SIGNED="$((hostname -I 2>/dev/null || true) | awk '{print $1}' || true)"
      fi
      [ -n "$SELF_SIGNED" ] || die "--self-signed auto 取不到本机 IP：请显式给 IP 或域名（如 --self-signed 10.0.0.12）"
      ok "自动选定本机 IP 作为证书 SAN：$SELF_SIGNED"
    fi
    # SAN 形态校验：必须是 IP 或域名；尖括号/空格/斜杠等模板残留直接拦下
    case "$SELF_SIGNED" in
      *"<"*|*">"*|*" "*|*/*|"") die "证书 SAN 非法：'$SELF_SIGNED' —— 这里要填**实例可访问的 IP 或域名**（或直接写 --self-signed auto）" ;;
    esac
    san="IP:$SELF_SIGNED"
    case "$SELF_SIGNED" in *[a-zA-Z]*) san="DNS:$SELF_SIGNED" ;; esac
    # 用**配置文件**而非 -addext：-addext 是 OpenSSL 1.1.1+ 才有，el7 自带 1.0.2（真机踩到 ⇒ 安装静默中止）
    CFG="$DIR/logs/openssl.cnf"
    cat > "$CFG" <<EOF
[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=$SELF_SIGNED
[v3]
subjectAltName=$san
basicConstraints=CA:TRUE
EOF
    if ! openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "$DIR/tls/key.pem" -out "$DIR/tls/cert.pem" -config "$CFG" >"$DIR/logs/openssl.log" 2>&1; then
      echo "  ✗ 生成自签证书失败（openssl 输出如下）："
      sed 's/^/      /' "$DIR/logs/openssl.log" | tail -5
      die "请改用 --self-signed auto 或 --tls-cert/--tls-key 提供证书"
    fi
    rm -f "$DIR/logs/openssl.log" "$CFG"
    chmod 600 "$DIR/tls/key.pem"; chmod 644 "$DIR/tls/cert.pem"
    if ! openssl x509 -in "$DIR/tls/cert.pem" -noout -text 2>/dev/null | grep -q "Subject Alternative Name"; then
      die "自签证书缺少 SAN（实例会校验失败）：请改用 --tls-cert/--tls-key 提供证书"
    fi
    ok "已生成自签证书（SAN=$san，有效期 10 年，openssl $(openssl version | awk '{print $2}')）"
fi
FP="$(openssl x509 -in "$DIR/tls/cert.pem" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' || echo '')"

# ── 4) 配置（0600；不含秘密本体）
[ -n "$TEAM" ] || TEAM="omo-kb-$(printf '%s' "$REPO" | awk -F/ '{print $NF}')"
cat > "$DIR/config.env" <<EOF
# omo-kb 服务配置（由安装器生成；0600）。改后 omo-kb restart 生效。
# 路径值请用原生形式（C:/… 或 /home/…）；Windows 上写 MSYS 形式（/tmp/…）原生程序会解析失败。
OMO_KB_API=$API
OMO_KB_REPO=$REPO
OMO_KB_TEAM=$TEAM
OMO_KB_PERMISSION=$PERMISSION
OMO_KB_GRANT=$GRANT
OMO_KB_HOST=$HOST
OMO_KB_PORT=$PORT
OMO_KB_ADMIN_MODE=$ADMIN_MODE
OMO_KB_ADMIN_USER=$ADMIN_USER
OMO_KB_TLS_CERT=$(native_path "$DIR/tls/cert.pem")
OMO_KB_TLS_KEY=$(native_path "$DIR/tls/key.pem")
OMO_KB_REGISTRY=$(native_path "$DIR/registry.json")
OMO_KB_AUDIT=$(native_path "$DIR/audit.jsonl")
OMO_KB_LOG=$(native_path "$DIR/logs/service.log")
# 管理后台（/ui）：默认关。开启前先把本服务接入 yufu 网关（认证+TLS 由 yufu 负责），
# 服务只认网关注入的身份头（真机实测定为 X-Auth-Username（值=username）；如网关行为不同可改）。
OMO_KB_UI=off
# 知识合流期 lint 门禁（/kb/webhook）：warn=只评论；strict=违规 status=failure 阻断合并；off=关闭。
# 需先在 Gitea 配置 webhook（指向 https://<本机>:8787/kb/webhook）并在此填共享密钥后重启。
# OMO_KB_WEBHOOK_SECRET=
# OMO_KB_LINT_MODE=warn
# OMO_KB_MAIN_BRANCH=main
OMO_KB_UI_IDENTITY_HEADER=X-Auth-Username
EOF
chmod 600 "$DIR/config.env"; ok "配置已写入 $DIR/config.env（0600）"

# ── 5) 启动前自证：凭据可用性 + **作用域逐项探测**
#    探测手法：发**必然校验失败**（而非变更成功）的请求 —— 403+scope 提示 = 缺权；4xx 校验错 = 有权限。
#    这样无需产生任何真实变更即可判定 4 个必需作用域。
if [ "$ADMIN_MODE" = token ]; then CRED_ARGS=(--header "Authorization: token $(cat "$DIR/admin.token")")
else CRED_ARGS=(--user "$ADMIN_USER:$(cat "$DIR/admin.pw")"); fi
ORG="${REPO%%/*}"; REPO_NAME="${REPO##*/}"
probe() { # $1=描述 $2=期望的「有权限」判定（re） $3=curl 参数…
  local desc="$1" expect="$2"; shift 2
  local code
  curl -sS -o /tmp/omo-kb-probe.json -w '%{http_code}' --max-time 20 "${CRED_ARGS[@]}" "$@" >/tmp/omo-kb-probe.code 2>/tmp/omo-kb-probe.err || true
  code="$(cat /tmp/omo-kb-probe.code 2>/dev/null || echo 000)"; [ -n "$code" ] || code=000
  # ① 缺权：403 且响应里带 scope 提示 ⇒ 硬失败（计入 FAIL）
  if [ "$code" = "403" ] && grep -q "scope" /tmp/omo-kb-probe.json 2>/dev/null; then
    printf '  ✗ %s：缺权 —— %s\n' "$desc" "$(head -c 160 /tmp/omo-kb-probe.json | tr -d '\n')"
    FAIL_N=$((FAIL_N + 1)); return 0
  fi
  # ② API 不可达（000）：服务必然无法工作 ⇒ 硬失败并提示连通性排查
  if [ "$code" = "000" ]; then
    printf '  ✗ %s：**API 不可达**（%s）——%s\n' "$desc" "$API" "$(head -1 /tmp/omo-kb-probe.err 2>/dev/null | tr -d '\n')"
    FAIL_N=$((FAIL_N + 1)); return 0
  fi
  # ③ 有权限：命中预期校验失败码 ⇒ 通过
  if printf '%s' "$code" | grep -qE "$expect"; then printf '  ✓ %s（HTTP %s）\n' "$desc" "$code"; OK_N=$((OK_N + 1)); return 0; fi
  # ④ 其它码：未能判定（仅提示，不阻断）
  printf '  ⚠ %s：HTTP %s（未能判定，请人工确认）\n' "$desc" "$code"; WARN_N=$((WARN_N + 1)); return 0
}

echo "  作用域自检（令牌需：read:admin / write:admin / write:repository / write:organization）"
FAIL_N=0; OK_N=0; WARN_N=0
probe "read:admin（列用户）"       "200"      "$API/admin/users?limit=1"
probe "write:admin（建用户）"      "422|400"  -X POST -H 'Content-Type: application/json' -d '{}' "$API/admin/users"
probe "write:repository（协作者）" "404|422|400" -X PUT -H 'Content-Type: application/json' -d '{"permission":"read"}' "$API/repos/$REPO/collaborators/__omo_scope_probe__"
probe "write:organization（团队）" "422|400"  -X POST -H 'Content-Type: application/json' -d '{}' "$API/orgs/$ORG/teams"
rm -f /tmp/omo-kb-probe.json /tmp/omo-kb-probe.code /tmp/omo-kb-probe.err
if [ "$FAIL_N" -gt 0 ]; then
  echo
  echo "  ✗ 自检未通过（通过 $OK_N · 失败 $FAIL_N · 未判定 $WARN_N）——按上面每项的提示处理："
  echo "      · 缺权 ⇒ 重签令牌（作用域需含 read:admin,write:admin,write:repository,write:organization）"
  echo "        gitea admin user generate-access-token --username <站点管理员> --name omo-kb-enroll \\"
  echo "              --scopes read:admin,write:admin,write:repository,write:organization --raw > /root/omo-kb.token"
  echo "        （或 UI：站点管理员 → 用户设置 → 应用 → 生成令牌 → 勾上述 4 个作用域）"
  echo "      · API 不可达 ⇒ 在本机排查到 Gitea 的连通性："
  echo "        curl -sS -o /dev/null -w '%{http_code}\\n' $API/version   # 期望 200/401；Connection refused/超时说明网络或代理问题"
  exit 1
fi
if [ "$WARN_N" -gt 0 ]; then ok "作用域自检：通过 $OK_N 项，未判定 $WARN_N 项（见上，建议人工确认）";
else ok "作用域自检：4/4 通过"; fi

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
# pid 文件里可能是 MSYS pid（start 写的 $!）或原生 Windows pid（服务自写 --pid-file）：kill -0 看不到原生 pid，
# 需 tasklist 兜底（防 PID 复用误判：镜像名须为 bun）。POSIX 上 tasklist 不存在，kill -0 即可。
pid_alive() { # $1=pid
  [ -n "${1:-}" ] || return 1
  kill -0 "$1" 2>/dev/null && return 0
  command -v tasklist >/dev/null 2>&1 && tasklist //FI "PID eq $1" //FO CSV //NH 2>/dev/null | grep -qi bun && return 0
  return 1
}
cmd="${1:-status}"; shift || true
case "$cmd" in
  version) echo "omo-kb service launcher (dir=$DIR)" ;;
  status)
    echo "═══ omo-kb 服务 ═══"
    echo "  私有域：$DIR"
    echo "  监听：https://$OMO_KB_HOST:$OMO_KB_PORT（仓库 $OMO_KB_REPO）"
    if have_systemd && systemctl --user list-unit-files "$UNIT" >/dev/null 2>&1; then svc status --no-pager -l | head -12 || true; fi
    pid="$(cat "$DIR/service.pid" 2>/dev/null || true)"
    if ! pid_alive "$pid"; then
      pid="$(command -v pgrep >/dev/null 2>&1 && pgrep -f "$DIR/service/ops-kb-enroll-server.mjs" | head -1 || true)"
      if pid_alive "$pid"; then echo "$pid" > "$DIR/service.pid"; else pid=""; fi
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
    UI_ARGS=(); if [ "${OMO_KB_UI:-off}" = "on" ]; then UI_ARGS=(--ui --ui-identity-header "${OMO_KB_UI_IDENTITY_HEADER:-X-Auth-Username}"); fi
    # --config：/ui 在线改配置的写回目标；--pid-file：UI 重启接力后 stop 仍能找到新进程
    nohup bun ops-kb-enroll-server.mjs --config "$DIR/config.env" --pid-file "$DIR/service.pid" \
      --api "$OMO_KB_API" --repo "$OMO_KB_REPO" --team "$OMO_KB_TEAM" \
      --permission "$OMO_KB_PERMISSION" --grant "$OMO_KB_GRANT" "${ADMIN_ARGS[@]}" \
      --registry "$OMO_KB_REGISTRY" --audit "$OMO_KB_AUDIT" --host "$OMO_KB_HOST" --port "$OMO_KB_PORT" \
      --tls-cert "$OMO_KB_TLS_CERT" --tls-key "$OMO_KB_TLS_KEY" "${UI_ARGS[@]}" >>"$OMO_KB_LOG" 2>&1 </dev/null &
    echo $! > "$DIR/service.pid"
    disown 2>/dev/null || true
    mypid="$(cat "$DIR/service.pid" 2>/dev/null || true)"
    for _ in $(seq 1 24); do
      # 必须「我们拉起的进程活着」且健康检查通过——否则可能是端口被别的实例占用（真机踩到：误判为启动成功）
      if pid_alive "$mypid" && curl -sk --max-time 2 "https://127.0.0.1:$OMO_KB_PORT/healthz" 2>/dev/null | grep -q '"ok":true'; then
        echo "已启动（nohup，PID $mypid，日志 $OMO_KB_LOG）"; exit 0
      fi
      if ! pid_alive "$mypid"; then
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
    # pid 文件里的号可能是 MSYS pid（本启动器写的 $!）也可能是原生 Windows pid（服务自写 --pid-file），
    # 两套命名空间互不认账 ⇒ kill 与 taskkill 都试；判「已停」以端口不再应答为准（pkill/pgrep 在 Git Bash 不存在）
    pid="$(cat "$DIR/service.pid" 2>/dev/null || true)"; killed=false
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null && killed=true || true
      if command -v taskkill >/dev/null 2>&1 && command -v tasklist >/dev/null 2>&1; then
        # 防 PID 复用误杀：仅当该 PID 的镜像名确为 bun 时才强杀
        if tasklist //FI "PID eq $pid" //FO CSV //NH 2>/dev/null | grep -qi bun; then
          taskkill //F //PID "$pid" >/dev/null 2>&1 && killed=true || true
        fi
      fi
    fi
    rm -f "$DIR/service.pid"
    up=true
    for _ in $(seq 1 15); do
      curl -sk --max-time 1 "https://127.0.0.1:$OMO_KB_PORT/healthz" >/dev/null 2>&1 || { up=false; break; }
      sleep 0.3
    done
    if [ "$up" = true ]; then
      echo "⚠ 端口 $OMO_KB_PORT 仍在应答（PID ${pid:-未知}）：未能停掉进程，请手动排查 netstat -ano | grep :$OMO_KB_PORT"
      exit 1
    fi
    [ "$killed" = true ] && echo "已停止（PID $pid）" || echo "（未在运行）" ;;
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
echo "  批量接入：bash omo-kb-fleet.sh service <设备名…>（本包内；逐设备签码并给出实例侧一条命令）"
echo "  管理后台：config.env 设 OMO_KB_UI=on 并 omo-kb restart ⇒ https://<本机>:${PORT}/ui/（建议经 yufu 反代；身份头 ${OMO_KB_UI_IDENTITY_HEADER:-X-Auth-Username}）"
