param(
  [string]$Selection = "",
  [string]$OutCsv = ""
)

$ErrorActionPreference = "Stop"

function CsvEscape([string]$value) {
  if ($null -eq $value) { $value = "" }
  $text = [string]$value
  if ($text -match "[,\"]|\r|\n") {
    return '"' + ($text -replace '"', '""') + '"'
  }
  return $text
}

if (-not $Selection) {
  throw "--Selection is required (go_for_submission.topN.json)"
}

$selPath = Resolve-Path $Selection -ErrorAction Stop
$claims = Get-Content -Raw -LiteralPath $selPath | ConvertFrom-Json
if (-not $claims) { throw "Selection contains 0 claims: $selPath" }

if (-not $OutCsv) {
  $OutCsv = Join-Path (Split-Path -Parent $selPath) "nphies_submit_sheet.csv"
}

$rows = New-Object System.Collections.Generic.List[object]

foreach ($c in $claims) {
  $invoice = [string]$c.invoiceNumber
  $mrn = [string]$c.mrn
  $atts = @()
  if ($c.manifest -and $c.manifest.attachments) { $atts = @($c.manifest.attachments) }

  foreach ($a in $atts) {
    $rows.Add([pscustomobject]@{
      invoiceNumber = $invoice
      mrn = $mrn
      requiredType = [string]$a.requiredType
      status = [string]$a.status
      fileName = [string]$a.fileName
      filePath = [string]$a.filePath
      sha256 = [string]$a.sha256
    }) | Out-Null
  }
}

$headers = @("invoiceNumber","mrn","requiredType","status","fileName","filePath","sha256")
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add(($headers -join ",")) | Out-Null
foreach ($r in $rows) {
  $lines.Add(($headers | ForEach-Object { CsvEscape([string]$r.$_) }) -join ",") | Out-Null
}

$outDir = Split-Path -Parent $OutCsv
if ($outDir) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
$lines -join "`n" | Set-Content -LiteralPath $OutCsv -Encoding UTF8

Write-Output "Selection: $selPath"
Write-Output "Rows: $($rows.Count)"
Write-Output "CSV: $OutCsv"
