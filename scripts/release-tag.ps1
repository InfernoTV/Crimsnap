param(
  [string]$Version,
  [string]$Remote = "origin"
)

$ErrorActionPreference = "Stop"

if (-not $Version) {
  $config = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
  $Version = $config.version
}

$tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
$plain = $tag.TrimStart("v")
$tauriVersion = (Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
$packageVersion = (Get-Content "package.json" -Raw | ConvertFrom-Json).version
$cargoVersion = (Select-String -Path "src-tauri\Cargo.toml" -Pattern '^version\s*=\s*"(.+)"').Matches[0].Groups[1].Value

if ($plain -ne $tauriVersion -or $plain -ne $packageVersion -or $plain -ne $cargoVersion) {
  throw "Version mismatch. tag=$plain tauri=$tauriVersion package=$packageVersion cargo=$cargoVersion"
}

if (git status --porcelain) {
  throw "Working tree is not clean. Commit changes before tagging."
}

if (git ls-remote --exit-code --tags $Remote "refs/tags/$tag" 1>$null 2>$null) {
  throw "Tag already exists on $Remote: $tag"
}

git push $Remote main
git tag $tag
git push $Remote $tag

Write-Host "Pushed $tag. GitHub Actions will build the release."
