# Bundled runtime maintenance

- `.node-version` exactly pins CI and Tauri's bundled Node. Electron runs the
  backend with its own Node (`process.execPath`, `ELECTRON_RUN_AS_NODE=1`), so
  its Node version follows Electron. `scripts/prepare-node-runtime.cjs` copies
  npm and its dependencies from the pinned official Node archive for both hosts;
  Electron requests npm-only resources. Qualify the server and that npm version
  against Electron's Node when updating either runtime. A new application release
  delivers runtime changes to installed applications.
- npm lifecycle scripts call `node` by name. Tauri's bundled `node` answers to it
  from PATH, even though Tauri also sets `ELECTRON_RUN_AS_NODE=1`. A runtime
  executable not named `node` (Electron's) receives a temporary `node` command
  pointing to it instead. Installation and native upgrade scope it to their
  child environment and clean it after completion; interrupted installers retain
  their adapter and prefix lock for safe manual recovery. The command lives in an
  installer directory inside the npm prefix (`.codenomad-npm-*` for direct npm,
  `.codenomad-upgrade-*` beside the native upgrade's npm shim), never the system
  temporary directory, which may be mounted noexec.
- The packaged-resources smoke (`scripts/smoke-packaged-resources.cjs`, run by
  every Electron build and the release Linux package checks) fails unless the
  bundled npm's `engines.node` accepts the Node version the server runtime
  reports; npm itself only warns. `npm-lifecycle.test.ts` and the Electron step
  of the PR OpenCode compatibility matrix run real npm lifecycle scripts through
  the development Electron executable on Windows, Linux and macOS.
- Dependabot checks GitHub Actions weekly and proposes updates against `dev`;
  merges are manual. Composite actions that follow their upstream
  `stable`/latest major stay on those supported references.
- **Bundled Runtime Maintenance** runs daily (07:23 UTC, subject to GitHub's
  scheduling delays) and on manual dispatch, on the default branch only.
  It selects newer LTS releases within the pinned Node major only. It never
  upgrades an installed application or OpenCode.
- A Node update creates a version-specific **regular (non-draft) PR** changing
  only `.node-version`; review and merge are manual. Events from `GITHUB_TOKEN`
  start no workflows, so a maintainer closes and reopens the PR to run
  validation. Existing proposals, including closed ones, are left alone; orphan
  branches after an uncertain API response require manual reconciliation, never
  a force-push.
- **npm is warning-only.** The check compares npm's latest published version
  with the version declared for the pinned Node release. It audits that published
  npm CLI and its bundled dependencies using an isolated temporary lockfile,
  with installation scripts disabled, separately from the application's
  dependency audit. The JSON advisory report is retained as an Actions artifact
  for seven days.
- Version lag and advisory counts need applicability review. A Node update may
  bring a newer npm from the official archive; replacing npm separately is manual.
- Failed metadata/audit requests fail the job; updates and advisories only emit
  warnings and a job summary, never an unrelated PR build gate.

Repository settings must allow GitHub Actions to create pull requests.
The audit job has read-only repository permissions. A separate trusted proposal
job requests `contents: write` and `pull-requests: write`; never add a personal
token or automatic approval.
Run `npm run check:runtime` locally for the same read-only assessment.

## Agent conventions

- Bundled runtime maintenance keeps `.node-version` exact and proposes only same-major LTS upgrades as regular, non-draft PRs without automatic merge. The scheduled npm CLI/dependency audit is warning-only: never independently replace bundled npm, auto-fix dependencies, merge or publish from that check, and never report a failed audit as clean. Application runtime changes require reviewed builds/releases.
