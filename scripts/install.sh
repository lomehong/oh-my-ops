#!/usr/bin/env bash
# oh-my-ops 安装脚本：部署 ops-pi 扩展 + Yuyi 适配器 + 创建 omo CLI + 配置 Yuyi 通讯
# 用法：
#   bash scripts/install.sh                              交互式安装（提示输入 token）
#   bash scripts/install.sh --token <token>              非交互安装（token 由参数传入）
#   bash scripts/install.sh --name <设备名>               指定设备名
#   bash scripts/install.sh --hub <ws://…>               指定 Hub 地址
#   bash scripts/install.sh --yufu-url <https://…>       指定 Yufu URL
#   bash scripts/install.sh --uninstall                  卸载
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_SRC="$REPO_ROOT/packages/ops-extension/src"
CORE_SRC="$REPO_ROOT/packages/ops-core/src"
EXT_DST="$HOME/.omp/agent/extensions/ops-pi"
YUYI_DST="$HOME/.omp/agent/extensions/yuyi-omp-extension.js"
YUYI_SRC="$REPO_ROOT/vendor/yuyi-omp-extension.js"
BIN_DST="$HOME/.local/bin/omo"
POLICY_DST="$HOME/.ops-pi"
YUYI_DIR="$HOME/.yuyi"

# ── 默认值（可被 CLI 参数覆盖）
DEFAULT_HUB="wss://hub.qianji.io"
DEFAULT_YUFU_URL="https://yufu.qianji.io"

# ── 解析参数
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
  rm -rf "$EXT_DST"
  rm -f "$YUYI_DST" "$BIN_DST"
  echo "[uninstall] ✓ 已移除（策略与令牌保留在 ~/.ops-pi/ 和 ~/.yuyi/）"
  exit 0
fi
if [ -z "$TOKEN" ] && [ -f "$YUYI_DIR/agent.json" ]; then
  TOKEN=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$YUYI_DIR/agent.json','utf8')).token||'')}catch{}" 2>/dev/null)
  [ -n "$TOKEN" ] && echo "↺ 沿用已有 Yuyi token（如需更换，传 --token <新token>）"
fi
if [ -z "$TOKEN" ] && [ -t 0 ]; then
  echo -n "Yuyi Agent Token（必填，从御符获取）: "
  read -r TOKEN
fi
if [ -z "$AGENT_NAME" ]; then
  AGENT_NAME=$(hostname)
  echo "设备名（缺省 $AGENT_NAME）: "
  read -r INPUT_NAME
  [ -n "$INPUT_NAME" ] && AGENT_NAME="$INPUT_NAME"
fi
HUB_URL="${HUB_URL:-$DEFAULT_HUB}"
YUFU_URL="${YUFU_URL:-$DEFAULT_YUFU_URL}"

echo "═══ oh-my-ops 安装 ═══"
echo "  设备名：$AGENT_NAME"
echo "  Hub：$HUB_URL"
echo "  Yufu：$YUFU_URL"
echo
# ── 1) 部署 ops-pi 扩展
echo "[1/4] 部署 ops-pi 扩展…"
rm -rf "$EXT_DST" "$HOME/.omp/agent/extensions/ops-pi-deps"
mkdir -p "$EXT_DST/tools"
for f in "$EXT_SRC"/*.ts; do
  base=$(basename "$f"); [ "$base" = "index.ts" ] && continue; cp "$f" "$EXT_DST/"
done
for f in "$EXT_SRC/tools/"*.ts; do cp "$f" "$EXT_DST/tools/"; done
echo 'export { default } from "./extension.ts";' > "$EXT_DST/index.ts"
mkdir -p "$EXT_DST/node_modules/@ops-pi"
ln -sfn "$CORE_SRC" "$EXT_DST/node_modules/@ops-pi/core"
echo '{"name":"ops-pi","private":true,"type":"module","dependencies":{"@ops-pi/core":"*"}}' > "$EXT_DST/package.json"
echo "  ✓ $(find "$EXT_DST" -name '*.ts' | wc -l | tr -d ' ') 个 .ts 文件"

# ── 2) 部署 Yuyi 适配器
echo "[2/4] 部署 Yuyi 适配器…"
if [ -f "$YUYI_SRC" ]; then
  cp "$YUYI_SRC" "$YUYI_DST"
  echo "  ✓ Yuyi 适配器已部署"
else
  echo "  ⚠ vendor/yuyi-omp-extension.js 不存在——跨 Agent 通讯不可用"
fi

# ── 3) 配置 Yuyi 通讯
echo "[3/4] 配置 Yuyi 通讯…"
mkdir -p "$YUYI_DIR"

# agent.json（token + 设备名）
echo "{\"token\": \"$TOKEN\", \"name\": \"$AGENT_NAME\"}" > "$YUYI_DIR/agent.json"
chmod 600 "$YUYI_DIR/agent.json"
echo "  ✓ ~/.yuyi/agent.json（token + 设备名 $AGENT_NAME）"

# env 文件（Hub + Yufu URL）
cat > "$YUYI_DIR/env" <<ENVEOF
YUYI_HUB=$HUB_URL
YUYI_YUFU_URL=$YUFU_URL
ENVEOF
chmod 600 "$YUYI_DIR/env"
echo "  ✓ ~/.yuyi/env（Hub + Yufu URL）"

# ── 4) 创建 omo CLI + 策略目录
echo "[4/4] 创建 omo CLI + 策略…"
mkdir -p "$(dirname "$BIN_DST")" "$POLICY_DST"
cat > "$BIN_DST" <<'OMOEOF'
#!/usr/bin/env bash
# omo — oh-my-ops CLI
set -euo pipefail
# 加载 Yuyi 环境变量（Hub / Yufu URL）
[ -f "$HOME/.yuyi/env" ] && source "$HOME/.yuyi/env"
export OPS_PI_SANDBOX="${OPS_PI_SANDBOX:-0}"
export OMO_APP_NAME="OpsPi"
export OMO_TIPS=$'/ops-inspect <主机> 执行标准巡检（只读）\n/ops-health 十秒健康快照；/ops-status 查看策略/沙箱/凭据状态\n只读 ops 工具自动放行；变更类需 Owner 预授权（policy.json）\n无人值守下生产目标变更一律拒绝——这是设计，不是故障\nomo serve 常驻后，cron/webhook 可直接触发巡检与诊断\nPress ctrl+r to search your prompt history\nCtrl+D exits but keeps your draft saved'
case "${1:-}" in
  serve)
    shift; FOREGROUND=false; EXTRA_ARGS=()
    for arg in "$@"; do case "$arg" in --foreground) FOREGROUND=true ;; *) EXTRA_ARGS+=("$arg") ;; esac; done
    if [ "$FOREGROUND" = true ]; then
      echo "[omo] 前台服务模式"; exec omp --profile ops --extension "$HOME/.omp/agent/extensions/ops-pi" --mode rpc "${EXTRA_ARGS[@]}"
    else
      echo "[omo] 后台服务…"; nohup omp --profile ops --extension "$HOME/.omp/agent/extensions/ops-pi" --mode rpc "${EXTRA_ARGS[@]}" > /tmp/omo-serve.log 2>&1 & echo $! > /tmp/omo-serve.pid
      echo "[omo] ✓ PID $(cat /tmp/omo-serve.pid)"
    fi ;;
  status)
    echo "═══ oh-my-ops ═══"
    [ -d "$HOME/.omp/agent/extensions/ops-pi" ] && echo "  扩展：✓" || echo "  扩展：✗"
    [ -f /tmp/omo-serve.pid ] && kill -0 "$(cat /tmp/omo-serve.pid)" 2>/dev/null && echo "  服务：✓ PID $(cat /tmp/omo-serve.pid)" || echo "  服务：✗"
    [ -f "$HOME/.ops-pi/policy.json" ] && echo "  策略：✓" || echo "  策略：⚠ 未配置（变更全拒）"
    grep -q '"token": "[^"]' "$HOME/.yuyi/agent.json" 2>/dev/null && echo "  Yuyi：✓ 已配置" || echo "  Yuyi：✗ 缺 token（bash scripts/install.sh --token <token> 补上）"
    [ "${OPS_PI_SANDBOX:-0}" = "1" ] && echo "  沙箱：✓" || echo "  沙箱：⚠" ;;
  install)
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    [ -f "$SCRIPT_DIR/scripts/install.sh" ] && bash "$SCRIPT_DIR/scripts/install.sh" || { echo "✗"; exit 1; } ;;
  help|--help|-h)
    echo "omo — oh-my-ops CLI"
    echo "  omo                      交互式"
    echo "  omo serve                后台服务"
    echo "  omo status               状态"
    echo "  omo install              部署"
    echo "  其他参数透传 omp" ;;
  *)
    exec omp --profile ops --extension "$HOME/.omp/agent/extensions/ops-pi" "$@" ;;
esac
OMOEOF
chmod +x "$BIN_DST"

echo "[5/5] omp 品牌补丁…"
PATCH="$(cd "$(dirname "$0")" && pwd)/scripts/patch-omp-brand.mjs"
if node "$PATCH" 2>/dev/null; then
  :
else
  echo "  ⚠ 无权限写入 omp 产物——手动执行一次以下命令即可："
  echo "    sudo node $PATCH"
fi
echo "  ✓ $BIN_DST"

if [ ! -f "$POLICY_DST/policy.json" ]; then
  echo '{"targets":[]}' > "$POLICY_DST/policy.json"
  echo "  ✓ 空策略（变更全拒）"
fi
[ -f "$POLICY_DST/approval-token.json" ] || echo '{"tokens":[]}' > "$POLICY_DST/approval-token.json"

echo
echo "═══ ✓ 安装完成 ═══"
echo "  omo                      → 交互式（ops-pi + Yuyi 自动加载）"
echo "  omo -p '巡检 web-01'     → 非交互巡检"
echo "  omo serve                → 后台服务"
echo "  omo status               → 状态"
echo
echo "  Yuyi 通讯：token 已配置（设备 $AGENT_NAME）"
echo "  下一步：编辑 ~/.ops-pi/policy.json 添加预授权目标"
