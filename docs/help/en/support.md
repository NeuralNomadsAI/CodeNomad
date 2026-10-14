# Support and source builds

Use the repository for bug reports, current releases and contributions. The [troubleshooting guide](troubleshooting.md) covers safe recovery before you report an issue.

## Report a bug {#report-a-bug}

1. Open **Settings → Info → Diagnostics**.
2. Select **Report a bug** to open the GitHub issue form.
3. Review the prefilled version/client information. Add a minimal reproduction, expected behavior and actual result, then submit through GitHub.

The action prefills CodeNomad/OpenCode versions, OS and bounded client/runtime context. It does not prefill listener addresses, workspace paths, credentials or conversation text. Opening the form is not submitting an issue.

If you need more diagnostics, **Copy to clipboard** or **Download .txt** produces a separate report. That fuller report can contain local paths and network addresses: review and redact it before attaching it. A screenshot or log excerpt can still contain secrets even when the automatic diagnostic report excludes authentication secrets.

If the GitHub form has incompatible fields, CodeNomad opens a plain issue with the same report information. A temporary failure reading the form does not prevent opening it. You can always use [the issue list](https://github.com/NeuralNomadsAI/CodeNomad/issues) manually.

## Community and releases {#community}

| Resource | Use |
| --- | --- |
| [CodeNomad repository](https://github.com/NeuralNomadsAI/CodeNomad) | Source, project activity and documentation. |
| [Issues](https://github.com/NeuralNomadsAI/CodeNomad/issues) | Search existing reports before opening a reproducible bug or feature request. |
| [Pull requests](https://github.com/NeuralNomadsAI/CodeNomad/pulls) | Review proposed changes or coordinate a contribution. |
| [Latest release](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest) | Stable download artifacts. |
| [All releases](https://github.com/NeuralNomadsAI/CodeNomad/releases) | Published previews and release notes. |
| [Neural Nomads](https://github.com/NeuralNomadsAI) | Project organization. |
| [MIT license](../../../LICENSE) | License terms. |

For issues with native OpenCode configuration rather than CodeNomad controls, consult [OpenCode's documentation](https://opencode.ai/v2/docs/) and [upstream releases](https://github.com/anomalyco/opencode/releases).

## Build from source {#build-from-source}

Use Node.js **24.20.0**, as pinned in `.node-version`, npm, Git and a compatible OpenCode CLI. Run the commands from a development checkout:

```sh
git clone --branch dev https://github.com/NeuralNomadsAI/CodeNomad.git
cd CodeNomad
npm ci --workspaces --include=optional
npm run dev
```

`npm run dev` starts the Electron development host. To use Tauri, first install its [platform build prerequisites](https://v2.tauri.app/start/prerequisites/), including the Rust toolchain, then run:

```sh
npm run dev:tauri
```

Development changes affect the development host, not an independently running OpenCode daemon's installed version. Native packaging needs the appropriate target tools; prefer builds on the target OS.

### Build and validate {#build-and-validate}

| Command, from the repository root | Purpose |
| --- | --- |
| `npm run build` | Build the Electron application resources. |
| `npm run build:tauri` | Build the Tauri application with its native prerequisites. |
| `npm run build:ui` | Build the browser UI. |
| `npm run build --workspace @neuralnomads/codenomad` | Build the standalone server and bundled assets. |
| `npm run build:linux --workspace @neuralnomads/codenomad-electron-app` | Package the Electron Debian release. |
| `npm exec --workspace @codenomad/tauri-app -- tauri build --bundles appimage` | Package a Linux Tauri AppImage. |
| `npm run typecheck` | Check the root's configured TypeScript workspaces. |
| `npm run test:help` | Validate all public-help locales and links. |
| `npm run build:help` | Build the standalone public help into `dist/help`. |

The help build does not need a running CodeNomad or OpenCode service. See [BUILD.md](../../../BUILD.md) for packaging details and [CONTRIBUTING.md](../../../CONTRIBUTING.md) for scoped validation and PR conventions; use the scripts actually present in the target package.

## Package map and contribution {#contribute}

| Package | Responsibility |
| --- | --- |
| `packages/server` | Workspace/API/Git controls, OpenCode connection, auth, events and speech. |
| `packages/ui` | SolidJS workspace, controls, localization and browser help entry point. |
| `packages/electron-app` | Electron windows, native integration and packaging. |
| `packages/tauri-app` | Tauri windows, platform integration and packaging. |
| `packages/remote-tunnel` | Backend-side OpenTunnel transport runtime. |

1. Discuss the scope in the relevant issue before implementing overlapping work.
2. Branch from `dev` and keep the change focused.
3. Run the checks for the affected area, update user help alongside behavior, and target your PR at `dev`.

Public help sources live in `docs/help/<locale>/`. Preserve each English heading's explicit ID, level and order across translations; translated headings must not break deep links. The [help maintenance contract](../../../dev-docs/USER_HELP.md) describes strict completeness checks and the static publishing pipeline.
