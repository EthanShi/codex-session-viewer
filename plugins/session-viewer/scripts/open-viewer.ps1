[CmdletBinding()]
param(
  [int]$Port = 3847
)

$ErrorActionPreference = 'Stop'
$serverPath = Join-Path $PSScriptRoot 'server.mjs'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw 'Node.js 22.13 or newer is required to run Session Viewer.'
}
$runtimeCheck = Join-Path $PSScriptRoot 'check-runtime.mjs'
& $nodeCommand.Source $runtimeCheck
if ($LASTEXITCODE -ne 0) { throw 'Session Viewer requires Node.js 22.13+ with built-in SQLite FTS5 support.' }

function Get-ViewerHealth([int]$CandidatePort) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$CandidatePort/api/health" -TimeoutSec 1
    if ($health.ok -eq $true -and $health.sources.codex -and $health.sources.claude) { return $health }
  } catch {
    return $null
  }
  return $null
}

$selectedPort = $null
$viewerProcess = $null
$launchId = [guid]::NewGuid().ToString('N')
$candidatePorts = $Port..($Port + 10)

foreach ($candidatePort in $candidatePorts) {
  $health = Get-ViewerHealth $candidatePort
  if ($health) {
    if ($health.searchVersion -eq 2 -and $health.rangeSearch -eq $true) {
      $selectedPort = $candidatePort
      break
    }
    continue
  }

  $logRoot = Join-Path $env:TEMP 'codex-session-viewer'
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  $stdoutPath = Join-Path $logRoot "viewer-$candidatePort-$launchId.stdout.log"
  $stderrPath = Join-Path $logRoot "viewer-$candidatePort-$launchId.stderr.log"
  $viewerProcess = Start-Process `
    -FilePath $nodeCommand.Source `
    -ArgumentList @("`"$serverPath`"", '--port', "$candidatePort") `
    -WorkingDirectory (Split-Path $PSScriptRoot -Parent) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 100
    $health = Get-ViewerHealth $candidatePort
    if ($health -and $health.searchVersion -eq 2 -and $health.rangeSearch -eq $true) {
      $selectedPort = $candidatePort
      break
    }
    if ($viewerProcess.HasExited) { break }
  }
  if ($selectedPort) { break }
}

if (-not $selectedPort) {
  throw "Session Viewer could not bind to ports $Port-$($Port + 10)."
}

$viewerUrl = "http://127.0.0.1:$selectedPort"

[pscustomobject]@{
  url = $viewerUrl
  pid = if ($viewerProcess -and -not $viewerProcess.HasExited) { $viewerProcess.Id } else { $null }
  reused = -not [bool]$viewerProcess
} | ConvertTo-Json -Compress
