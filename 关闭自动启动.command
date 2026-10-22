#!/bin/zsh
set -euo pipefail

agent_label="local.antigravity.chinese-helper.watcher"
agent_plist="$HOME/Library/LaunchAgents/$agent_label.plist"
agent_target="gui/$(/usr/bin/id -u)/$agent_label"

if /bin/launchctl print "$agent_target" >/dev/null 2>&1; then
    /bin/launchctl bootout "$agent_target"
fi
/bin/rm -f "$agent_plist"
echo "已关闭随 Antigravity 自动启动，当前助手保持原有运行状态。"
echo "需要重新开启时，再运行“安装汉化助手.command”。"
