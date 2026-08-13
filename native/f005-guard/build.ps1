<#
.SYNOPSIS
F005 native Windows handle guardを再現可能な条件で構築・検証します。

.DESCRIPTION
クリーンcheckoutから次を1コマンドで実行します。
1. Microsoft公式URLから.NET SDK 9.0.316とRuntime 9.0.18を取得する。
2. 既知SHA-512を照合し、改変または不完全なdownloadを拒否する。
3. win-x64 self-contained single-fileとしてpublishする。
4. source/project/global.json/実行ファイルのSHA-256をbuild-evidence.jsonへ生成する。
5. 固定実行ファイルSHA、hello ABI、RID、runtime version、証跡の再読込を検証する。

download、SDK、NuGet package、publish結果はすべて.gitignore済みの.cache配下です。
同じ入力で繰り返し実行でき、既存downloadも毎回hash検証します。

.EXAMPLE
pwsh -NoProfile -File native/f005-guard/build.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SdkVersion = '9.0.316'
$RuntimeVersion = '9.0.18'
$Rid = 'win-x64'
$Abi = 'f005-guard-jsonl-v1'
$CapacityAbi = 'f005-capacity-pipe-v3'
$SdkUrl = "https://builds.dotnet.microsoft.com/dotnet/Sdk/$SdkVersion/dotnet-sdk-$SdkVersion-win-x64.zip"
$RuntimeUrl = "https://builds.dotnet.microsoft.com/dotnet/Runtime/$RuntimeVersion/dotnet-runtime-$RuntimeVersion-win-x64.zip"
$SdkSha512 = '871d655b07f05aa5844a27a0dc742ccb6ca1e6df11be1c1251d6e967505595f455fd1160165048e3348f8dd2412ca82d414d0402c8acab30f997e30897a9040f'
$RuntimeSha512 = '38dd0b646bcf8e593d86456b97f75566a902358c437f84ab8b2b21c8f54cc0272910a91330936f02c8eec6e45c1157b716b21d15b91d55187daf19831c32b8a8'
$ExpectedExeSha256 = '6f619442cd05966b3aaf881e50762b77a782c9876bc88017f28dee5f72d11147'

$NativeRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $NativeRoot '..\..'))
$CacheRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot '.cache\dotnet-f005'))
$DownloadRoot = Join-Path $CacheRoot 'downloads'
$SdkRoot = Join-Path $CacheRoot 'sdk'
$RuntimeRoot = Join-Path $CacheRoot 'runtime'
$PublishRoot = Join-Path $CacheRoot 'publish'
$CliHome = Join-Path $CacheRoot 'cli-home'
$NugetRoot = Join-Path $CacheRoot 'nuget'
$SdkZip = Join-Path $DownloadRoot "dotnet-sdk-$SdkVersion-win-x64.zip"
$RuntimeZip = Join-Path $DownloadRoot "dotnet-runtime-$RuntimeVersion-win-x64.zip"
$Dotnet = Join-Path $SdkRoot 'dotnet.exe'
$GuardExe = Join-Path $PublishRoot 'f005-guard.exe'
$EvidencePath = Join-Path $NativeRoot 'build-evidence.json'

function Get-LowerHash {
  param(
    [Parameter(Mandatory)]
    [string]$Path,
    [Parameter(Mandatory)]
    [ValidateSet('SHA256', 'SHA512')]
    [string]$Algorithm
  )
  return (Get-FileHash -LiteralPath $Path -Algorithm $Algorithm).Hash.ToLowerInvariant()
}

function Assert-Hash {
  param(
    [Parameter(Mandatory)]
    [string]$Path,
    [Parameter(Mandatory)]
    [string]$Algorithm,
    [Parameter(Mandatory)]
    [string]$Expected
  )
  $Actual = Get-LowerHash -Path $Path -Algorithm $Algorithm
  if ($Actual -ne $Expected) {
    throw "$Path の${Algorithm}が固定値と一致しません。expected=$Expected actual=$Actual"
  }
}

function Get-VerifiedDownload {
  param(
    [Parameter(Mandatory)]
    [string]$Url,
    [Parameter(Mandatory)]
    [string]$Destination,
    [Parameter(Mandatory)]
    [string]$ExpectedSha512
  )
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    try {
      Assert-Hash -Path $Destination -Algorithm SHA512 -Expected $ExpectedSha512
      Write-Host "検証済みdownloadを再利用: $Destination"
      return
    } catch {
      Remove-Item -LiteralPath $Destination -Force
    }
  }
  $Temporary = "$Destination.download"
  Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
  Write-Host "公式配布物を取得: $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Temporary
  Assert-Hash -Path $Temporary -Algorithm SHA512 -Expected $ExpectedSha512
  Move-Item -LiteralPath $Temporary -Destination $Destination
}

function Reset-CacheDirectory {
  param([Parameter(Mandatory)][string]$Path)
  $ResolvedParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $Path))
  if ($ResolvedParent -ne $CacheRoot) {
    throw "cache外のdirectory削除を拒否しました: $Path"
  }
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
  New-Item -ItemType Directory -Path $Path | Out-Null
}

$Drive = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($CacheRoot).TrimEnd('\').TrimEnd(':'))
if ($Drive.Free -lt 5GB) {
  throw "空き容量が5GB未満のためbuildを中止します。free=$($Drive.Free)"
}

New-Item -ItemType Directory -Force -Path $CacheRoot, $DownloadRoot, $CliHome, $NugetRoot | Out-Null
Get-VerifiedDownload -Url $SdkUrl -Destination $SdkZip -ExpectedSha512 $SdkSha512
Get-VerifiedDownload -Url $RuntimeUrl -Destination $RuntimeZip -ExpectedSha512 $RuntimeSha512

$SdkReady = (Test-Path -LiteralPath $Dotnet -PathType Leaf)
if ($SdkReady) {
  $InstalledSdk = (& $Dotnet --version).Trim()
  $SdkReady = $LASTEXITCODE -eq 0 -and $InstalledSdk -eq $SdkVersion
}
if (-not $SdkReady) {
  Reset-CacheDirectory -Path $SdkRoot
  Expand-Archive -LiteralPath $SdkZip -DestinationPath $SdkRoot
}

$RuntimeDotnet = Join-Path $RuntimeRoot 'dotnet.exe'
$RuntimeReady = Test-Path -LiteralPath $RuntimeDotnet -PathType Leaf
if (-not $RuntimeReady) {
  Reset-CacheDirectory -Path $RuntimeRoot
  Expand-Archive -LiteralPath $RuntimeZip -DestinationPath $RuntimeRoot
}
$RuntimeList = (& $RuntimeDotnet --list-runtimes) -join "`n"
if ($LASTEXITCODE -ne 0 -or $RuntimeList -notmatch [regex]::Escape("Microsoft.NETCore.App $RuntimeVersion")) {
  throw ".NET Runtime $RuntimeVersion の展開検証に失敗しました"
}

$env:DOTNET_ROOT = $SdkRoot
$env:DOTNET_CLI_HOME = $CliHome
$env:NUGET_PACKAGES = $NugetRoot
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'

Reset-CacheDirectory -Path $PublishRoot
Push-Location $NativeRoot
try {
  & $Dotnet publish '.\F005Guard.csproj' `
    --configuration Release `
    --runtime $Rid `
    --self-contained true `
    --output $PublishRoot `
    -p:RuntimeFrameworkVersion=$RuntimeVersion `
    -p:IncludeSourceRevisionInInformationalVersion=false `
    "-p:PathMap=$NativeRoot=/_/native/f005-guard"
  if ($LASTEXITCODE -ne 0) {
    throw "dotnet publishがexit code $LASTEXITCODE で失敗しました"
  }
} finally {
  Pop-Location
}

Assert-Hash -Path $GuardExe -Algorithm SHA256 -Expected $ExpectedExeSha256
Push-Location (Split-Path -Parent $GuardExe)
try {
  $HelloRaw = '{"op":"hello"}' | & $GuardExe
  if ($LASTEXITCODE -ne 0) {
    throw "native guard helloがexit code $LASTEXITCODE で失敗しました"
  }
} finally {
  Pop-Location
}
$Hello = $HelloRaw | ConvertFrom-Json
if (
  $Hello.ok -ne $true -or
  $Hello.abi -ne $Abi -or
  $Hello.capacityAbi -ne $CapacityAbi -or
  $Hello.rid -ne $Rid -or
  $Hello.runtimeVersion -ne $RuntimeVersion -or
  $Hello.binarySha256 -ne $ExpectedExeSha256 -or
  $Hello.workingDirectoryIsExecutableDirectory -ne $true
) {
  throw "native guard hello固定値が一致しません: $HelloRaw"
}

$Evidence = [ordered]@{
  schemaVersion = '1.0.0'
  abi = $Abi
  capacityAbi = $CapacityAbi
  rid = $Rid
  sdkVersion = $SdkVersion
  runtimeVersion = $RuntimeVersion
  sdkZipSha512 = $SdkSha512
  runtimeZipSha512 = $RuntimeSha512
  programSha256 = Get-LowerHash -Path (Join-Path $NativeRoot 'Program.cs') -Algorithm SHA256
  projectSha256 = Get-LowerHash -Path (Join-Path $NativeRoot 'F005Guard.csproj') -Algorithm SHA256
  globalJsonSha256 = Get-LowerHash -Path (Join-Path $NativeRoot 'global.json') -Algorithm SHA256
  apphostSha256 = Get-LowerHash -Path $GuardExe -Algorithm SHA256
  outputBinarySha256 = Get-LowerHash -Path $GuardExe -Algorithm SHA256
  outputBytes = (Get-Item -LiteralPath $GuardExe).Length
}
$EvidenceJson = ($Evidence | ConvertTo-Json) + "`n"
[System.IO.File]::WriteAllText(
  $EvidencePath,
  $EvidenceJson.Replace("`r`n", "`n"),
  [System.Text.UTF8Encoding]::new($false)
)

$Verified = Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json
if (
  $Verified.programSha256 -ne (Get-LowerHash -Path (Join-Path $NativeRoot 'Program.cs') -Algorithm SHA256) -or
  $Verified.projectSha256 -ne (Get-LowerHash -Path (Join-Path $NativeRoot 'F005Guard.csproj') -Algorithm SHA256) -or
  $Verified.globalJsonSha256 -ne (Get-LowerHash -Path (Join-Path $NativeRoot 'global.json') -Algorithm SHA256) -or
  $Verified.outputBinarySha256 -ne (Get-LowerHash -Path $GuardExe -Algorithm SHA256) -or
  [long]$Verified.outputBytes -ne (Get-Item -LiteralPath $GuardExe).Length
) {
  throw 'build-evidence.jsonの再読込検証に失敗しました'
}

Write-Host "F005 native guard build/verify PASS"
Write-Host "binary: $GuardExe"
Write-Host "sha256: $($Verified.outputBinarySha256)"
