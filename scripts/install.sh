#!/usr/bin/env bash
# oh-my-ops 安装脚本 v3：一键部署，品牌内置，零 sudo。
#
# 布局（全部在用户目录，可整体删除）：
#   ~/.ops-pi/
#     omp/dist/            ← 系统 omp 产物镜像（品牌补丁直接打进副本）
#     omp/node_modules     ← symlink → 系统 omp（bun 原生模块解析）
#     extension/ops-pi/    ← ops-pi 扩展（含 ops-core 实体拷贝，无外部 symlink）
#     bin/patch-omp-brand.mjs
#   ~/.local/bin/omo       ← 启动器（每次运行自检镜像是否过期，过期自动重建）
#   ~/.omp/agent/extensions/yuyi-omp-extension.js  ← Yuyi 适配器（默认 profile 自动发现）
#
# 前置：系统已装 oh-my-pi(omp)（bun 全局或 npm -g 均可，自动探测）。
# 升级：重跑本脚本即可；omp 升级后 omo 启动时自动刷新镜像并重打品牌。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPS_DIR="$HOME/.ops-pi"
BIN_DST="$HOME/.local/bin/omo"
POLICY_DST="$HOME/.ops-pi"
YUYI_DIR="$HOME/.yuyi"
YUYI_DST="$HOME/.omp/agent/extensions/yuyi-omp-extension.js"
YUYI_SRC="$REPO_ROOT/vendor/yuyi-omp-extension.js"
PATCH_SRC="$REPO_ROOT/scripts/patch-omp-brand.mjs"

DEFAULT_HUB="wss://hub.qianji.io"
DEFAULT_YUFU_URL="https://yufu.qianji.io"

# ── CLI 参数
TOKEN="" AGENT_NAME="" HUB_URL="" YUFU_URL="" UNINSTALL=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)     TOKEN="$2"; shift 2 ;;
    --name)      AGENT_NAME="$2"; shift 2 ;;
    --hub)       HUB_URL="$2"; shift 2 ;;
    --yufu-url)  YUFU_URL="$2"; shift 2 ;;
    --uninstall) UNINSTALL=true; shift ;;
    *) shift ;;
  esac
done

if [[ "$UNINSTALL" == true ]]; then
  echo "[uninstall] 移除…"
  rm -rf "$OPS_DIR" "$HOME/.omp/agent/extensions/ops-pi" "$HOME/.omp/agent/extensions/ops-pi-deps"
  rm -f "$YUYI_DST" "$BIN_DST"
  echo "[uninstall] ✓ 已移除（策略与令牌保留在 ~/.ops-pi 之外的 ~/.yuyi/）"
  exit 0
fi

# ── 定位系统 omp
SYS_OMP="$(readlink -f "$(command -v omp)")" || { echo "✗ 未找到 omp，请先安装 oh-my-pi ≥ 18.1.18"; exit 1; }
SYS_DIR="$(dirname "$SYS_OMP")/.."
SYS_DIR="$(cd "$SYS_DIR" && pwd)"
[ -f "$SYS_DIR/dist/cli.js" ] || { echo "✗ omp 产物异常：$SYS_DIR/dist/cli.js 不存在"; exit 1; }

# ── Yuyi 配置：沿用优先，绝不覆盖已发放凭据
if [ -z "$TOKEN" ] && [ -f "$YUYI_DIR/agent.json" ]; then
  TOKEN=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$YUYI_DIR/agent.json','utf8')).token||'')}catch{}" 2>/dev/null)
  [ -n "$TOKEN" ] && echo "↺ 沿用已有 Yuyi token"
fi
if [ -z "$TOKEN" ] && [ -t 0 ]; then
  echo -n "Yuyi Agent Token（可留空稍后配置）: "
  read -r TOKEN
fi
if [ -z "$AGENT_NAME" ] && [ -f "$YUYI_DIR/agent.json" ]; then
  AGENT_NAME=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$YUYI_DIR/agent.json','utf8')).name||'')}catch{}" 2>/dev/null)
  [ -n "$AGENT_NAME" ] && echo "↺ 沿用已有设备名：$AGENT_NAME"
fi
if [ -z "$AGENT_NAME" ]; then
  AGENT_NAME=$(hostname)
fi
HUB_URL="${HUB_URL:-$DEFAULT_HUB}"
YUFU_URL="${YUFU_URL:-$DEFAULT_YUFU_URL}"

echo "═══ oh-my-ops 安装 v3 ═══"
echo "  设备名：$AGENT_NAME"
echo "  系统 omp：$SYS_DIR"
echo

# ── 1) ops-pi 扩展（自包含：ops-core 实体拷贝，删解压目录不影响运行）
echo "[1/4] 部署 ops-pi 扩展…"
EXT_DST="$OPS_DIR/extension/ops-pi"
rm -rf "$EXT_DST" "$HOME/.omp/agent/extensions/ops-pi" "$HOME/.omp/agent/extensions/ops-pi-deps"
mkdir -p "$EXT_DST/tools" "$EXT_DST/node_modules/@ops-pi"
for f in "$REPO_ROOT/packages/ops-extension/src"/*.ts; do
  base=$(basename "$f"); [ "$base" = "index.ts" ] && continue; cp "$f" "$EXT_DST/"
done
for f in "$REPO_ROOT/packages/ops-extension/src/tools/"*.ts; do cp "$f" "$EXT_DST/tools/"; done
cp -r "$REPO_ROOT/packages/ops-core/src" "$EXT_DST/node_modules/@ops-pi/core"
echo 'export { default } from "./extension.ts";' > "$EXT_DST/index.ts"
echo '{"name":"ops-pi","private":true,"type":"module","dependencies":{"@ops-pi/core":"*"}}' > "$EXT_DST/package.json"
echo "  ✓ $EXT_DST（自包含，含 ops-core）"
# ── 2) 品牌化 omp 镜像（用户副本，免 sudo）
echo "[2/4] 构建 OpsPi 品牌 omp 镜像…"
mkdir -p "$OPS_DIR/bin"
cp "$REPO_ROOT/scripts/build-mirror.sh" "$OPS_DIR/bin/build-mirror.sh"
cp "$PATCH_SRC" "$OPS_DIR/bin/patch-omp-brand.mjs"
bash "$OPS_DIR/bin/build-mirror.sh" "$OPS_DIR/omp" "$SYS_DIR"

# ── 3) omo 启动器（自愈：系统 omp 升级后自动刷新镜像并重打品牌）
echo "[3/4] 创建 omo 启动器…"
mkdir -p "$(dirname "$BIN_DST")"
cat > "$BIN_DST" <<OMOEOF
#!/usr/bin/env bash
# omo — OpsPi 运维智能体 CLI（品牌内置镜像 + profile 隔离 + 自愈升级）
set -euo pipefail
[ -f "\$HOME/.yuyi/env" ] && source "\$HOME/.yuyi/env"
export OPS_PI_SANDBOX="\${OPS_PI_SANDBOX:-0}"
export OMO_APP_NAME="OpsPi"
export OMO_TIPS=\$'/ops-inspect <主机> 执行标准巡检（只读）\n/ops-health 十秒健康快照；/ops-status 查看策略/沙箱/凭据状态\n只读 ops 工具自动放行；变更类需 Owner 预授权（policy.json）\n无人值守下生产目标变更一律拒绝——这是设计，不是故障\nomo serve 常驻后，cron/webhook 可直接触发巡检与诊断\nPress ctrl+r to search your prompt history\nCtrl+D exits but keeps your draft saved'
MIR="\$HOME/.ops-pi/omp"
EXT="\$HOME/.ops-pi/extension/ops-pi"
YUYI="\$HOME/.omp/agent/extensions/yuyi-omp-extension.js"
SYS_DIR="\$(cd "\$(dirname "\$(readlink -f "\$(command -v omp)")")/.." && pwd)"
# 自愈：系统 omp 比镜像新 → 重建镜像 + 重打品牌
if [ -f "\$SYS_DIR/dist/cli.js" ] && { [ ! -f "\$MIR/dist/cli.js" ] || [ "\$SYS_DIR/dist/cli.js" -nt "\$MIR/dist/cli.js" ]; }; then
  bash "\$HOME/.ops-pi/bin/build-mirror.sh" "\$MIR" "\$SYS_DIR" >/dev/null 2>&1 || \
    echo "[omo] ⚠ 镜像刷新失败，沿用现有镜像"
fi
EXT_ARGS=()
[ -d "\$EXT" ] && EXT_ARGS+=(--extension "\$EXT")
[ -f "\$YUYI" ] && EXT_ARGS+=(--extension "\$YUYI")
case "\${1:-}" in
  serve)
    shift; FOREGROUND=false; EXTRA_ARGS=()
    for arg in "\$@"; do case "\$arg" in --foreground) FOREGROUND=true ;; *) EXTRA_ARGS+=("\$arg") ;; esac; done
    if [ "\$FOREGROUND" = true ]; then
      exec "\$MIR/dist/cli.js" --profile ops "\${EXT_ARGS[@]}" --mode rpc "\${EXTRA_ARGS[@]}"
    else
      nohup "\$MIR/dist/cli.js" --profile ops "\${EXT_ARGS[@]}" --mode rpc "\${EXTRA_ARGS[@]}" > /tmp/omo-serve.log 2>&1 & echo \$! > /tmp/omo-serve.pid
      echo "[omo] ✓ 服务已启动 PID \$(cat /tmp/omo-serve.pid)"
    fi ;;
  status)
    echo "═══ OpsPi (oh-my-ops) ═══"
    [ -d "\$EXT" ] && echo "  扩展：✓" || echo "  扩展：✗（重跑安装脚本）"
    [ -f "\$MIR/dist/cli.js" ] && echo "  镜像：✓" || echo "  镜像：✗（重跑安装脚本）"
    [ -f /tmp/omo-serve.pid ] && kill -0 "\$(cat /tmp/omo-serve.pid)" 2>/dev/null && echo "  服务：✓ PID \$(cat /tmp/omo-serve.pid)" || echo "  服务：✗"
    [ -f "\$HOME/.ops-pi/policy.json" ] && echo "  策略：✓" || echo "  策略：⚠ 未配置（变更全拒）"
    grep -q '"token": "[^"]' "\$HOME/.yuyi/agent.json" 2>/dev/null && echo "  Yuyi：✓ 已配置" || echo "  Yuyi：✗ 缺 token（bash scripts/install.sh --token <token> 补上）"
    [ "\${OPS_PI_SANDBOX:-0}" = "1" ] && echo "  沙箱：✓" || echo "  沙箱：⚠" ;;
  install)
    [ -f "\$PWD/scripts/install.sh" ] && bash "\$PWD/scripts/install.sh" || { echo "✗ 请在解压目录内运行"; exit 1; } ;;
  help|--help|-h)
    echo "omo — OpsPi 运维智能体 CLI"
    echo "  omo                      交互式"
    echo "  omo -p '巡检 web-01'     非交互执行"
    echo "  omo serve                后台服务（cron/webhook 入口）"
    echo "  omo status               状态"
    echo "  其他参数透传 omp" ;;
  *)
    exec "\$MIR/dist/cli.js" --profile ops "\${EXT_ARGS[@]}" "\$@" ;;
esac
OMOEOF
chmod +x "$BIN_DST"
echo "  ✓ $BIN_DST"

# ── 4) Yuyi 适配器 + 配置 + 策略
echo "[4/4] Yuyi 适配器与配置…"
if [ -f "$YUYI_SRC" ]; then
  mkdir -p "$(dirname "$YUYI_DST")"; cp "$YUYI_SRC" "$YUYI_DST"; echo "  ✓ Yuyi 适配器已部署"
else
  echo "  ⚠ vendor/yuyi-omp-extension.js 不存在——跨 Agent 通讯不可用"
fi
mkdir -p "$YUYI_DIR" "$POLICY_DST"
# 仅在有 token 时写 agent.json——绝不覆盖已发放凭据
if [ -n "$TOKEN" ]; then
  echo "{\"token\": \"$TOKEN\", \"name\": \"$AGENT_NAME\"}" > "$YUYI_DIR/agent.json"
  chmod 600 "$YUYI_DIR/agent.json"
  echo "  ✓ ~/.yuyi/agent.json（设备 $AGENT_NAME）"
elif [ ! -f "$YUYI_DIR/agent.json" ]; then
  echo "{\"token\": \"\", \"name\": \"$AGENT_NAME\"}" > "$YUYI_DIR/agent.json"
  chmod 600 "$YUYI_DIR/agent.json"
  echo "  ⚠ 未提供 token——跨 Agent 通讯暂不可用（--token 补配）"
else
  echo "  ↺ 保留已有 ~/.yuyi/agent.json"
fi
cat > "$YUYI_DIR/env" <<ENVEOF
YUYI_HUB=$HUB_URL
YUYI_YUFU_URL=$YUFU_URL
ENVEOF
chmod 600 "$YUYI_DIR/env"
if [ ! -f "$POLICY_DST/policy.json" ]; then
  echo '{"targets":[]}' > "$POLICY_DST/policy.json"
  echo "  ✓ 空策略（变更全拒）"
else
  echo "  ↺ 保留已有策略"
fi

echo
echo "═══ ✓ 安装完成 ═══"
echo "  omo                      → 交互式（OpsPi 品牌，无需任何补丁）"
echo "  omo -p '巡检本机'        → 非交互巡检"
echo "  omo serve                → 后台服务"
echo "  omo status               → 状态"
echo "  系统 omp 不受影响；omp 升级后 omo 自动刷新镜像"
