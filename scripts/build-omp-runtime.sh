#!/usr/bin/env bash
# build-omp-runtime.sh — 构建 omo 品牌化 omp 单文件可执行（OMOINSTALL-2 设计 §A.3）。
#
# 用法：bash scripts/build-omp-runtime.sh [-o <输出路径>] [--work <工作目录>]
# 前置：bun（锁 1.4.x）、node、网络（npm registry；sha256 pin 防上游漂移）。
#
# 管线（方案 §A.3）：
#   1. npm pack @oh-my-pi/pi-coding-agent@<pin>（sha256 校验，T4）
#   2. 解包 + bun install --production
#   3. 生成 pi-natives embedded-addon.js（嵌入 .node 资产，H3 探针验证的契约）
#   4. patch-omp-brand.mjs 品牌化（正式化，构建期一次到位）
#   5. bun build --compile → omp-single
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OMP_PKG_NAME="@oh-my-pi/pi-coding-agent"
OMP_PKG_VERSION="18.1.18"
# sha256 pin：上游 tgz（npm pack 产物）；变更必须经主人评审（T4 pin 策略）
OMP_PKG_SHA256="edb4fec4544c28e709923e6ae4861dcd3aa546228acb4e7d10790a7e80c7b02b"
OUT="${OMO_RUNTIME_OUT:-$REPO_ROOT/dist/omp-single}"
WORK="${OMO_RUNTIME_WORK:-$(mktemp -d)}"
KEEP_WORK="${OMO_RUNTIME_KEEP_WORK:-0}"

echo "▸ [1/5] 拉取并校验上游包 $OMP_PKG_NAME@$OMP_PKG_VERSION"
mkdir -p "$WORK" && cd "$WORK"
npm pack "$OMP_PKG_NAME@$OMP_PKG_VERSION" >/dev/null 2>&1
TGZ="$WORK/oh-my-pi-pi-coding-agent-$OMP_PKG_VERSION.tgz"
[ -f "$TGZ" ] || TGZ="$(ls "$WORK"/*.tgz | head -1)"
echo "$OMP_PKG_SHA256  $TGZ" | sha256sum -c --quiet || {
  echo "✗ 上游包 sha256 不匹配（期望 $OMP_PKG_SHA256）——上游可能已变更，禁止带病构建"; exit 1;
}
mkdir -p pkg && tar xzf "$TGZ" -C pkg
cd pkg/package   # npm tgz 根目录即 package/

echo "▸ [2/5] bun install --production"
bun install --production

echo "▸ [3/5] 生成 pi-natives embedded-addon.js（嵌入平台原生件）"
node "$REPO_ROOT/scripts/embed-pi-natives.mjs" \
  --natives-dir node_modules/@oh-my-pi/pi-natives \
  --platform-dir node_modules/@oh-my-pi/pi-natives-linux-x64 \
  --platform-tag linux-x64

echo "▸ [4/5] 品牌化 patch（构建期正式化）"
node "$REPO_ROOT/scripts/patch-omp-brand.mjs" --target dist/cli.js

echo "▸ [5/5] bun build --compile → $OUT"
bun build --compile dist/cli.js --outfile "$OUT" 2>&1 | tail -2

VERSION=$(node -e "console.log(require('./package.json').version)")
echo "▸ 验证：$OUT --version"
GOT="$("$OUT" --version 2>&1 | head -1)"
echo "  版本输出：$GOT"
case "$GOT" in *"$VERSION"*) ;; *) echo "✗ 版本验证失败：期望含 $VERSION"; exit 1 ;; esac
[ "$KEEP_WORK" = "1" ] || rm -rf "$WORK"
echo "✓ omp-single 构建完成（$OUT）"
