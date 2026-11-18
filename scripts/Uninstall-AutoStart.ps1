$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function U([string]$escaped) {
    return [System.Text.RegularExpressions.Regex]::Unescape($escaped)
}

$exeName = U "Antigravity\u6c49\u5316\u52a9\u624b.exe"
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

if (Test-Path -LiteralPath $runKey) {
    Remove-ItemProperty -LiteralPath $runKey -Name 'AntigravityChineseHelperWatcher' -ErrorAction SilentlyContinue
}

Get-CimInstance Win32_Process -Filter "Name = '$exeName'" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.CommandLine -like '*--watch-antigravity*') {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

Write-Output (U "\u5df2\u5173\u95ed\u968f Antigravity \u81ea\u52a8\u542f\u52a8\uff1b\u5f53\u524d\u5df2\u8fd0\u884c\u7684\u6258\u76d8\u52a9\u624b\u4fdd\u6301\u539f\u6709\u72b6\u6001\u3002")
Write-Output (U "\u4ecd\u53ef\u901a\u8fc7\u684c\u9762\u6216\u5f00\u59cb\u83dc\u5355\u4e2d\u7684\u201cAntigravity \u6c49\u5316\u52a9\u624b\u201d\u624b\u52a8\u542f\u52a8\u3002")
