#!/bin/zsh
set -euo pipefail

source_dir="${0:A:h}"
install_dir="$HOME/Library/Application Support/AntigravityChineseHelper/application"

if /bin/ps -axo comm= | /usr/bin/grep -F '/Antigravity汉化助手.app/Contents/MacOS/AntigravityChineseHelper' >/dev/null; then
    echo "请先从菜单栏退出汉化助手，再重新安装。" >&2
    exit 1
fi

mkdir -p "$install_dir"
/usr/bin/ditto "$source_dir/Antigravity汉化助手.app" "$install_dir/Antigravity汉化助手.app"
/usr/bin/ditto "$source_dir/runtime" "$install_dir/runtime"
/bin/cp "$source_dir/README.md" "$install_dir/README.md"
echo "已安装到：$install_dir"
echo "双击 Antigravity汉化助手.app 即可启动。"
