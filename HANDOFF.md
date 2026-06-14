# Crimsnap Handoff

This finishes the update/changelog/snap-picker pass that was interrupted.

## What changed

- Added real Tauri v2 updater support:
  - `@tauri-apps/plugin-updater`
  - `@tauri-apps/plugin-process`
  - Rust plugin initialization in `src-tauri/src/lib.rs`
  - permissions in `src-tauri/capabilities/default.json`
  - updater config in `src-tauri/tauri.conf.json`
- Added Settings -> Updates UI:
  - manual **Check now**
  - auto-check once every 6 hours
  - changelog preview before install
  - passive install progress
  - restart prompt/button after installation
  - basic handling for GitHub/API/rate-limit style errors
- Fixed the actual-screen Snap picker:
  - main window now hides instead of minimizing before opening the overlay
  - overlay no longer cancels itself on a focus/blur race
  - overlay is forced always-on-top again after positioning
- Fixed the release signing hang:
  - removed Tauri auto updater-artifact signing from `tauri build`
  - release workflow now builds normally, then explicitly runs
    `pnpm tauri signer sign ... --password=...`
  - this avoids the non-interactive "enter password" prompt that made builds
    appear to stop with no input/entry
- Added release/update publishing support:
  - `scripts/make-latest-json.ps1`
  - `CHANGELOG.md`
  - `.github/workflows/release.yml` now uploads installers, signatures, and
    `latest.json` on version tags
  - `.gitignore` now excludes the private updater key
- Added docs:
  - `docs/PUBLISHING.md`
  - README publishing/update instructions
  - install guide update behavior

## Verified

- `pnpm build` passes.
- `cargo check` passes.
- `pnpm tauri build` passes without hanging for signer input.
- Local release artifacts were created:
  - `src-tauri/target/release/crimsnap.exe`
  - `src-tauri/target/release/bundle/msi/Crimsnap_0.1.0_x64_en-US.msi`
  - `src-tauri/target/release/bundle/nsis/Crimsnap_0.1.0_x64-setup.exe`
- Local updater feed was generated in `out/latest.json`.
- Local installer signatures were generated in `out/*.sig`.

## Before publishing publicly

- Replace `yourname/crimsnap` in `src-tauri/tauri.conf.json` with the real
  GitHub `owner/repo`.
- Add GitHub secrets:
  - `TAURI_SIGNING_PRIVATE_KEY`: contents of `src-tauri/updater.key`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: blank for the current generated key,
    or the password if the maintainer regenerates a passworded key
- Push a matching version tag, for example:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

The workflow checks that the tag version matches `src-tauri/tauri.conf.json`.
