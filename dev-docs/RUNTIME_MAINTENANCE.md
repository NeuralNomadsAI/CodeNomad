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
  package (the tarball carries npm's bundled dependencies and license) over HTTPS
  from `registry.npmjs.org`, requires the registry's canonical tarball URL and a
  matching sha512 `dist.integrity` from the same registry's metadata, and checks
  the extracted name, version, `bin/npm-cli.js` and every bundled dependency.
  That proves the bytes are what the registry publishes for that version (npm
  never reuses a published version), not an independent publisher signature.
  Extraction is the same system `tar` that unpacks POSIX Node archives
  (Windows' own `System32\tar.exe`, never a GNU tar from PATH); it refuses `..`
  members and strips a leading `/`, and the extracted tree is refused unless it holds
  only npm's `package/` directory of regular files and directories. Every entry,
  the `package/` root first, is checked with `lstat` and never followed, and a file
  with more than one hard link is refused: the archive's integrity covers its own
  bytes, so a linked root or file that would substitute host content, and every
  device, fails closed. `scripts/prepare-node-runtime.cjs` places
  it where `bundledNpm()` (`opencode-update/npm-runtime.ts`) looks: beside Tauri's
  Node as in the official archive (`node_modules/npm` on Windows,
  `lib/node_modules/npm` on POSIX) or in Electron's npm-only resources
  (`node/<target>/npm`). Before writing any resources it fails when that npm's
  `engines.node` rejects the Node it will run under: `.node-version` for Tauri,
  the installed Electron executable's `process.versions.node` for Electron
  (fetched by `npx --no install-electron`).
  `scripts/verify-bundled-node.cjs` checks the packaged npm version against the pin.
- npm scripts and their children receive temporary `npm` and `npx` commands tied
  to the selected npm package and Node runtime. Tauri's bundled `node` answers
  from PATH, even with `ELECTRON_RUN_AS_NODE=1`; an executable not named `node`
  (Electron's) also receives a temporary `node` command. Installation and native
  upgrade share these adapters, scope them to their child environment and clean
  them after completion; interrupted installers retain their adapters and prefix
  lock for safe manual recovery. The commands live in an
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
   Cargo workspace and root npm directory (`/`). Cloudflare's separate job groups
   only its related `wrangler`, `miniflare`, `workerd` and `@cloudflare/*` security
   updates; other worker fixes stay individual. Review related dependency versions
   together before merging.
- The npm roots follow actual installations: root workspaces and the separately
  installed Cloudflare release worker. The source plugin packaging manifest at
  `packages/server/src/opencode/session-pruning/package.json` is qualified with
  the plugin build: `build-session-pruning.mjs` bundles application dependencies
  from the root installation and externalizes the daemon's native SDK/Effect.
  Cargo's workspace covers its application and regression members; local vendor
  manifests and lockfiles remain under the vendored-patch qualification policy.
 - Root workspaces and the Cloudflare worker have separate npm jobs, each with a
   limit of five open version-update PRs. Routine minor/patch updates are grouped
   only by related toolchain: the Tauri family
  (`tauri`, `tauri-*`, `wry`, including the runtime regression fixture's
  `tests/windows-runner-refcount` requirements), the Electron toolchain, the
   `@tauri-apps/*` packages and the OpenCode client/schema/plugin SDK family in
   the root lockfile. Other crate and npm proposals are individual. A parent
   update can also change its transitive dependencies, so every PR needs review.
   Routine groups explicitly apply to version updates; `allow.update-types`
   controls which versions are proposed. Electron majors arrive individually.
   Every merge is manual.
 - An OpenCode SDK proposal also qualifies the independently installed source
   plugin manifest at `packages/server/src/opencode/session-pruning/package.json`
   and the native plugin's shared Effect contract. Keep the required pins aligned
   across those consumed contracts before merging.
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
  It selects newer LTS releases within the pinned Node major only, and npm's
  latest published release. It never upgrades an installed application or OpenCode.
- Each update creates a version-specific **regular (non-draft) PR** changing one
  pin only: `.node-version` (branch `maintenance/node-<version>`) or
  `.npm-version` (`maintenance/npm-<version>`); review and merge are manual.
  GitHub creates the PR Build Validation runs of a pull request opened with
  `GITHUB_TOKEN` in an approval-required state: a maintainer with write access
  selects **Approve workflows to run** on the PR, or closes and reopens it with
  their own account. The proposal rereads the pin from the default branch and
  writes nothing when it changed; existing proposals, including closed ones, are
  left alone. A proposal branch without a pull request (a run that stopped after
  creating it) fails every later run with a message naming the branch until a
  maintainer opens its PR or deletes it; maintenance never overwrites,
  force-pushes or deletes it.
- An npm release is proposed only when its `engines.node` includes both runtimes
  it would run under: `.node-version` (CI and Tauri) and the Node integrated in
  the exact Electron version of `packages/electron-app/package.json`, read from
  Electron's release index (`releases.electronjs.org/releases.json`). The npm
  proposal also requires those two files unchanged on the default branch.
  Otherwise the job warns and names the rejected runtime; updating that runtime
  first unblocks the proposal. `engines.node` is npm's declaration only: the
  proposal and the job summary state that it does not validate CodeNomad's
  behaviour, which the PR build and the maintainer's checklist establish. Major
  npm releases are proposed too, because npm ships fixes on its current major
  only, but never adopted from the engines check: their title and body say
  "maintainer qualification needed", and the body lists the breaking-change,
  lifecycle-script and fixture checks to complete before merging (the PR build
  runs first installation with the bundled npm on both hosts; install, upgrade
  and legacy-replacement fixtures against both packaged hosts run locally).
- The check audits the pinned npm CLI and its bundled dependencies, and the
  proposed npm when there is one, using an isolated temporary lockfile with
  installation scripts disabled, separately from the application's dependency
  audit. Advisories in the pinned npm are warnings; the npm proposal body
  summarizes both audits. A proposal needs its candidate's audit: when that audit
  cannot complete, the job warns and opens no npm proposal that run, while the
  Node check and the pinned audit proceed. The JSON reports are retained as one Actions artifact
  for seven days.
- Version lag and advisory counts need applicability review.
- Failed metadata requests and a failed pinned-npm audit fail the job; updates and advisories only emit
  warnings, a job summary and proposals, never an unrelated PR build gate.

Repository settings must allow GitHub Actions to create pull requests.
The audit job has read-only repository permissions. A separate trusted proposal
job requests `contents: write` and `pull-requests: write`; never add a personal
token or automatic approval.
Run `npm run check:runtime` locally for the same read-only assessment.

## Agent conventions

- Keep the `electron` devDependency an exact version. Preserve all-package security coverage with `dependency-type: all`; restrict routine majors through `allow.update-types`, with the explicit `electron` major exception. Never add package/version ignores that hide security fixes, blanket security groups or automatic merges. General-library majors and new ecosystems require a maintainer decision. Run `node --test .github/scripts/dependabot-policy.test.cjs` when editing the policy.
- Bundled runtime maintenance keeps `.node-version` and `.npm-version` exact. It proposes only same-major Node LTS upgrades and newer npm releases whose `engines.node` includes `.node-version` and the pinned Electron's Node, each as a regular, non-draft PR changing that one pin, without automatic merge; a major npm proposal says "maintainer qualification needed" in its title and body. Never present `engines.node` as behavioural validation, adopt an npm major without qualification, bundle npm from another source than the verified `.npm-version` registry package, extract it with anything but the system `tar` plus the extracted-tree check, resolve `latest` at build time, skip the engines guard, auto-fix dependencies, merge or publish from the check, overwrite or delete a proposal branch, or report a failed audit as clean. Application runtime changes require reviewed builds/releases.
- Documents reference `.node-version` and `.npm-version` and never restate the pinned Node or bundled npm version: maintenance updates only those files.
- Documents never restate Tauri crate or CLI versions: they point to `packages/tauri-app/Cargo.toml`/`Cargo.lock` and the `@tauri-apps/*` entries of `packages/tauri-app/package.json` and `packages/ui/package.json`. Never merge a Tauri update whose vendored crates fail re-qualification or whose `@tauri-apps/*` packages trail the crates' minor.
