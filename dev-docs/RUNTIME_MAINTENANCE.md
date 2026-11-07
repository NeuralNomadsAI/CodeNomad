# Bundled runtime maintenance

- `.node-version` exactly pins CI and Tauri's bundled Node. Electron runs the
  backend with its own Node (`process.execPath`, `ELECTRON_RUN_AS_NODE=1`), so
  its Node version follows Electron. The backend also gets `ELECTRON_NO_ASAR=1`
  (`electron/main/backend-runtime.ts`): otherwise Electron's fs treats project
  `*.asar` files as archives (listed as folders, unreadable, locked on Windows).
  The backend and its server runtime child load nothing from `app.asar`; the
  server lives in `resources/server`. The shared OpenCode daemon never inherits
  either variable (`DAEMON_EXCLUDED_ENVIRONMENT`), and launchers of Electron GUI
  test apps remove both. A new application release delivers runtime changes to
  installed applications.
- `.npm-version` exactly pins both hosts' npm, independently of the Node archive,
  so fixes in npm's own dependency tree ship without waiting for a Node release
  that bundles them. `scripts/bundled-npm.cjs` downloads that registry
  package (the tarball carries npm's bundled dependencies and license), requires
  the registry's canonical tarball URL and sha512 `dist.integrity`, and extracts
  regular files and directories only. `scripts/prepare-node-runtime.cjs` places
  it where `bundledNpm()` (`opencode-update/npm-runtime.ts`) looks: beside Tauri's
  Node as in the official archive (`node_modules/npm` on Windows,
  `lib/node_modules/npm` on POSIX) or in Electron's npm-only resources
  (`node/<target>/npm`). Before writing any resources it fails when that npm's
  `engines.node` rejects the Node it will run under: `.node-version` for Tauri,
  the installed Electron executable's `process.versions.node` for Electron.
  `scripts/verify-bundled-node.cjs` checks the packaged npm version against the pin.
- npm lifecycle scripts call `node` by name. Tauri's bundled `node` answers to it
  from PATH, even though Tauri also sets `ELECTRON_RUN_AS_NODE=1`. A runtime
  executable not named `node` (Electron's) receives a temporary `node` command
  pointing to it instead. Installation and native upgrade scope it to their
  child environment and clean it after completion; interrupted installers retain
  their adapter and prefix lock for safe manual recovery. The command lives in an
  installer directory inside the npm prefix (`.codenomad-npm-*` for direct npm,
  `.codenomad-upgrade-*` beside the native upgrade's npm shim), never the system
  temporary directory, which may be mounted noexec.
- On Windows the Electron backend (a GUI-subsystem executable started with
  piped stdio) has no console, so each console program it starts without
  `windowsHide` opens its own visible console window. Every server child process
  that may start a console program sets `windowsHide: true`; a call that must not
  (a browser launch, the standalone CLI's terminal, POSIX-only commands) carries a
  `console-window: <reason>` comment, and `child-process-windows-hide.test.ts`
  enforces both. npm offers no such option for its lifecycle shell, so Electron's
  npm on Windows, and every lifecycle `node` command it runs, loads
  `hide-child-windows.cjs` from the installer directory with `--require`. That
  preload makes every asynchronous spawn hide its window: the lifecycle shell then
  gets a console without a window, which its own console children share.
  Synchronous spawns inside npm or lifecycle scripts are outside the preload and
  keep their own options.
- The packaged-resources smoke (`scripts/smoke-packaged-resources.cjs`, run by
  every Electron build and the release Linux package checks) fails unless the
  bundled npm matches `.npm-version` and its `engines.node` accepts the Node
  version the server runtime reports; npm itself only warns. `npm-lifecycle.test.ts` and the Electron step
  of the PR OpenCode compatibility matrix run real npm lifecycle scripts through
  the development Electron executable on Windows, Linux and macOS.
- Dependabot proposes Tauri crate updates weekly against `dev` from the Cargo
  workspace `packages/tauri-app`, limited to `tauri`, `tauri-build`,
  `tauri-plugin-*`, `tauri-runtime*` (also the requirements of the runtime
  regression fixture, `tests/windows-runner-refcount`) and lockfile-only `wry`
  updates: minor and patch updates in one grouped PR, each major in its own PR;
  merges are manual. Before merging, the maintainer reviews the Tauri, runtime,
  Wry, Tao and plugin release notes of every version crossed, re-qualifies the
  vendored crates (`packages/tauri-app/vendor/README.md`) and keeps
  `@tauri-apps/api` and the plugin JavaScript packages (`packages/ui/package.json`)
  on the crates' major/minor: the CLI's version check runs from
  `packages/tauri-app` and does not see them. The vendored Tao and updater are
  path patches, which Dependabot does not update;
  `packages/tauri-app/scripts/vendored-patches.test.mjs` fails a PR whose
  lockfile stops resolving them. Platform crates shared with Wry (`webview2-com`,
  `windows-core`, `webkit2gtk`, `gtk`) and with the dialog plugin (`rfd`) are
  direct dependencies on the versions Tauri and its plugins resolve; an update
  that moves them needs a manual manifest change.
- WebView2 (Evergreen runtime on Windows), WKWebView (macOS) and WebKitGTK
  (Linux) are system components updated by the operating system.
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
  with the bundled npm pin (`.npm-version`). It audits that published
  npm CLI and its bundled dependencies using an isolated temporary lockfile,
  with installation scripts disabled, separately from the application's
  dependency audit. The JSON advisory report is retained as an Actions artifact
  for seven days.
- Version lag and advisory counts need applicability review. Changing
  `.npm-version` is a manual, reviewed change.
- Failed metadata/audit requests fail the job; updates and advisories only emit
  warnings and a job summary, never an unrelated PR build gate.

Repository settings must allow GitHub Actions to create pull requests.
The audit job has read-only repository permissions. A separate trusted proposal
job requests `contents: write` and `pull-requests: write`; never add a personal
token or automatic approval.
Run `npm run check:runtime` locally for the same read-only assessment.

## Agent conventions

- Bundled runtime maintenance keeps `.node-version` and `.npm-version` exact and proposes only same-major LTS upgrades as regular, non-draft PRs without automatic merge. The scheduled npm CLI/dependency audit is warning-only. Never bundle npm from another source than the verified `.npm-version` registry package, resolve `latest` at build time, skip the engines guard, auto-fix dependencies, merge or publish from that check, or report a failed audit as clean. Application runtime changes require reviewed builds/releases.
- Documents reference `.node-version` and `.npm-version` and never restate the pinned Node or bundled npm version: maintenance updates only those files.
- Documents never restate Tauri crate or CLI versions: they point to `packages/tauri-app/Cargo.toml`/`Cargo.lock` and the `@tauri-apps/*` entries of `packages/tauri-app/package.json` and `packages/ui/package.json`. Never merge a Tauri update whose vendored crates fail re-qualification or whose `@tauri-apps/*` packages trail the crates' minor.
