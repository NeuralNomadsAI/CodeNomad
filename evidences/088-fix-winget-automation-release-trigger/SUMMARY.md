# Task 088 Evidence Summary

- Changed workflow files: `.github/workflows/reusable-release.yml` and `.github/workflows/update-winget.yml`.
- Changed maintainer doc: `docs/guides/winget-release-automation.md`.
- AC-1 / AC-2: stable releases now invoke Winget from `.github/workflows/reusable-release.yml` after `build-and-upload`, instead of depending on a separate `release.published` event that GitHub Actions suppresses when the release is created with `GITHUB_TOKEN`.
- AC-3: the existing `scripts/winget/resolve-release-asset.cjs` polling and hash-resolution path plus the existing `vedantmgoyal9/winget-releaser@v2` submission step were preserved.
- AC-4: the maintainer guide now documents the pipeline-coupled trigger model and the manual `workflow_dispatch` fallback for out-of-band stable releases.
- AC-5: validation covered YAML parsing, live release metadata lookups for both stable and prerelease releases, a live run of the release-asset resolver against upstream `v0.17.0`, and a `nomadworks_validate` attempt that currently fails because the validator itself crashes.

## Limitations

- No live GitHub Actions run was triggered from this environment, so end-to-end execution inside GitHub remains unverified here.
- `nomadworks_validate` is currently broken in this environment and returned `undefined is not an object (evaluating 'res.warnings.length')`.
