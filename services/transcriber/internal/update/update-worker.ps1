# Replaces transcriber.exe for the TranscriptWorker service. Started by the worker itself with
# DETACHED_PROCESS, so it keeps running after the old worker is stopped.
#
# The worker only stages an update when no job is running, so stopping the service here cannot
# interrupt a transcription. If the new binary does not start, the previous one is restored.

param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$StateDir,
  [Parameter(Mandatory = $true)][string]$StagedExe,
  [Parameter(Mandatory = $true)][string]$ServiceName,
  [int]$ProcessId = 0,
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$LogPath = "$StateDir\update.log"
)

$ErrorActionPreference = "Stop"

function Write-UpdateLog([string]$Message) {
  $line = "{0} {1}" -f (Get-Date).ToString("o"), $Message
  Add-Content -Path $LogPath -Value $line -Encoding ASCII
}

$exe = Join-Path $InstallDir "transcriber.exe"
$backup = Join-Path $InstallDir "transcriber.previous.exe"
$versionFile = Join-Path $StateDir "version.txt"
$versionBackup = Join-Path $StateDir "version.previous.txt"
$hadVersion = Test-Path $versionFile

try {
  Write-UpdateLog "update start version=$Version pid=$ProcessId"

  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $service) { throw "service $ServiceName was not found" }
  if ($service.Status -ne "Stopped") {
    Stop-Service -Name $ServiceName -Force
    (Get-Service -Name $ServiceName).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(90))
  }

  Start-Sleep -Seconds 1
  if (-not (Test-Path $StagedExe)) { throw "staged executable missing: $StagedExe" }
  if (Test-Path $exe) { Copy-Item $exe $backup -Force }
  if ($hadVersion) { Copy-Item $versionFile $versionBackup -Force }
  Move-Item -Force $StagedExe $exe
  Set-Content -Path $versionFile -Value $Version -Encoding ASCII -NoNewline

  if ($service) {
    Start-Service -Name $ServiceName
    (Get-Service -Name $ServiceName).WaitForStatus("Running", [TimeSpan]::FromSeconds(60))
    Start-Sleep -Seconds 10
    if ((Get-Service -Name $ServiceName).Status -ne "Running") { throw "service stopped after the update" }
  }
  Write-UpdateLog "update ok version=$Version"
} catch {
  Write-UpdateLog ("update failed: " + $_.Exception.Message)
  try {
    if (Test-Path $backup) { Copy-Item $backup $exe -Force }
    if ($hadVersion -and (Test-Path $versionBackup)) {
      Copy-Item $versionBackup $versionFile -Force
    } elseif (-not $hadVersion -and (Test-Path $versionFile)) {
      Remove-Item $versionFile -Force
    }
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
      Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
    }
  } catch {
    Write-UpdateLog ("rollback failed: " + $_.Exception.Message)
  }
  exit 1
}
