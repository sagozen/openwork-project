# Bật ChatQASoftware bản test cho Playwright: `wails dev` (backend Go thật) + thư mục dữ liệu riêng (sandbox), không đụng
# dữ liệu thật ở %LOCALAPPDATA%\ChatQASoftware. Trình duyệt vào http://localhost:$port.
#
#   powershell -File apps/chatqa/web/e2e/start-app.ps1                      # trỏ máy chủ prod (mặc định)
#   $env:E2E_API_BASE='http://127.0.0.1:8787'; ...start-app.ps1             # trỏ Worker chạy ở máy
#
# Khoá công khai lấy từ biến môi trường User (LICENSE_PUBLIC_KEY, RELEASE_PUBLIC_KEY) hoặc E2E_LICENSE_PUBLIC_KEY / E2E_RELEASE_PUBLIC_KEY.
# Lần đầu sandbox trống: kích hoạt license và đăng nhập MỘT LẦN trong cửa sổ app / http://localhost:$port; phiên lưu trong sandbox,
# các lần sau test dùng lại (test không tự gõ khoá hay mật khẩu).
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')
$sandbox = if ($env:E2E_SANDBOX) { $env:E2E_SANDBOX } else { Join-Path $env:TEMP 'chatqa-e2e' }
$port = if ($env:E2E_PORT) { $env:E2E_PORT } else { '34116' }  # HS Desk dùng 34115
$apiBase = if ($env:E2E_API_BASE) { $env:E2E_API_BASE } else { 'https://chatqasoft.zhst.app' }
function Get-Key($e2e, $name) {
  $v = [Environment]::GetEnvironmentVariable($e2e)
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, 'User') }
  if (-not $v) { throw "Thiếu $name (biến môi trường User) hoặc $e2e" }
  $v.Trim()
}
$licenseKey = Get-Key 'E2E_LICENSE_PUBLIC_KEY' 'LICENSE_PUBLIC_KEY'
$releaseKey = Get-Key 'E2E_RELEASE_PUBLIC_KEY' 'RELEASE_PUBLIC_KEY'

New-Item -ItemType Directory -Force $sandbox | Out-Null
# Wails giữ khoá 1 bản chạy: đóng ChatQASoftware thật trước.
Get-Process ChatQASoftware -ErrorAction SilentlyContinue | Stop-Process -Force

$env:LOCALAPPDATA = $sandbox
$env:Path = 'C:\Program Files\Go\bin;' + "$env:USERPROFILE\go\bin;" + $env:Path
Write-Host "Sandbox: $sandbox  |  API: $apiBase  |  mở http://localhost:$port khi thấy 'Using DevServer URL'"
Set-Location (Join-Path $repo 'apps\chatqa\desktop')
wails dev -skipbindings -devserver "localhost:$port" -ldflags "-X deskcore/config.Version=0.1.0 -X deskcore/config.APIBase=$apiBase -X deskcore/config.LicensePublicKey=$licenseKey -X deskcore/config.ReleasePublicKey=$releaseKey"

