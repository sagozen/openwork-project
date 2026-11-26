# Cai dat ChatQASoftware tren Windows: chep app vao thu muc cai theo nguoi dung, tao loi tat, cai adb va them vao PATH.
# Chay: powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\cai-dat-chatqa.ps1"
# Tuy chon: -Exe <duong dan file exe da tai>  -SkipAdb
# Khong can quyen quan tri. Chi ghi vao %LOCALAPPDATA% va bien PATH cua tai khoan hien tai.
param(
  [string]$Exe = "",
  [switch]$SkipAdb
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Say($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

$appDir = Join-Path $env:LOCALAPPDATA "Programs\ChatQASoftware"
$appExe = Join-Path $appDir "ChatQASoftware.exe"

# 1. Tim file exe vua tai (moi nhat trong Downloads) neu khong chi dinh.
if (-not $Exe) {
  $downloads = Join-Path $env:USERPROFILE "Downloads"
  $found = Get-ChildItem -Path $downloads -Filter "ChatQASoftware*.exe" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($found) { $Exe = $found.FullName }
}

if ($Exe) {
  if (-not (Test-Path $Exe)) { throw "Khong thay file: $Exe" }
  $running = Get-Process -Name "ChatQASoftware" -ErrorAction SilentlyContinue
  if ($running) { throw "ChatQASoftware dang mo. Thoat app roi chay lai script." }
  Say "Chep $Exe vao $appDir"
  New-Item -ItemType Directory -Force -Path $appDir | Out-Null
  Copy-Item -Path $Exe -Destination $appExe -Force
  Unblock-File -Path $appExe -ErrorAction SilentlyContinue

  Say "Tao loi tat ChatQASoftware ngoai Desktop"
  $desktop = [Environment]::GetFolderPath("Desktop")
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut((Join-Path $desktop "ChatQASoftware.lnk"))
  $lnk.TargetPath = $appExe
  $lnk.WorkingDirectory = $appDir
  $lnk.Save()
} elseif (Test-Path $appExe) {
  Say "App da co tai $appExe (khong thay file moi trong Downloads)"
} else {
  Write-Warning "Chua thay file ChatQASoftware*.exe trong Downloads. Tai tu https://chatqasoft.zhst.app roi chay lai, hoac dung -Exe <duong dan>."
}

# 2. Cai adb (Android platform-tools chinh thuc cua Google) vao %LOCALAPPDATA%\Android\platform-tools.
if (-not $SkipAdb) {
  $androidDir = Join-Path $env:LOCALAPPDATA "Android"
  $toolsDir = Join-Path $androidDir "platform-tools"
  $adb = Join-Path $toolsDir "adb.exe"
  if (Test-Path $adb) {
    Say "adb da co tai $adb"
  } else {
    $zip = Join-Path $env:TEMP "platform-tools-latest-windows.zip"
    Say "Tai Android platform-tools tu dl.google.com"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" -OutFile $zip -UseBasicParsing
    New-Item -ItemType Directory -Force -Path $androidDir | Out-Null
    Expand-Archive -Path $zip -DestinationPath $androidDir -Force
    Remove-Item $zip -Force
  }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @()
  if ($userPath) { $parts = $userPath.Split(";") | Where-Object { $_ -ne "" } }
  if ($parts -notcontains $toolsDir) {
    Say "Them $toolsDir vao PATH cua tai khoan"
    [Environment]::SetEnvironmentVariable("Path", (($parts + $toolsDir) -join ";"), "User")
  }
  $env:Path = "$env:Path;$toolsDir"
  & $adb version
}

Write-Host ""
Say "Xong. Viec tiep theo:"
Write-Host "  1. Mo ChatQASoftware tu loi tat ngoai Desktop (lan dau: More info > Run anyway neu Windows canh bao)."
Write-Host "  2. Neu app dang mo truoc khi cai adb: thoat han app roi mo lai de app thay adb."
Write-Host "  3. Duong dan app de dung cho Claude Desktop: $appExe"
