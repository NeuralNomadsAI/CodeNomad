# codenomad-rs

Rust server for CodeNomad: it serves the same HTTP/SSE API as `packages/server` to the Solid UI and drives the OpenCode daemon. It runs as a remote backend, and `codenomad-rs serve [options]` honours the launch contract Tauri uses with the TypeScript server; Tauri launches it instead of the TypeScript server when started with `CODENOMAD_SERVER_IMPL=rust`, or when the selected `config.yaml` sets `server.implementation: rust` (the variable wins; any other value means TypeScript).

## Desktop host

Tauri (`cli_manager.rs`, `Runner::Rust`) runs the binary directly with the TypeScript server's arguments, environment (including `RUST_BACKTRACE=1`) and stdio contract. Packaged builds stage it as `server/codenomad-rs[.exe]` beside `server/public` (`scripts/rust-server-binary.cjs`, called by `prebuild.js`), with its debug info (`codenomad_rs.pdb`, `codenomad-rs.dSYM`; inside the binary on Linux) so release panic backtraces name files and lines. Development runs the newest `debug` or `release` build under `CARGO_TARGET_DIR` or `packages/server-rs/target`, then the staged copy. `CNRS_FIXTURE_PANIC=1` (bench only) panics at startup to check the backtrace the host logs.

## Launch

`serve` takes the reference's options and variables with its grammar and defaults (`packages/server/src/index.ts`), shares the config folder with the TypeScript server (`~/.config/codenomad`), writing each shared file in its format: `config.yaml` and `state.yaml` (`src/settings/`, the only writer, as `yaml-doc-store.ts`: whole document, other keys kept, unreadable documents refused), `config.yaml.server-id`, `instances/`, `auth.json`, `tls/` (the RSA authority is reused, RSA PKCS#1 keys), `remote-control-devices.json`, `memory/`, `permission-receipts/`. Its own files there, which the TypeScript server ignores: `session-favorites.json`, `panel-extensions.json`, `plugin-provision.json`, `git-empty-hooks/`. It prints `CODENOMAD_BOOTSTRAP_TOKEN:`, `Local Connection URL :` and `Remote Connection URL :`, stops on `codenomad:shutdown` with `CODENOMAD_SHUTDOWN_STATUS:complete|incomplete`, and answers native requests (`src/host/native_parent.rs`) when `CODENOMAD_NATIVE_PARENT=1`. Refused at start: `--launch`, `--upgrade`, a hostname or all interfaces for `--host`, HTTP on a non-loopback address. Accepted without effect: the remote UI update options, `--log-level`, `--log-destination`; `CODENOMAD_ALLOWED_ORIGINS` is not read. The HTTPS listener admits paired devices only, and the local URL is always the loopback HTTP listener.

`serve` reads `server.opencodeBinary` from the selected profile at startup. A saved custom executable takes precedence over automatic discovery; an empty selection, `opencode` or `opencode2` uses discovery.

The positional launch `codenomad-rs <root> <identity.json> <port or 0> <native-binary-label-path>` (bench and user service, `src/bench.rs`) keeps its data beside the identity file, its settings there or at `CLI_CONFIG`, and reads `CLI_UNRESTRICTED_ROOT`, `CNRS_SERVER_PASSWORD`, `CNRS_HTTPS_*` and `CNRS_TLS_*`.

## Architecture

```
UI (Solid) ──HTTP + SSE──▶ codenomad-rs ──HTTP, basic auth, loopback──▶ OpenCode daemon
   local: cookie session                    │  /instance relay, native reads, RPC to bundled plugins
   remote: paired device over HTTPS         └─ event stream ◀── daemon /api/event
```

| Path | Role |
|---|---|
| `src/main.rs` | Startup and route assembly per domain; local and HTTPS listeners |
| `src/host/` | `serve` options, stdout lines and stdin commands, native requests to the desktop host, UI bundle and dev proxy |
| `src/app.rs`, `config.rs` | Shared state and JSON error shape; production settings from the environment |
| `src/bench.rs` | Positional launch and only reader of the comparison bench variables (`CNRS_FIXTURE_*`, traces) |
| `src/meta.rs`, `service.rs`, `workspaces.rs`, `storage.rs` | Server identity, user service mode, workspace lifecycle, per-instance documents |
| `src/settings/` | `config.yaml` / `state.yaml` owners shared with the TypeScript server (merge patches, Missions conditions), server identity, OpenCode config file editor |
| `src/auth/` | Local password session (`auth.json`, bootstrap token, `/login`); paired devices, HTTPS admission, TLS |
| `src/opencode/` | Shared daemon connection, `/instance` relay, executable validation and update status, OpenCode installation and updates without Node or npm (`install/`) |
| `src/events/` | Per-session daemon event routing and per-subscriber SSE queues (4 MiB each, 32 MiB shared). Backlogs fold superseding events; overflow triggers workspace resynchronization. |
| `src/files/`, `search/`, `git/` | Project files and links, folder browser (any local folder with `--unrestricted-root`), file search, Git status/diff/history/mutations |
| `src/worktrees/` | Owned checkouts, linked worktrees, location ownership, deletion fence |
| `src/sessions/` | Pending requests, permission receipts, permission modes, favorites, history navigation |
| `src/memory/` | Agent memory: private Git store, Preferences routes, native tool bridge |
| `src/extensions/` | Panel extensions; bundled plugin provisioning, readiness, lifecycle |
| `src/subagent_depth/` | `subagent-depth` settings and JSONC edits |
| `src/sidecars/` | SideCars: `config.yaml` records, port probe and events; HTTP and WebSocket proxy (loopback listener only) |
| `src/usage.rs` | Settings › Stats: the service's native aggregate and its display cache in `state.yaml` |
| `src/provider_usage/` | Conversation Status usage: native session ownership and credential selection, a bounded provider transport and per-provider cache |
| `src/previews/` | Preview tokens, cookie-free HTTP/WS proxy and bounded document rewriting; direct HTTP(S) relay generations, isolated loopback origins and paired-device path capabilities |
| `src/missions/` | One-time and recurring Mission HTTP admission and observation, exact receipts, family controls; the bundled OpenCode plugin owns the journal and calendar execution. |
| `src/automation/` | Plugin bridge `/api/opencode-plugin/automation` and its `automation-bridges/` registration; browser and window requests forwarded to the desktop host; the server's own diagnostics ([design note](docs/automation.md)) |
| `src/host/` | Desktop host channel (`CODENOMAD_NATIVE_PARENT=1`): native requests over stdout/stdin |
| `src/shared/` | Cross-domain helpers |
| `contracts/`, `tests/fixtures/` | Frozen schemas and parity cases generated from the TypeScript server |
| `bench/` | TS/Rust comparison bench ([README](bench/README.md)) |
| `install/` | User-service install, signed updates and rollback for Windows and Linux ([README](install/README.md)) |

## Develop

```sh
cargo test --locked
cargo fmt --check
cargo build --release --locked
```

Behaviour must match `packages/server`: every change runs the matching comparison in `bench/` (`node compare.mjs <mode> <opencode>`). Parity cases are regenerated from the TypeScript sources with `bench/generate-*.mjs`.

Workspace agent controls relay native model changes, session permission replies, Form replies/cancellation and interruption. Exact pending-request reads fence settlement; native confirmation supplies durable CodeNomad permission receipts and reasons. Both backends reject malformed decisions, oversized reasons, invalid interruption options and stale requests, and revalidate the session before forwarding. `bench/agent-controls.mjs` compares these controls on separate native daemons with a held synthetic provider response; `contract` compares root/worktree placement and foreign-session refusal. The bounded Rust root proof checks the opened checkout and common Git identity without listing sibling worktrees; TypeScript already admits an owned root directly through its workspace ownership path.

Conversation permission modes share the private `sessionPermissionBlocks` state with TypeScript. Native creation and fork evidence can record copied rules; only an owned root block is rewritable, with additive deny refresh for verified copies from subagents. Sends, native events and reconnects refresh known targets; exact native deletion clears their records.

Known divergence: when a platform package does not match its registry integrity, the TypeScript server installs it anyway through `@opencode/cli`'s postinstall fallback; Rust refuses it (`bench/opencode-install.mjs`). OpenCode 1.x npm replacement is not ported: such an installation is refused.
