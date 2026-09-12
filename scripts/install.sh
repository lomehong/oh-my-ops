#!/usr/bin/env bash
# oh-my-ops 安装脚本：部署 ops-pi 扩展到 omp 自动发现目录 + 创建 omo CLI
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_SRC="$REPO_ROOT/packages/ops-extension/src"
CORE_SRC="$REPO_ROOT/packages/ops-core/src"
EXT_DST="$HOME/.omp/agent/extensions/ops-pi"
BIN_DST="$HOME/.local/bin/omo"
POLICY_DST="$HOME/.ops-pi"

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "[uninstall] 移除 ops-pi…"
  rm -rf "$EXT_DST"
  rm -f "$BIN_DST"
  echo "[uninstall] ✓ 已移除（策略与令牌保留在 ~/.ops-pi/）"
  exit 0
fi

echo "═══ oh-my-ops 安装 ═══"

# 1) 部署扩展：扁平化所有 .ts 到 ops-pi/ 目录（omp 子目录模式扫描 index.ts）
echo "[1/3] 部署扩展…"
rm -rf "$EXT_DST"
mkdir -p "$EXT_DST/tools"

# 复制 ops-extension（排除 index.ts，后面重建）
for f in "$EXT_SRC"/*.ts; do
  base=$(basename "$f")
  [ "$base" = "index.ts" ] && continue
  cp "$f" "$EXT_DST/"
done
# 复制 tools
for f in "$EXT_SRC/tools/"*.ts; do
  cp "$f" "$EXT_DST/tools/"
done

# index.ts（omp 入口）
echo 'export { default } from "./extension.ts";' > "$EXT_DST/index.ts"

# @ops-pi/core 解析：symlink + package.json
mkdir -p "$EXT_DST/node_modules/@ops-pi"
ln -sfn "$CORE_SRC" "$EXT_DST/node_modules/@ops-pi/core"
echo '{"name":"ops-pi","private":true,"type":"module","dependencies":{"@ops-pi/core":"*"}}' > "$EXT_DST/package.json"

echo "  ✓ 部署完成（$(find "$EXT_DST" -name '*.ts' | wc -l) 个 .ts 文件）"

# 2) 创建 omo CLI
echo "[2/3] 创建 omo CLI…"
mkdir -p "$(dirname "$BIN_DST")"
cat > "$BIN_DST" <<'OMOEOF'
#!/usr/bin/env bash
# omo — oh-my-ops CLI
set -euo pipefail
export OPS_PI_SANDBOX="${OPS_PI_SANDBOX:-0}"
case "${1:-}" in
  serve)
    shift; FOREGROUND=false; EXTRA_ARGS=()
    for arg in "$@"; do case "$arg" in --foreground) FOREGROUND=true ;; *) EXTRA_ARGS+=("$arg") ;; esac; done
    if [ "$FOREGROUND" = true ]; then
      echo "[omo] 前台服务模式"; exec omp --mode rpc "${EXTRA_ARGS[@]}"
    else
      echo "[omo] 后台服务…"; nohup omp --mode rpc "${EXTRA_ARGS[@]}" > /tmp/omo-serve.log 2>&1 & echo $! > /tmp/omo-serve.pid
      echo "[omo] ✓ PID $(cat /tmp/omo-serve.pid)"
    fi ;;
  status)
    echo "═══ oh-my-ops ═══"
    [ -d "$HOME/.omp/agent/extensions/ops-pi" ] && echo "  扩展：✓" || echo "  扩展：✗"
    [ -f /tmp/omo-serve.pid ] && kill -0 "$(cat /tmp/omo-serve.pid)" 2>/dev/null && echo "  服务：✓ PID $(cat /tmp/omo-serve.pid)" || echo "  服务：✗"
    [ -f "$HOME/.ops-pi/policy.json" ] && echo "  策略：✓" || echo "  策略：⚠ 未配置（变更全拒）"
    [ "${OPS_PI_SANDBOX:-0}" = "1" ] && echo "  沙箱：✓" || echo "  沙箱：⚠" ;;
  install)
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    [ -f "$SCRIPT_DIR/scripts/install.sh" ] && bash "$SCRIPT_DIR/scripts/install.sh" || { echo "✗"; exit 1; } ;;
  help|--help|-h)
    echo "omo — oh-my-ops CLI"
    echo "  omo                      交互式"
    echo "  omo serve                后台服务"
    echo "  omo serve --foreground   前台服务"
    echo "  omo status               状态"
    echo "  omo install              部署"
    echo "  其他参数透传 omp" ;;
  *)
    exec omp "$@" ;;
esac
OMOEOF
chmod +x "$BIN_DST"
echo "  ✓ $BIN_DST"

# 3) 初始化策略目录
echo "[3/3] 策略目录…"
mkdir -p "$POLICY_DST"
if [ ! -f "$POLICY_DST/policy.json" ]; then
  echo '{"targets":[]}' > "$POLICY_DST/policy.json"
  echo "  ✓ 空策略（变更全拒）"
else
  echo "  ✓ 策略已存在"
fi
[ -f "$POLICY_DST/approval-token.json" ] || echo '{"tokens":[]}' > "$POLICY_DST/approval-token.json"

echo
echo "═══ ✓ 安装完成 ═══"
echo "  omo                      → 交互式"
echo "  omo -p '巡检 web-01'     → 非交互巡检"
echo "  omo serve                → 后台服务"
echo "  omo status               → 状态"
echo "  编辑 ~/.ops-pi/policy.json 添加预授权目标"
