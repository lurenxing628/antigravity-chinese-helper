#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h}"
app_dir="$project_dir/Antigravity汉化助手.app"
if /bin/ps -axo args= | /usr/bin/grep -Fx "$app_dir/Contents/MacOS/AntigravityChineseHelper" >/dev/null; then
    echo "请先从菜单栏退出汉化助手，再重新构建。" >&2
    exit 1
fi
mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources"

xcrun swiftc -O -target "$(/usr/bin/uname -m)-apple-macos12.0" -framework AppKit \
    "$project_dir/packaging/Helper.swift" \
    "$project_dir/packaging/AppWatcher.swift" \
    "$project_dir/packaging/RuntimeSupport.swift" \
    "$project_dir/packaging/RunnerStatus.swift" \
    -o "$app_dir/Contents/MacOS/AntigravityChineseHelper"

app_version=$(/usr/bin/sed -n "s/^  const VERSION = '\([0-9][0-9.]*\)';$/\1/p" "$project_dir/runtime/renderer.js")
if [[ -z "$app_version" ]]; then
    echo "无法从 runtime/renderer.js 读取版本号。" >&2
    exit 1
fi
cat > "$app_dir/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>local.antigravity.chinese-helper</string>
    <key>CFBundleName</key><string>Antigravity汉化助手</string>
    <key>CFBundleDisplayName</key><string>Antigravity 汉化助手</string>
    <key>CFBundleExecutable</key><string>AntigravityChineseHelper</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$app_version</string>
    <key>CFBundleVersion</key><string>$app_version</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

codesign --force --sign - "$app_dir"
echo "已生成：$app_dir"
