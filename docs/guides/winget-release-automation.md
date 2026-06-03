# Winget release automation

CodeNomad publishes Winget updates from GitHub Releases with `.github/workflows/update-winget.yml`.

## Trigger

- Runs on `release.published`.
- Exits early for draft or prerelease releases.
- Waits for the expected stable Windows Tauri asset because the release record can exist before all assets finish uploading.

## Required configuration

### Repository secret

- `WINGET_GITHUB_TOKEN`: Classic GitHub PAT with `public_repo` scope.
  - The token owner must own the fork that submits to `microsoft/winget-pkgs`.
  - Komac-based submission cannot open the PR with a fine-grained token today.

### Repository variables

- `WINGET_PACKAGE_IDENTIFIER` (default fallback in workflow: `NeuralNomadsAI.CodeNomad`)
- `WINGET_FORK_OWNER` (default fallback in workflow: `pascalandr`)
- `WINGET_WINDOWS_ASSET_NAME_TEMPLATE` (default fallback in workflow: `CodeNomad-Tauri-windows-x64-{version}.zip`)
- `WINGET_ASSET_WAIT_TIMEOUT_SECONDS` (optional, default fallback: `900`)
- `WINGET_ASSET_POLL_INTERVAL_SECONDS` (optional, default fallback: `15`)

`{version}` is replaced from the release tag after trimming a leading `v`.

## Runtime flow

1. Resolve the release version from `github.event.release.tag_name`.
2. Poll the release API until exactly one uploaded asset matches the configured Windows Tauri asset template.
3. Download the matched asset once and compute a SHA-256 for logging and verification.
4. Verify the PAT owner matches `WINGET_FORK_OWNER` and that `${WINGET_FORK_OWNER}/winget-pkgs` is a fork of `microsoft/winget-pkgs`.
5. Invoke `vedantmgoyal9/winget-releaser@v2`, which uses Komac under the hood to update the existing `NeuralNomadsAI.CodeNomad` manifest and open the PR.

## Notes

- The workflow does not depend on a persistent local `winget-pkgs` clone.
- The current package in `winget-pkgs` uses the release ZIP with a nested NSIS installer, so the workflow targets the stable `CodeNomad-Tauri-windows-x64-{version}.zip` asset.
