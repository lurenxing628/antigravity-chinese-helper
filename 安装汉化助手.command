#!/bin/zsh
set -euo pipefail

source_dir="${0:A:h}"
install_dir="$HOME/Library/Application Support/AntigravityChineseHelper/application"
agent_label="local.antigravity.chinese-helper.watcher"
agent_plist="$HOME/Library/LaunchAgents/$agent_label.plist"
agent_target="gui/$(/usr/bin/id -u)/$agent_label"

if /bin/ps -axo comm=,args= | /usr/bin/awk 'index($0, "/Antigravity汉化助手.app/Contents/MacOS/AntigravityChineseHelper") && !index($0, "--watch-antigravity") { found = 1 } END { exit !found }'; then
    echo "请先从菜单栏退出汉化助手，再重新安装。" >&2
    exit 1
fi

if /bin/launchctl print "$agent_target" >/dev/null 2>&1; then
    /bin/launchctl bootout "$agent_target"
fi

mkdir -p "$install_dir"
/usr/bin/ditto "$source_dir/Antigravity汉化助手.app" "$install_dir/Antigravity汉化助手.app"
/usr/bin/ditto "$source_dir/runtime" "$install_dir/runtime"
/bin/cp "$source_dir/README.md" "$install_dir/README.md"
/bin/cp "$source_dir/关闭自动启动.command" "$install_dir/关闭自动启动.command"
/bin/chmod +x "$install_dir/关闭自动启动.command"

mkdir -p "${agent_plist:h}"
/usr/bin/plutil -create xml1 "$agent_plist"
/usr/bin/plutil -insert Label -string "$agent_label" "$agent_plist"
/usr/bin/plutil -insert ProgramArguments -array "$agent_plist"
/usr/bin/plutil -insert ProgramArguments.0 -string "$install_dir/Antigravity汉化助手.app/Contents/MacOS/AntigravityChineseHelper" "$agent_plist"
/usr/bin/plutil -insert ProgramArguments.1 -string '--watch-antigravity' "$agent_plist"
/usr/bin/plutil -insert RunAtLoad -bool true "$agent_plist"
/usr/bin/plutil -insert ProcessType -string Background "$agent_plist"
/bin/chmod 644 "$agent_plist"
/bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$agent_plist"

echo "已安装到：$install_dir"
echo "已开启随 Antigravity 自动启动；Antigravity 已运行时会立即打开助手。"
echo "关闭自动启动：双击安装目录中的“关闭自动启动.command”。"
