param(
  [string]$RunDir = "",
  [int]$Count = 3,
  [bool]$UniqueMrn = $true,
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"

function Get-LatestRunDir([string]$BaseDir) {
  if (-not (Test-Path -LiteralPath $BaseDir)) { return "" }
  $dirs = Get-ChildItem -LiteralPath $BaseDir -Directory -Filter "run-*" | Sort-Object Name -Descending
  if (-not $dirs) { return "" }
  return $dirs[0].FullName
}

if (-not $RunDir) {
  $base = Resolve-Path "artifacts/oracle-portal" -ErrorAction SilentlyContinue
  if (-not $base) { throw "artifacts/oracle-portal not found" }
  $RunDir = Get-LatestRunDir $base.Path
}

if (-not $RunDir -or -not (Test-Path -LiteralPath $RunDir)) {
  throw "RunDir not found: $RunDir"
}

$gatePath = Join-Path $RunDir "submission_gate.json"
$manifestPath = Join-Path $RunDir "nphies_submission_bundle_manifest.json"

if (-not (Test-Path -LiteralPath $gatePath)) { throw "Missing: $gatePath" }
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Missing: $manifestPath" }

$gate = Get-Content -Raw -LiteralPath $gatePath | ConvertFrom-Json
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

$go = @($gate | Where-Object { $_.gateStatus -eq "GO" -and $_.oracleFound -eq $true -and $_.nphiesReady -eq $true })

$manifestMap = @{}
foreach ($m in $manifest) {
  $manifestMap["$($m.invoiceNumber)|$($m.mrn)"] = $m
}

$selected = New-Object System.Collections.Generic.List[object]
$usedMrn = @{}

function TryAdd([object]$g) {
  $key = "$($g.invoiceNumber)|$($g.mrn)"
  $m = $manifestMap[$key]
  if (-not $m) { return $false }
  if ($m.resolvedAttachmentCount -lt $m.requiredAttachmentCount) { return $false }

  if ($UniqueMrn) {
    $mrnKey = [string]$g.mrn
    if ($usedMrn.ContainsKey($mrnKey)) { return $false }
    $usedMrn[$mrnKey] = $true
  }

  $selected.Add([pscustomobject]@{
    invoiceNumber = [string]$g.invoiceNumber
    mrn = [string]$g.mrn
    gateStatus = [string]$g.gateStatus
    oracleFound = [bool]$g.oracleFound
    nphiesReady = [bool]$g.nphiesReady
    manifest = $m
  }) | Out-Null
  return $true
}

foreach ($g in $go) {
  [void](TryAdd $g)
  if ($selected.Count -ge $Count) { break }
}

if ($selected.Count -lt $Count -and $UniqueMrn) {
  foreach ($g in $go) {
    $exists = $selected | Where-Object { $_.invoiceNumber -eq [string]$g.invoiceNumber -and $_.mrn -eq [string]$g.mrn }
    if ($exists) { continue }
    $UniqueMrn = $false
    [void](TryAdd $g)
    $UniqueMrn = $true
    if ($selected.Count -ge $Count) { break }
  }
}

if (-not $OutFile) {
  $OutFile = Join-Path $RunDir ("go_for_submission.top{0}.json" -f $Count)
}

$selected | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutFile -Encoding UTF8

Write-Output "RunDir: $RunDir"
Write-Output "Selected: $($selected.Count) / Requested: $Count"
Write-Output "OutFile: $OutFile"
