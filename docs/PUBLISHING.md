# Publishing Crimsnap

This repo is set up for public GitHub releases with signed Tauri updates.

## One-time setup

1. Confirm the updater endpoint in `src-tauri/tauri.conf.json`:

   ```json
   "https://github.com/InfernoTV/crimsnap/releases/latest/download/latest.json"
   ```

2. Keep `src-tauri/updater.key` private. It is ignored by git.

3. Add GitHub repository secrets:

   - `TAURI_SIGNING_PRIVATE_KEY`: the full contents of `src-tauri/updater.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: blank for the generated local key,
     or your password if you regenerate a passworded key

4. If you want a passworded key before the first public release:

   ```powershell
   pnpm tauri signer generate --force --write-keys src-tauri\updater.key
   ```

   Copy the new public key into `src-tauri/tauri.conf.json`, then update the
   GitHub secrets with the new private key and password.

## Release flow

```powershell
git tag v0.1.0
git push origin v0.1.0
```

The workflow builds Windows artifacts and uploads:

- `crimsnap.exe`
- MSI installer
- NSIS setup exe
- `.sig` updater signatures
- `latest.json`

`latest.json` is what the in-app updater reads. Its `notes` field is extracted
from the matching version section in `CHANGELOG.md`.

## Update behavior

- Automatic checks run once every 6 hours per install.
- Manual **Check now** bypasses the local throttle.
- The changelog is shown before installation.
- Windows install mode is `passive`, so the installer runs with minimal UI.
- After installation, Crimsnap prompts for restart through Tauri's process
  plugin.
