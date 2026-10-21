# Bundled runtime maintenance

- `.node-version` remains an exact pin shared by CI and both desktop packages.
  `scripts/prepare-node-runtime.cjs` copies npm, including its dependencies,
  from that official Node archive. A new application release is required to
  deliver any runtime change to installed applications.
- Dependabot checks GitHub Actions weekly and proposes updates against `dev`.
  No automatic merge is configured. Composite actions already following their
  upstream `stable`/latest major remain on those supported references.
- **Bundled Runtime Maintenance** runs daily (07:23 UTC, subject to GitHub's
  scheduling delays) and on manual dispatch, on the default branch only.
  It selects newer LTS releases within the currently pinned Node major, not
  a new major. It never upgrades an installed application or OpenCode.
- A Node update creates a version-specific **regular PR**, not a draft, changing
  only `.node-version`. Review and merge remain manual. Events created with
  `GITHUB_TOKEN` do not automatically start another workflow; a maintainer can
  close and reopen the PR to trigger validation.
  Existing proposals, including closed ones, are left alone; orphan branches
  after an uncertain API response require manual reconciliation, not force-push.
- **npm is warning-only.** The check compares npm's latest published version
  with the version declared for the pinned Node release. It audits that published
  npm CLI and its bundled dependencies using an isolated temporary lockfile,
  with installation scripts disabled. This is separate from the application's
  dependency audit and is not a byte-for-byte scan of installed desktop files.
  The JSON advisory report is retained as an Actions artifact for seven days.
- Version lag and advisory counts need applicability review. A Node update may
  bring a newer npm from the official archive; replacing npm separately is manual.
- Failed metadata/audit requests fail the job; updates and advisories only emit
  warnings and a job summary, never an unrelated PR build gate.

Repository settings must allow GitHub Actions to create pull requests.
The audit job has read-only repository permissions. A separate trusted proposal
job requests `contents: write` and `pull-requests: write`; no personal token or
automatic approval is configured.
Run `npm run check:runtime` locally for the same read-only assessment.

## Agent conventions

- Bundled runtime maintenance keeps `.node-version` exact and proposes only same-major LTS upgrades as regular, non-draft PRs without automatic merge. The scheduled npm CLI/dependency audit is warning-only: never independently replace bundled npm, auto-fix dependencies, merge or publish from that check. Audit failure is not a clean assessment; application runtime changes require reviewed builds/releases.
