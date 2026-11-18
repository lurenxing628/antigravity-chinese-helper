param(
    [string]$OutputDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function U([string]$escaped) {
    return [System.Text.RegularExpressions.Regex]::Unescape($escaped)
}

$projectDir = $PSScriptRoot
$exeName = U "Antigravity\u6c49\u5316\u52a9\u624b.exe"
$outputExe = Join-Path $OutputDir $exeName
$outputIco = Join-Path $OutputDir 'HelperIcon.ico'

$rendererPath = Join-Path $projectDir 'runtime\renderer.js'
if (-not (Test-Path -LiteralPath $rendererPath)) {
    throw (U "\u672a\u627e\u5230 runtime\\renderer.js")
}

$rendererContent = [System.IO.File]::ReadAllText($rendererPath, [System.Text.Encoding]::UTF8)
$versionMatch = [System.Text.RegularExpressions.Regex]::Match($rendererContent, "(?m)^\s*const VERSION = '([0-9]+(?:\.[0-9]+){1,3})';\s*$")
if (-not $versionMatch.Success) {
    throw (U "\u65e0\u6cd5\u4ece runtime/renderer.js \u8bfb\u53d6\u7248\u672c\u53f7\u3002")
}
$appVersion = $versionMatch.Groups[1].Value
$versionParts = $appVersion.Split('.')
while ($versionParts.Count -lt 4) {
    $versionParts += '0'
}
$fourPartVersion = ($versionParts[0..3] -join '.')

if (Test-Path -LiteralPath $outputExe) {
    try {
        $stream = [System.IO.File]::Open($outputExe, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $stream.Close()
    } catch {
        throw (U "\u8bf7\u5148\u4ece\u7cfb\u7edf\u6258\u76d8\u9000\u51fa\u6c49\u5316\u52a9\u624b\uff0c\u518d\u91cd\u65b0\u6784\u5efa\u3002")
    }
}

$cscCandidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
    throw (U "\u672a\u627e\u5230 Windows \u5185\u7f6e C# \u7f16\u8bd1\u5668 (csc.exe)\u3002")
}

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agh-winbuild-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

try {
    $assemblyTitle = U "Antigravity \u6c49\u5316\u52a9\u624b"
    $assemblyInfoPath = Join-Path $workDir 'AssemblyInfo.cs'
    $assemblyInfo = @"
using System.Reflection;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("$assemblyTitle")]
[assembly: AssemblyDescription("$assemblyTitle (Windows)")]
[assembly: AssemblyProduct("AntigravityChineseHelper")]
[assembly: AssemblyVersion("$fourPartVersion")]
[assembly: AssemblyFileVersion("$fourPartVersion")]
[assembly: AssemblyInformationalVersion("$appVersion")]
[assembly: ComVisible(false)]
"@
    [System.IO.File]::WriteAllText($assemblyInfoPath, $assemblyInfo, (New-Object System.Text.UTF8Encoding($true)))

    $csSources = @(
        (Join-Path $projectDir 'packaging\windows\RunnerStatus.cs'),
        (Join-Path $projectDir 'packaging\windows\AppWatcher.cs'),
        (Join-Path $projectDir 'packaging\windows\RuntimeSupport.cs'),
        (Join-Path $projectDir 'packaging\windows\IconGenerator.cs'),
        (Join-Path $projectDir 'packaging\windows\HelperApp.cs'),
        $assemblyInfoPath
    )

    $bootstrapExe = Join-Path $workDir 'BootstrapHelper.exe'
    $commonArgs = @(
        '/nologo',
        '/optimize+',
        '/utf8output',
        '/r:System.dll',
        '/r:System.Core.dll',
        '/r:System.Drawing.dll',
        '/r:System.Windows.Forms.dll',
        '/r:System.Web.Extensions.dll'
    )

    & $csc @commonArgs '/target:exe' "/out:$bootstrapExe" @csSources
    if ($LASTEXITCODE -ne 0) {
        throw "Bootstrap compilation failed with exit code $LASTEXITCODE"
    }

    & $bootstrapExe '--generate-icon' $outputIco
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputIco)) {
        throw "Failed to generate HelperIcon.ico"
    }

    & $csc @commonArgs '/target:winexe' "/win32icon:$outputIco" "/out:$outputExe" @csSources
    if ($LASTEXITCODE -ne 0) {
        throw "Final compilation failed with exit code $LASTEXITCODE"
    }

    Write-Output ((U "\u5df2\u751f\u6210\uff1a") + $outputExe + " (v$appVersion)")
}
finally {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
