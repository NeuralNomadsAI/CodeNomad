# Bundled runtime maintenance

- `.node-version` exactly pins CI and Tauri's bundled Node. Electron runs the
  backend with its own Node (`process.execPath`, `ELECTRON_RUN_AS_NODE=1`), so
  its Node version follows Electron. The backend also gets `ELECTRON_NO_ASAR=1`
  (`electron/main/backend-runtime.ts`): otherwise Electron's fs treats project
  `*.asar` files as archives (listed as folders, unreadable, locked on Windows).
  The backend and its server runtime child load nothing from `app.asar`; the
  server lives in `resources/server`. The shared OpenCode daemon never inherits
  either variable (`DAEMON_EXCLUDED_ENVIRONMENT`), and launchers of Electron GUI
  test apps remove both. `scripts/prepare-node-runtime.cjs` copies
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
  bundled npm's `engines.node` accepts the Node version the server runtime
  reports; npm itself only warns. `npm-lifecycle.test.ts` and the Electron step
  of the PR OpenCode compatibility matrix run real npm lifecycle scripts through
  the development Electron executable on Windows, Linux and macOS.
- Dependabot covers every dependency of the Cargo workspace `packages/tauri-app`
  and of the npm workspaces (root lockfile), plus the Cloudflare deployment worker
  (`packages/cloudflare`, separate lockfile), with weekly version checks against
  the default branch (`dev`). Keep `target-branch` omitted for npm and Cargo so
  security updates share the configuration. Each entry's `allow` rule uses
  `dependency-type: all` and permits routine minor/patch updates; Cargo includes
  transitive crates. npm additionally allows
  `electron` major proposals to keep supported runtime majors visible. Other
  routine major migrations require an explicit maintainer decision.
  [`allow.update-types`](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#update-types-allow)
  filters version updates only: security fixes remain eligible for every package,
  including fixes requiring a major. Matching allow rules combine their permitted
  update types. Security PRs target the default branch (`dev`) as advisories arise.
  The explicit `tauri-security` (`tauri`, `tauri-*`, `wry`) and `fastify-security`
  (`fastify`, `@fastify/*`) families group related fixes at every SemVer level;
  unmatched dependencies receive individual PRs. These
  [security group rules](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-security-updates#grouping-dependabot-security-updates-into-a-single-pull-request)
  take priority over repository/organization blanket grouping for the configured
  Cargo workspace and npm directories (`/`, `/packages/cloudflare`). Site-level
  grouping can still apply to other directories. Review related dependency
  versions together before merging.
- The npm roots follow actual installations: root workspaces and the separately
  installed Cloudflare release worker. The source plugin packaging manifest at
  `packages/server/src/opencode/session-pruning/package.json` is qualified with
  the plugin build: `build-session-pruning.mjs` bundles application dependencies
  from the root installation and externalizes the daemon's native SDK/Effect.
  Cargo's workspace covers its application and regression members; local vendor
  manifests and lockfiles remain under the vendored-patch qualification policy.
- Routine minor/patch updates are grouped by toolchain: the Tauri family
  (`tauri`, `tauri-*`, `wry`, including the runtime regression fixture's
  `tests/windows-runner-refcount` requirements), the Electron toolchain, the
  `@tauri-apps/*` packages, then every other crate or npm dependency; minor and
  patch updates of a group arrive together. The first matching group wins, so the
  remaining-dependency catchalls follow the toolchain groups. Routine groups
  explicitly apply to version updates; `allow.update-types` controls which
  versions are proposed. Electron majors arrive individually. Every merge is manual.
- For a Tauri crate update, the maintainer reviews the Tauri, runtime, Wry, Tao
  and plugin release notes of every version crossed, re-qualifies the
  vendored crates (`packages/tauri-app/vendor/README.md`) and keeps
  `@tauri-apps/api` and the plugin JavaScript packages (`packages/ui/package.json`)
  on the crates' major/minor: the CLI's version check runs from
  `packages/tauri-app` and does not see them. Dependabot's npm entry proposes the
  `@tauri-apps/*` packages in their own grouped PR (`tauri-js`); merge it with
  the matching cargo `tauri` PR so the packages never trail the crates' minor. The vendored Tao and updater are
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
- Electron's integrated Node is the Electron backend runtime, so the exact
  `electron` pin (`packages/electron-app/package.json`) selects it. Dependabot
  proposes Electron toolchain updates (`electron`, `electron-builder`,
  `electron-vite`) weekly against `dev`: minor and patch updates in the
  `electron-toolchain` group, and `electron` majors individually.
  Keep the pin within Electron's supported majors (the latest three). Before
  merging, the maintainer qualifies the upstream breaking changes of every major
  crossed (<https://www.electronjs.org/docs/latest/breaking-changes>) and its
  platform minimums against the declared ones (`BUILD.md`, `docs/help`), and the
  update passes the existing CI: the real-Electron tests, the Electron-mode
  first-installation fixture and the npm `engines` smoke check of every build.
- The `electron` package downloads its binary on first use. CI jobs that run or
  package Electron fetch it right after `npm ci` with `npx --no install-electron`,
  before parallel tests or command substitutions read its path; the Electron
  app's `dev` and `preview` scripts and `scripts/dev.sh` run it first.
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

- Keep the `electron` devDependency an exact version. Preserve all-package security coverage with `dependency-type: all`; restrict routine majors through `allow.update-types`, with the explicit `electron` major exception. Never add package/version ignores that hide security fixes, blanket security groups or automatic merges. General-library majors and new ecosystems require a maintainer decision. Run `node --test .github/scripts/dependabot-policy.test.cjs` when editing the policy.
- Bundled runtime maintenance keeps `.node-version` exact and proposes only same-major LTS upgrades as regular, non-draft PRs without automatic merge. The scheduled npm CLI/dependency audit is warning-only: never independently replace bundled npm, auto-fix dependencies, merge or publish from that check, and never report a failed audit as clean. Application runtime changes require reviewed builds/releases.
- Documents reference `.node-version` and never restate the pinned Node or bundled npm version: maintenance updates only that file.
- Documents never restate Tauri crate or CLI versions: they point to `packages/tauri-app/Cargo.toml`/`Cargo.lock` and the `@tauri-apps/*` entries of `packages/tauri-app/package.json` and `packages/ui/package.json`. Never merge a Tauri update whose vendored crates fail re-qualification or whose `@tauri-apps/*` packages trail the crates' minor.
