# codenomad-rs

Rust server for CodeNomad: it serves the same HTTP/SSE API as `packages/server` to the Solid UI and drives the OpenCode daemon. It runs as a remote backend, and `codenomad-rs serve [options]` honours the launch contract Tauri uses with the TypeScript server; Tauri launches it instead of the TypeScript server when started with `CODENOMAD_SERVER_IMPL=rust`.

## Desktop host

Tauri (`cli_manager.rs`, `Runner::Rust`) runs the binary directly with the TypeScript server's arguments, environment (including `RUST_BACKTRACE=1`) and stdio contract. Packaged builds stage it as `server/codenomad-rs[.exe]` beside `server/public` (`scripts/rust-server-binary.cjs`, called by `prebuild.js`), with its debug info (`codenomad_rs.pdb`, `codenomad-rs.dSYM`; inside the binary on Linux) so release panic backtraces name files and lines. Development runs the newest `debug` or `release` build under `CARGO_TARGET_DIR` or `packages/server-rs/target`, then the staged copy. `CNRS_FIXTURE_PANIC=1` (bench only) panics at startup to check the backtrace the host logs.

## Launch

`serve` takes the reference's options and variables with its grammar and defaults (`packages/server/src/index.ts`), keeps its files in the config folder (`~/.config/codenomad`: `config.yaml.server-id`, `auth.json`, `tls/`, `memory/`, `permission-receipts/`, plus Rust-only `devices/`, `*-ui.json`, `instance-*.json`), prints `CODENOMAD_BOOTSTRAP_TOKEN:`, `Local Connection URL :` and `Remote Connection URL :`, stops on `codenomad:shutdown` with `CODENOMAD_SHUTDOWN_STATUS:complete|incomplete`, and answers native requests (`src/host/native_parent.rs`) when `CODENOMAD_NATIVE_PARENT=1`. Refused at start: `--launch`, `--upgrade`, a hostname or all interfaces for `--host`, HTTP on a non-loopback address. Accepted without effect: the remote UI update options, `--log-level`, `--log-destination`; `CODENOMAD_ALLOWED_ORIGINS` is not read. The HTTPS listener admits paired devices only, and the local URL is always the loopback HTTP listener.

The positional launch `codenomad-rs <root> <identity.json> <port or 0> <native-binary-label-path>` (bench and user service, `src/bench.rs`) keeps its data beside the identity file and reads `CNRS_SERVER_PASSWORD`, `CNRS_HTTPS_*` and `CNRS_TLS_*`.

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
| `src/meta.rs`, `service.rs`, `workspaces.rs`, `storage.rs` | Server identity, user service mode, workspace lifecycle, UI preferences |
| `src/auth/` | Local password session (`auth.json`, bootstrap token, `/login`); paired devices, HTTPS admission, TLS |
| `src/opencode/` | Native client, `/instance` relay, cursors |
| `src/events/` | SSE to the UI through per-subscriber queues (4 MiB each, 32 MiB shared), bridge from the daemon stream. A slow subscriber's backlog folds superseding events (native deltas, usage, tool progress, storage and inventory signals); past its bound, a workspace's native events give way to `instance.eventStatus` `error` then its current status, which makes the UI re-read that workspace; an overflow no workspace explains resynchronizes every workspace and ends the stream |
| `src/files/`, `search/`, `git/` | Project files and links, file search, Git status/diff/history/mutations |
| `src/worktrees/` | Owned checkouts, linked worktrees, location ownership, deletion fence |
| `src/sessions/` | Pending requests, permission receipts, favorites, history navigation |
| `src/memory/` | Agent memory: private Git store, Preferences routes, native tool bridge |
| `src/extensions/` | Panel extensions; bundled plugin provisioning, readiness, lifecycle |
| `src/subagent_depth/` | `subagent-depth` settings and JSONC edits |
| `src/missions/` | Missions and calendar brokering (contract under revision: unchanged here) |
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
