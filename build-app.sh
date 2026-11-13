#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h}"
app_dir="$project_dir/Antigravity汉化助手.app"
if /bin/ps -axo args= | /usr/bin/awk -v helper="$app_dir/Contents/MacOS/AntigravityChineseHelper" '$0 == helper || index($0, helper " ") == 1 { found = 1 } END { exit !found }'; then
    echo "请先从菜单栏退出汉化助手，再重新构建。" >&2
    exit 1
fi
mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources"
icon_work_dir=$(/usr/bin/mktemp -d)
trap '/bin/rm -rf "$icon_work_dir"' EXIT
xcrun swift "$project_dir/packaging/GenerateIcon.swift" "$icon_work_dir/HelperIcon.iconset"
/usr/bin/iconutil -c icns "$icon_work_dir/HelperIcon.iconset" -o "$app_dir/Contents/Resources/HelperIcon.icns"

xcrun swiftc -O -target "$(/usr/bin/uname -m)-apple-macos12.0" -framework AppKit \
    "$project_dir/packaging/Helper.swift" \
    "$project_dir/packaging/AppWatcher.swift" \
    "$project_dir/packaging/RuntimeSupport.swift" \
    "$project_dir/packaging/RunnerStatus.swift" \
    -o "$app_dir/Contents/MacOS/AntigravityChineseHelper"

xcrun clang -O2 -Wall -Wextra -target "$(/usr/bin/uname -m)-apple-macos12.0" \
    "$project_dir/runtime/backend-mach.c" \
    -o "$app_dir/Contents/MacOS/AntigravityBackendMach"
codesign --force --sign - --timestamp=none "$app_dir/Contents/MacOS/AntigravityBackendMach"

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
    <key>CFBundleIconFile</key><string>HelperIcon</string>
    <key>CFBundleShortVersionString</key><string>$app_version</string>
    <key>CFBundleVersion</key><string>$app_version</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

codesign --force --sign - "$app_dir"
echo "已生成：$app_dir"
