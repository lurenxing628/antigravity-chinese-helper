param(
    [string]$StateRoot = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'AntigravityChineseHelper' } else { Join-Path $HOME 'AppData\Local\AntigravityChineseHelper' }),
    [string]$BinDir = $(Join-Path $HOME '.local\bin'),
    [switch]$SkipPathUpdate
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function U([string]$escaped) {
    return [System.Text.RegularExpressions.Regex]::Unescape($escaped)
}

$sourceDir = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $StateRoot 'cli\application\runtime'
$marker = 'REM AntigravityChineseHelper CLI launcher'

foreach ($entry in @('agy-zh.cmd', 'agyzh.cmd', 'agyz.cmd')) {
    $existing = Join-Path $BinDir $entry
    if (Test-Path -LiteralPath $existing) {
        $firstLines = Get-Content -LiteralPath $existing -TotalCount 4 -ErrorAction SilentlyContinue
        if (-not ($firstLines -contains $marker)) {
            [Console]::Error.WriteLine((U "CLI \u5165\u53e3\u5df2\u88ab\u73b0\u6709\u6587\u4ef6\u5360\u7528\uff1a") + $existing)
            exit 1
        }
    }
}

$runtimeFiles = @(
    'cli.mjs', 'cli-context.mjs', 'context-policy.mjs', 'cli-localization.mjs', 'cli-display.mjs',
    'cli-notice-localization.mjs', 'cli-status-localization.mjs', 'cli-title-localization.mjs',
    'cli-hud.mjs', 'cli-hud-render.mjs', 'cli-hud-metrics.mjs',
    'native-copy.mjs', 'backend-metadata.mjs', 'backend-layout.mjs',
    'backend-runtime.mjs', 'backend-hook.js', 'translations.json'
)

foreach ($file in $runtimeFiles) {
    $src = Join-Path $sourceDir ("runtime\$file")
    if (-not (Test-Path -LiteralPath $src)) {
        [Console]::Error.WriteLine((U "\u7f3a\u5c11 CLI \u8fd0\u884c\u6587\u4ef6\uff1a") + $src)
        exit 1
    }
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

foreach ($file in $runtimeFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceDir ("runtime\$file")) -Destination (Join-Path $runtimeDir $file) -Force
}

$launcherContent = @"
@echo off
$marker
setlocal
set "AGH_RUNTIME_DIR=$runtimeDir"
set "AGH_NODE="
if defined ANTIGRAVITY_HELPER_NODE if exist "%ANTIGRAVITY_HELPER_NODE%" set "AGH_NODE=%ANTIGRAVITY_HELPER_NODE%"
if not defined AGH_NODE (
  for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined AGH_NODE set "AGH_NODE=%%I"
)
if not defined AGH_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "AGH_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined AGH_NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "AGH_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined AGH_NODE (
  echo Node.js 22+ is required. Set ANTIGRAVITY_HELPER_NODE or add node.exe to PATH. 1>&2
  exit /b 1
)
"%AGH_NODE%" --experimental-sqlite --disable-warning=ExperimentalWarning -e "const major=Number(process.versions.node.split('.')[0]);if(!Number.isInteger(major)||major<22)process.exit(1);require('node:sqlite')" >nul 2>&1
if errorlevel 1 (
  echo Node.js 22+ with built-in node:sqlite is required. 1>&2
  exit /b 1
)
"%AGH_NODE%" "%AGH_RUNTIME_DIR%\cli.mjs" %*
exit /b %ERRORLEVEL%
"@

foreach ($entry in @('agy-zh.cmd', 'agyzh.cmd', 'agyz.cmd')) {
    $dest = Join-Path $BinDir $entry
    [System.IO.File]::WriteAllText($dest, $launcherContent.Replace("`r`n", "`n").Replace("`n", "`r`n"), [System.Text.Encoding]::ASCII)
}

& (Join-Path $BinDir 'agy-zh.cmd') --help
if ($LASTEXITCODE -ne 0) {
    throw "CLI launcher verification failed"
}

if (-not $SkipPathUpdate) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @()
    if ($userPath) {
        $parts = $userPath.Split(';', [System.StringSplitOptions]::RemoveEmptyEntries)
    }
    $alreadyInPath = $false
    foreach ($part in $parts) {
        if ([string]::Equals($part.TrimEnd('\'), $BinDir.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
            $alreadyInPath = $true
            break
        }
    }
    if (-not $alreadyInPath) {
        $nextPath = if ($userPath) { "$userPath;$BinDir" } else { $BinDir }
        [Environment]::SetEnvironmentVariable('Path', $nextPath, 'User')
        Write-Output ((U "\u5df2\u5c06 ") + $BinDir + (U " \u52a0\u5165\u5f53\u524d\u7528\u6237 PATH\uff08\u91cd\u65b0\u6253\u5f00\u7ec8\u7aef\u540e\u751f\u6548\uff09\u3002"))
    }
}

Write-Output ((U "\u5df2\u5b89\u88c5 CLI \u5165\u53e3\uff1a") + (Join-Path $BinDir 'agy-zh.cmd'))
Write-Output (U "\u4e5f\u53ef\u4f7f\u7528\uff1aagyzh\u3001agyz")
Write-Output (U "\u542f\u52a8\u4e2d\u6587\u72b6\u6001\u680f CLI\uff1aagy-zh")
