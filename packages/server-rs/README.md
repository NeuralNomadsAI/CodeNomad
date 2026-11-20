# codenomad-rs

Rust server for CodeNomad: it serves the same HTTP/SSE API as `packages/server` to the Solid UI and drives the OpenCode daemon. It runs as a remote backend, and the desktop hosts launch it instead of the TypeScript server when started with `CODENOMAD_SERVER_IMPL=rust`.

## Desktop hosts

Electron (`electron/main/server-impl.ts`) and Tauri (`cli_manager.rs`, `Runner::Rust`) run the binary directly with the TypeScript server's arguments, environment and stdio contract. Packaged builds stage it in `server/dist/codenomad-rs[.exe]` beside `dist/bin.js` (`scripts/rust-server-binary.cjs`, called by Electron's `prepare-resources.js` and Tauri's `prebuild.js`), so `../public` and `plugins/` resolve as for the Node entry. Development runs the newest `debug` or `release` build under `CARGO_TARGET_DIR` or `packages/server-rs/target`, then the staged copy.

## Architecture

```
UI (Solid) ──HTTP + SSE──▶ codenomad-rs ──HTTP, basic auth, loopback──▶ OpenCode daemon
   local: cookie session                    │  /instance relay, native reads, RPC to bundled plugins
   remote: paired device over HTTPS         └─ event stream ◀── daemon /api/event
```

| Path | Role |
|---|---|
| `src/main.rs` | Startup and route assembly per domain; local and HTTPS listeners |
| `src/app.rs`, `config.rs` | Shared state and JSON error shape; production settings from the environment |
| `src/bench.rs` | Only reader of the comparison bench variables (`CNRS_FIXTURE_*`, traces) |
| `src/meta.rs`, `service.rs`, `workspaces.rs`, `storage.rs` | Server identity, user service mode, workspace lifecycle, UI preferences |
| `src/auth/` | Local password session; paired devices, HTTPS admission, TLS |
| `src/opencode/` | Native client, `/instance` relay, cursors |
| `src/events/` | SSE to the UI, bridge from the daemon stream |
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
