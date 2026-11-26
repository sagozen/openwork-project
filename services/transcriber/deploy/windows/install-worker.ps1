# Installs the primary transcription worker on the home Windows desktop as a service that
# starts at boot, without a login.
#
#   powershell -ExecutionPolicy Bypass -File install-worker.ps1 `
#     -ApiUrl "https://transcriptanything.zhst.app" `
#     -WorkerToken "wkr_..." `
#     -WhisperModel "large-v3-turbo-q5_0"
#
# The worker runs natively on Windows (not in WSL): inside WSL2 the RX 6800 is only reachable
# through a D3D12 translation layer and ROCm does not support RX 6000 cards. WSL keeps only
# cloudflared for remote admin.

param(
  [Parameter(Mandatory = $true)][string]$ApiUrl,
  [Parameter(Mandatory = $true)][string]$WorkerToken,
  [string]$WhisperModel = "large-v3-turbo-q5_0",
  [int]$Concurrency = 1,
  [int]$MaxAudioSeconds = 10800,
  [int]$WhisperThreads = 8,
  [string]$InstallDir = "$env:ProgramData\TranscriptWorker",
  [string]$WhisperCppVersion = "1.8.1",
  # The worker reports this until the first auto-update writes version.txt.
  [string]$WorkerVersion = "0.0.0",
  [string]$DashboardAddr = "127.0.0.1:8787",
  [bool]$AutoUpdate = $true,
  # LibreHardwareMonitor provides the RX 6800 and CPU temperatures through its local web server.
  [bool]$InstallSensors = $true
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell window."
  }
}

function Download-IfMissing([string]$Url, [string]$Destination) {
  if (Test-Path $Destination) { return }
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

Assert-Admin

if ($DashboardAddr -ne "off" -and $DashboardAddr -notmatch '^(127\.0\.0\.1|localhost|\[::1\]):\d+$') {
  throw "DashboardAddr must be loopback (127.0.0.1:8787, localhost:8787, [::1]:8787) or off."
}

# A running service locks transcriber.exe and the whisper DLLs, so stop it before copying files.
if (Get-Service TranscriptWorker -ErrorAction SilentlyContinue) {
  Stop-Service TranscriptWorker -Force
  (Get-Service TranscriptWorker).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
}

New-Item -ItemType Directory -Force -Path $InstallDir, "$InstallDir\bin", "$InstallDir\models", "$InstallDir\tmp" | Out-Null

# 1. whisper.cpp (Vulkan build) ------------------------------------------------------------
# The upstream release zips have no Vulkan build for Windows (whisper-bin-x64.zip is CPU only), so
# build it once with -DGGML_VULKAN=ON and place the output in .\whisper-vulkan next to this script.
$vulkanDir = Join-Path $PSScriptRoot "whisper-vulkan"
if (-not (Test-Path "$vulkanDir\whisper-cli.exe") -or -not (Test-Path "$vulkanDir\ggml-vulkan.dll")) {
  throw "Place the Vulkan build of whisper.cpp (whisper-cli.exe, ggml-vulkan.dll and the other DLLs) in $vulkanDir."
}
Get-ChildItem "$vulkanDir\*" -Include "*.exe", "*.dll" | Copy-Item -Destination "$InstallDir\bin" -Force
if (-not (Test-Path "$InstallDir\bin\ggml-vulkan.dll")) { throw "ggml-vulkan.dll was not copied to $InstallDir\bin." }

# 2. ffmpeg / ffprobe ----------------------------------------------------------------------
$ffmpegZip = "$InstallDir\ffmpeg.zip"
Download-IfMissing "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" $ffmpegZip
Expand-Archive -Path $ffmpegZip -DestinationPath "$InstallDir\ffmpeg" -Force
Get-ChildItem "$InstallDir\ffmpeg" -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1 | ForEach-Object { Copy-Item $_.FullName "$InstallDir\bin\ffmpeg.exe" -Force }
Get-ChildItem "$InstallDir\ffmpeg" -Recurse -Filter "ffprobe.exe" | Select-Object -First 1 | ForEach-Object { Copy-Item $_.FullName "$InstallDir\bin\ffprobe.exe" -Force }

# 3. yt-dlp (pinned release; the worker self-updates daily) --------------------------------
Download-IfMissing "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" "$InstallDir\bin\yt-dlp.exe"

# 4. model ---------------------------------------------------------------------------------
$modelFile = "$InstallDir\models\ggml-$WhisperModel.bin"
Download-IfMissing "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$WhisperModel.bin" $modelFile

# 5. worker binary -------------------------------------------------------------------------
$workerExe = Join-Path $PSScriptRoot "transcriber.exe"
if (-not (Test-Path $workerExe)) {
  throw "Place the GOOS=windows transcriber.exe next to this script (services/transcriber/deploy/windows)."
}
Copy-Item $workerExe "$InstallDir\transcriber.exe" -Force

# 6. environment for the service -----------------------------------------------------------
$envFile = "$InstallDir\worker.env"
@"
TRANSCRIBER_API_URL=$ApiUrl
TRANSCRIBER_WORKER_TOKEN=$WorkerToken
TRANSCRIBER_TIER=primary
TRANSCRIBER_NAME=$env:COMPUTERNAME
TRANSCRIBER_VERSION=$WorkerVersion
TRANSCRIBER_STATE_DIR=$InstallDir
CONCURRENCY=$Concurrency
MAX_AUDIO_SECONDS=$MaxAudioSeconds
WHISPER_BIN=$InstallDir\bin\whisper-cli.exe
WHISPER_MODEL=$modelFile
WHISPER_THREADS=$WhisperThreads
FFMPEG_BIN=$InstallDir\bin\ffmpeg.exe
FFPROBE_BIN=$InstallDir\bin\ffprobe.exe
YTDLP_BIN=$InstallDir\bin\yt-dlp.exe
TRANSCRIBER_TEMP=$InstallDir\tmp
MIN_FREE_DISK_GB=5
HEARTBEAT_SECONDS=20
DASHBOARD_ADDR=$DashboardAddr
AUTO_UPDATE=$AutoUpdate
UPDATE_SERVICE=TranscriptWorker
METRICS_SECONDS=15
TEMP_SECONDS=30
SENSORS_URL=http://127.0.0.1:8085/data.json
"@ | Set-Content -Path $envFile -Encoding ASCII

# 7. service -------------------------------------------------------------------------------
$nssm = "$InstallDir\nssm.exe"
if (-not (Test-Path $nssm)) {
  $nssmZip = "$InstallDir\nssm.zip"
  Download-IfMissing "https://nssm.cc/release/nssm-2.24.zip" $nssmZip
  Expand-Archive -Path $nssmZip -DestinationPath "$InstallDir\nssm" -Force
  Copy-Item (Get-ChildItem "$InstallDir\nssm" -Recurse -Filter "nssm.exe" | Where-Object { $_.FullName -match "win64" } | Select-Object -First 1).FullName $nssm -Force
}

# First install: the service does not exist yet, so nssm reports an error. Windows PowerShell 5.1
# turns native stderr into a terminating error under "Stop", so relax it for these two calls.
if (Get-Service TranscriptWorker -ErrorAction SilentlyContinue) {
  $ErrorActionPreference = "Continue"
  & $nssm stop TranscriptWorker 2>&1 | Out-Null
  & $nssm remove TranscriptWorker confirm 2>&1 | Out-Null
  $ErrorActionPreference = "Stop"
}
& $nssm install TranscriptWorker "$InstallDir\transcriber.exe"
& $nssm set TranscriptWorker AppDirectory $InstallDir
& $nssm set TranscriptWorker AppEnvironmentExtra (Get-Content $envFile | Where-Object { $_ -match "=" })
& $nssm set TranscriptWorker Start SERVICE_AUTO_START
& $nssm set TranscriptWorker AppStdout "$InstallDir\worker.log"
& $nssm set TranscriptWorker AppStderr "$InstallDir\worker.log"
& $nssm set TranscriptWorker AppRotateFiles 1
& $nssm set TranscriptWorker AppRotateBytes 10485760
& $nssm set TranscriptWorker AppExit Default Restart
& $nssm set TranscriptWorker AppRestartDelay 5000
& $nssm start TranscriptWorker

# 8. sensors (LibreHardwareMonitor) --------------------------------------------------------
# NSSM runs LHM as LocalSystem at boot with its web server enabled on loopback. The worker reads
# http://127.0.0.1:8085/data.json every TEMP_SECONDS; if that is unavailable it falls back to
# WMI (older LHM builds) and then to ACPI, reporting GPU temperature as unavailable rather than
# failing. The settings live in LibreHardwareMonitor.exe.config next to the executable.
try {
  if ($InstallSensors) {
    if (Get-Service TranscriptWorkerSensors -ErrorAction SilentlyContinue) {
      Stop-Service TranscriptWorkerSensors -Force -ErrorAction SilentlyContinue
      (Get-Service TranscriptWorkerSensors).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
    }
    $lhmZip = "$InstallDir\LibreHardwareMonitor.zip"
    Download-IfMissing "https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest/download/LibreHardwareMonitor.zip" $lhmZip
    Expand-Archive -Path $lhmZip -DestinationPath "$InstallDir\LibreHardwareMonitor" -Force
    $lhmExe = Get-ChildItem "$InstallDir\LibreHardwareMonitor" -Recurse -Filter "LibreHardwareMonitor.exe" | Select-Object -First 1
    if (-not $lhmExe) { throw "LibreHardwareMonitor.exe was not found in the downloaded archive." }

    # Enable LHM's local web server (off by default) and keep the existing runtime sections.
    $lhmConfigPath = Join-Path $lhmExe.DirectoryName "LibreHardwareMonitor.exe.config"
    if (-not (Test-Path $lhmConfigPath)) {
      throw "LibreHardwareMonitor.exe.config was not found; extract the full LibreHardwareMonitor.zip."
    }
    [xml]$lhmConfig = Get-Content -Path $lhmConfigPath -Raw
    $lhmSettings = $lhmConfig.SelectSingleNode("/configuration/appSettings")
    if (-not $lhmSettings) {
      $lhmSettings = $lhmConfig.CreateElement("appSettings")
      $lhmConfig.configuration.PrependChild($lhmSettings) | Out-Null
    }
    foreach ($setting in @(
      @{ Key = "runWebServerMenuItem"; Value = "true" },
      @{ Key = "listenerIp"; Value = "127.0.0.1" },
      @{ Key = "listenerPort"; Value = "8085" },
      @{ Key = "authenticationEnabled"; Value = "false" },
      @{ Key = "startMinMenuItem"; Value = "true" },
      @{ Key = "minTrayMenuItem"; Value = "true" }
    )) {
      $node = $lhmSettings.SelectSingleNode("add[@key='$($setting.Key)']")
      if (-not $node) {
        $node = $lhmConfig.CreateElement("add")
        $node.SetAttribute("key", $setting.Key)
        $lhmSettings.AppendChild($node) | Out-Null
      }
      $node.SetAttribute("value", $setting.Value)
    }
    $lhmConfig.Save($lhmConfigPath)

    # HttpListener needs a URL reservation when it is not the interactive desktop user.
    $ErrorActionPreference = "Continue"
    & netsh http delete urlacl 'url=http://127.0.0.1:8085/' 2>&1 | Out-Null
    & netsh http add urlacl 'url=http://127.0.0.1:8085/' 'user=NT AUTHORITY\SYSTEM' 2>&1 | Out-Null
    $ErrorActionPreference = "Stop"

    if (Get-Service TranscriptWorkerSensors -ErrorAction SilentlyContinue) {
      $ErrorActionPreference = "Continue"
      & $nssm stop TranscriptWorkerSensors 2>&1 | Out-Null
      & $nssm remove TranscriptWorkerSensors confirm 2>&1 | Out-Null
      $ErrorActionPreference = "Stop"
    }
    & $nssm install TranscriptWorkerSensors $lhmExe.FullName
    & $nssm set TranscriptWorkerSensors AppDirectory $lhmExe.DirectoryName
    & $nssm set TranscriptWorkerSensors Start SERVICE_AUTO_START
    & $nssm set TranscriptWorkerSensors AppStdout "$InstallDir\sensors.log"
    & $nssm set TranscriptWorkerSensors AppStderr "$InstallDir\sensors.log"
    & $nssm set TranscriptWorkerSensors AppRotateFiles 1
    & $nssm set TranscriptWorkerSensors AppRotateBytes 5242880
    & $nssm set TranscriptWorkerSensors AppExit Default Restart
    & $nssm start TranscriptWorkerSensors
    Start-Sleep -Seconds 3
    $sensorService = Get-Service TranscriptWorkerSensors -ErrorAction SilentlyContinue
    if (-not $sensorService -or $sensorService.Status -ne "Running") {
      Write-Warning "TranscriptWorkerSensors did not stay running. Start it once from an elevated shell (Start-Service TranscriptWorkerSensors) and check $InstallDir\sensors.log. The worker will use ACPI until then."
    } else {
      $sensorHTTP = $false
      for ($attempt = 0; $attempt -lt 5 -and -not $sensorHTTP; $attempt++) {
        try {
          $probe = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8085/data.json" -TimeoutSec 3
          if ($probe.StatusCode -eq 200) { $sensorHTTP = $true }
        } catch {
          Start-Sleep -Seconds 1
        }
      }
      if (-not $sensorHTTP) {
        Write-Warning "LibreHardwareMonitor is running but its sensor URL is not responding. The worker will use ACPI until http://127.0.0.1:8085/data.json returns 200; check the URL reservation and $InstallDir\sensors.log."
      }
    }
  }

} catch {
  Write-Warning ("Sensor install failed: " + $_.Exception.Message + ". The worker will use ACPI and show GPU temperature as unavailable.")
}

Write-Host ""
Write-Host "Worker installed as the TranscriptWorker service."
Write-Host "Local dashboard:  http://$DashboardAddr/  (loopback only; open it on this machine)"
Write-Host "Auto-update:      $AutoUpdate (releases are published in Admin -> Workers)"
Write-Host "Check it with:  Get-Service TranscriptWorker; Get-Content $InstallDir\worker.log -Tail 20"
Write-Host ""
Write-Host "Also set, once, in the BIOS and Windows:"
Write-Host "  - Restore on AC power loss: Power On"
Write-Host "  - Sleep and hibernate: Never (this is a worker)"
Write-Host "  - Windows Update active hours: night, so reboots do not land on a job"
Write-Host "  - AMD Adrenalin installed (Vulkan device must appear in whisper-cli's log)"
Write-Host "  - If the dashboard shows 'sensor unavailable', open http://127.0.0.1:8085/data.json,"
Write-Host "    start TranscriptWorkerSensors and read sensors.log. Run install-worker.ps1 with"
Write-Host "    -InstallSensors:`$false only if you do not want CPU/GPU temperatures."
