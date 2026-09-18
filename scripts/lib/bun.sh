#!/usr/bin/env bash
# lib/bun.sh —— bun 运行时的检测/自举（omo 安装器与 kb-enroll 服务安装器**共用**）
#
# 纪律（沿用 install.sh 既有约定）：
#   - 机器上已有 bun → 直接用，不改动；上一轮装好的标准位 ~/.bun/bin 也要认（长驻旧 shell 的 PATH 不会自动刷新）；
#   - 都没有 → 标准用户级安装 ~/.bun（官方脚本 → npmmirror zip 回退）；
#   - 失败即返回非 0（调用方决定如何报错退出），并打印可手动执行的替代命令。
#
# 使用：`. "$(dirname "$0")/lib/bun.sh"` 后调用 `ensure_bun`（成功时 bun 在 PATH）。

OMO_BUN_VERSION="${OMO_BUN_VERSION:-1.4.2}"
BUN_OFFICIAL="https://bun.sh/install"
BUN_MIRROR_ZIP="https://registry.npmmirror.com/-/binary/bun/bun-v${OMO_BUN_VERSION}/bun-linux-x64.zip"

# zip 解包多后端（目标机未必有 unzip；python3/bsdtar/7z 任一即可）
zip_extract() { # $1=zip  $2=目标目录
  if command -v unzip >/dev/null 2>&1; then unzip -oq "$1" -d "$2" >/dev/null
  elif command -v python3 >/dev/null 2>&1; then python3 -c "import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$1" "$2"
  elif command -v bsdtar >/dev/null 2>&1; then bsdtar -xf "$1" -C "$2" >/dev/null
  elif command -v 7z >/dev/null 2>&1; then 7z x -y -o"$2" "$1" >/dev/null
  else echo "✗ 无可用解压工具（unzip/python3/bsdtar/7z 任一）"; return 1; fi
}

# 确保 bun 可用；成功返回 0（PATH 已包含 bun），失败返回 1
ensure_bun() {
  local known="$HOME/.bun/bin/bun"
  if command -v bun >/dev/null 2>&1; then
    echo "  ✓ 检测到系统 bun $(bun --version 2>/dev/null || echo '?')——直接使用，不改动"
    return 0
  fi
  if [ -x "$known" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
    echo "  ✓ 检测到已有 bun $("$known" --version 2>/dev/null || echo '?')（~/.bun/bin；已为本次会话加入 PATH，新终端自动可用）"
    return 0
  fi
  echo "  未检测到 bun → 自动安装（标准用户级 ~/.bun；官方脚本 → npmmirror 回退）…"
  local installed=false tmpz
  # 官方脚本成功后 bun 落在 ~/.bun/bin（PATH 不一定已刷新）→ 以标准位存在与否判定成功，避免误判后重复下载
  if curl -fsSL --max-time 90 "$BUN_OFFICIAL" | bash -s -- "bun-v$OMO_BUN_VERSION" >/dev/null 2>&1 && [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
    installed=true; echo "  ✓ bun $("$HOME/.bun/bin/bun" --version)（官方脚本 → ~/.bun/bin）"
  fi
  if [ "$installed" = false ]; then
    echo "  ↺ 官方通道失败，回退 npmmirror zip…"
    tmpz="$(mktemp -d)"
    if curl -fsSL --max-time 300 "$BUN_MIRROR_ZIP" -o "$tmpz/bun.zip" \
       && zip_extract "$tmpz/bun.zip" "$tmpz" \
       && [ -f "$tmpz/bun-linux-x64/bun" ]; then
      mkdir -p "$HOME/.bun/bin"
      mv "$tmpz/bun-linux-x64/bun" "$HOME/.bun/bin/bun"; chmod +x "$HOME/.bun/bin/bun"
      export PATH="$HOME/.bun/bin:$PATH"
      if ! grep -qs '.bun/bin' "$HOME/.bashrc" "$HOME/.profile" 2>/dev/null; then
        printf '\nexport PATH="$HOME/.bun/bin:$PATH"\n' >> "$HOME/.bashrc"
      fi
      installed=true; echo "  ✓ bun $(bun --version)（npmmirror → ~/.bun/bin）"
    fi
    rm -rf "$tmpz"
  fi
  if ! command -v bun >/dev/null 2>&1; then
    echo "  ✗ bun 自动安装失败（官方与镜像通道均不可达）。可手动：curl -fsSL https://bun.sh/install | bash"
    return 1
  fi
  echo "  ✓ bun 就绪"
  return 0
}
