param(
  [Parameter(Mandatory = $true)]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [string]$Repository,

  [string]$OutDir = "out",
  [string]$ChangelogPath = "CHANGELOG.md"
)

$ErrorActionPreference = "Stop"

$tag = $Version
$semver = $Version.TrimStart("v")

if (-not (Test-Path $OutDir)) {
  throw "Output directory not found: $OutDir"
}

$asset = Get-ChildItem $OutDir -Filter "*setup.exe" |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1

if (-not $asset) {
  $asset = Get-ChildItem $OutDir -Filter "*.msi" |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
}

if (-not $asset) {
  throw "No Windows installer found in $OutDir"
}

$sigPath = "$($asset.FullName).sig"
if (-not (Test-Path $sigPath)) {
  throw "Missing updater signature beside $($asset.Name): $sigPath"
}

$notes = "See the GitHub release notes for this update."
if (Test-Path $ChangelogPath) {
  $lines = Get-Content $ChangelogPath
  $heading = "^\s*##\s+\[?v?$([regex]::Escape($semver))\]?"
  $start = $null
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match $heading) {
      $start = $i + 1
      break
    }
  }
  if ($null -ne $start) {
    $chunk = New-Object System.Collections.Generic.List[string]
    for ($i = $start; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match "^\s*##\s+") { break }
      $chunk.Add($lines[$i])
    }
    $joined = ($chunk -join "`n").Trim()
    if ($joined.Length -gt 0) {
      $notes = $joined
    }
  }
}

$url = "https://github.com/$Repository/releases/download/$tag/$($asset.Name)"
$signature = (Get-Content $sigPath -Raw).Trim()

$latest = [ordered]@{
  version = $semver
  notes = $notes
  pub_date = (Get-Date).ToUniversalTime().ToString("o")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $signature
      url = $url
    }
  }
}

$outPath = Join-Path $OutDir "latest.json"
$latest | ConvertTo-Json -Depth 8 | Set-Content -Path $outPath -Encoding utf8
Write-Host "Wrote $outPath for $($asset.Name)"
