param(
  [string]$Repository = "InfernoTV/Crimsnap",
  [string]$KeyPath = "src-tauri\updater.key",
  [string]$Password = ""
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI is not installed. Install gh or add the secrets in GitHub's web UI."
}

gh auth status 1>$null

if (-not (Test-Path $KeyPath)) {
  throw "Missing private updater key: $KeyPath"
}

Get-Content -Raw $KeyPath | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo $Repository --body-file -
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo $Repository --body $Password

Write-Host "GitHub Actions secrets are set for $Repository."
