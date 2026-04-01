param(
  [string]$RepoRoot = ".",
  [string]$RunDir = "",
  [int]$ScannerPid = 0,
  [int]$PollSeconds = 60
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot([string]$root) {
  if ([System.IO.Path]::IsPathRooted($root)) {
    return (Resolve-Path $root).Path
  }
  return (Resolve-Path (Join-Path (Get-Location) $root)).Path
}

function Get-LatestRunDir([string]$repoRoot) {
  $base = Join-Path $repoRoot "artifacts\oracle-portal"
  if (-not (Test-Path $base)) {
    throw "Artifacts directory not found: $base"
  }

  $latest = Get-ChildItem $base -Directory -ErrorAction Stop |
    Where-Object { $_.Name -like "run-*" } |
    Sort-Object Name -Descending |
    Select-Object -First 1

  if (-not $latest) {
    throw "No run-* directory found under $base"
  }
  return $latest.FullName
}

function Wait-ScannerExit([int]$processId, [int]$pollSeconds) {
  if ($processId -le 0) { return }
  while ($true) {
    $p = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $p) { break }
    Start-Sleep -Seconds $pollSeconds
  }
}

$repo = Resolve-RepoRoot $RepoRoot
Set-Location $repo

if (-not $RunDir) {
  $RunDir = Get-LatestRunDir $repo
} elseif (-not [System.IO.Path]::IsPathRooted($RunDir)) {
  $RunDir = Join-Path $repo $RunDir
}

Wait-ScannerExit -processId $ScannerPid -pollSeconds $PollSeconds

$manifest = Join-Path $RunDir "nphies_submission_bundle_manifest.json"
if (-not (Test-Path $manifest)) {
  throw "Manifest not found: $manifest"
}

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$logDir = Join-Path $repo "artifacts\oracle-portal\finalize-logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$pkgLog = Join-Path $logDir "package_$timestamp.log"
$queueLog = Join-Path $logDir "manual_queue_$timestamp.log"

node scripts\package-nphies-ready-submissions.mjs --manifest $manifest --payload nphies_normalized_submissions.json --output-dir nphies_upload_package *> $pkgLog
node scripts\build-manual-retrieval-queue.mjs --manifest $manifest --output-json manual_retrieval_queue.json --output-csv manual_retrieval_queue.csv *> $queueLog

Write-Output "Finalization complete."
Write-Output "Run dir: $RunDir"
Write-Output "Manifest: $manifest"
Write-Output "Package log: $pkgLog"
Write-Output "Queue log: $queueLog"
