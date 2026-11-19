param(
    [string]$InstallRoot = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'AntigravityChineseHelper' } else { Join-Path $HOME 'AppData\Local\AntigravityChineseHelper' }),
    [switch]$NoAutoStart,
    [switch]$SkipShortcuts
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function U([string]$escaped) {
    return [System.Text.RegularExpressions.Regex]::Unescape($escaped)
}

$sourceDir = Split-Path -Parent $PSScriptRoot
$exeName = U "Antigravity\u6c49\u5316\u52a9\u624b.exe"
$shortcutTitle = U "Antigravity \u6c49\u5316\u52a9\u624b.lnk"
$disableCmdName = U "\u5173\u95ed\u81ea\u52a8\u542f\u52a8.cmd"
$sourceExe = Join-Path $sourceDir $exeName
$sourceIco = Join-Path $sourceDir 'HelperIcon.ico'

$needsBuild = -not (Test-Path -LiteralPath $sourceExe)
if (-not $needsBuild) {
    $exeTime = (Get-Item -LiteralPath $sourceExe).LastWriteTimeUtc
    $newestCs = Get-ChildItem -Path (Join-Path $sourceDir 'packaging\windows\*.cs') | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($newestCs -and $newestCs.LastWriteTimeUtc -gt $exeTime) {
        $needsBuild = $true
    }
}
$buildScript = Join-Path $sourceDir 'build-windows.ps1'
if (-not (Test-Path -LiteralPath $buildScript)) {
    $altBuild = Join-Path $sourceDir 'scripts\build-windows.ps1'
    if (Test-Path -LiteralPath $altBuild) { $buildScript = $altBuild }
}
if ($needsBuild -and (Test-Path -LiteralPath $buildScript)) {
    & $buildScript -OutputDir $sourceDir
}

$installDir = Join-Path $InstallRoot 'application'
$installedExe = Join-Path $installDir $exeName
$installedRunner = Join-Path $installDir 'runtime\runner.mjs'

# Gracefully stop any running runner and existing helper/watcher processes before updating binaries.
if (-not $NoAutoStart) {
    if (Test-Path -LiteralPath $installedRunner) {
        $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($nodeCmd) {
            try {
                $env:ANTIGRAVITY_HELPER_STATE_DIR = $InstallRoot
                & $nodeCmd.Source $installedRunner '--stop' *> $null
            } catch { }
        }
    }
    Get-CimInstance Win32_Process -Filter "Name = '$exeName'" -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 300
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $installDir 'scripts') | Out-Null

Copy-Item -LiteralPath $sourceExe -Destination $installedExe -Force
if (Test-Path -LiteralPath $sourceIco) {
    Copy-Item -LiteralPath $sourceIco -Destination (Join-Path $installDir 'HelperIcon.ico') -Force
}

$targetRuntime = Join-Path $installDir 'runtime'
if (Test-Path -LiteralPath $targetRuntime) {
    Remove-Item -LiteralPath $targetRuntime -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $sourceDir 'runtime') -Destination $targetRuntime -Recurse -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'README.md') -Destination (Join-Path $installDir 'README.md') -Force
Copy-Item -LiteralPath (Join-Path $sourceDir $disableCmdName) -Destination (Join-Path $installDir $disableCmdName) -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'scripts\Uninstall-AutoStart.ps1') -Destination (Join-Path $installDir 'scripts\Uninstall-AutoStart.ps1') -Force

if (-not $SkipShortcuts) {
    $shell = New-Object -ComObject WScript.Shell
    $startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $desktopDir = [Environment]::GetFolderPath('Desktop')

    foreach ($folder in @($startMenuDir, $desktopDir)) {
        if ($folder -and (Test-Path -LiteralPath $folder)) {
            $lnkPath = Join-Path $folder $shortcutTitle
            $shortcut = $shell.CreateShortcut($lnkPath)
            $shortcut.TargetPath = $installedExe
            $shortcut.WorkingDirectory = $installDir
            $shortcut.Description = (U "Antigravity \u6c49\u5316\u52a9\u624b")
            $shortcut.IconLocation = "$installedExe,0"
            $shortcut.Save()

            # Dual-insurance: ensure official Antigravity.lnk carries --remote-debugging-port=0 if present.
            $agLnk = Join-Path $folder 'Antigravity.lnk'
            if (Test-Path -LiteralPath $agLnk) {
                try {
                    $agSc = $shell.CreateShortcut($agLnk)
                    if ($agSc.TargetPath -like '*Antigravity.exe' -and ($agSc.Arguments -notmatch '--remote-debugging-port')) {
                        $existingArgs = if ([string]::IsNullOrWhiteSpace($agSc.Arguments)) { '' } else { $agSc.Arguments.Trim() + ' ' }
                        $agSc.Arguments = $existingArgs + '--remote-debugging-port=0'
                        $agSc.Save()
                    }
                } catch { }
            }
        }
    }
}

# Pre-patch Antigravity app.asar during installation so existing or updated installs expose CDP immediately on next launch.
$installedBridge = Join-Path $installDir 'runtime\asar-bridge.mjs'
$nodeForPatch = Get-Command node.exe -ErrorAction SilentlyContinue
if ($nodeForPatch -and (Test-Path -LiteralPath $installedBridge)) {
    try {
        $env:ANTIGRAVITY_HELPER_STATE_DIR = $InstallRoot
        & $nodeForPatch.Source $installedBridge '--patch' *> $null
    } catch { }
}

if (-not $NoAutoStart) {
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    if (-not (Test-Path -LiteralPath $runKey)) {
        New-Item -Path $runKey -Force | Out-Null
    }
    $watcherCommand = "`"$installedExe`" --watch-antigravity"
    Set-ItemProperty -LiteralPath $runKey -Name 'AntigravityChineseHelperWatcher' -Value $watcherCommand -Type String

    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Start-Process -FilePath $installedExe -ArgumentList '--watch-antigravity' -WindowStyle Hidden
}

Write-Output ((U "\u5df2\u5b89\u88c5\u5230\uff1a") + $installDir)
if (-not $SkipShortcuts) {
    Write-Output (U "\u5df2\u521b\u5efa\u5f00\u59cb\u83dc\u5355\u4e0e\u684c\u9762\u5feb\u6377\u65b9\u5f0f\uff1aAntigravity \u6c49\u5316\u52a9\u624b\uff08\u70b9\u51fb\u542f\u52a8\u6216\u805a\u7126 Antigravity\uff09\u3002")
}
if (-not $NoAutoStart) {
    Write-Output (U "\u5df2\u5f00\u542f\u968f Antigravity \u81ea\u52a8\u542f\u52a8\uff1bAntigravity \u5df2\u8fd0\u884c\u65f6\u4f1a\u7acb\u5373\u5728\u7cfb\u7edf\u6258\u76d8\u6253\u5f00\u52a9\u624b\u3002")
    Write-Output ((U "\u5173\u95ed\u81ea\u52a8\u542f\u52a8\uff1a\u53cc\u51fb\u201c") + $disableCmdName + (U "\u201d\u3002"))
}
