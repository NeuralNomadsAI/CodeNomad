# TS / Rust comparison bench

## Compare with the TypeScript server

The bench starts two isolated OpenCode daemons (profile, database, synthetic provider and private folders under `bench/out/tmp/`), runs this repository's TypeScript server (`packages/server/dist`) on one and the Rust binary on the other, replays the same sequence on both and requires identical observations. Windows only (memory samples, named pipes, ACLs). It never touches the user's OpenCode daemon.

Requirements, from the repository root:

```powershell
npm ci
npm run build --workspace @neuralnomads/codenomad                       # TS server dist and bundled plugins
node --max-old-space-size=8192 packages/server-rs/bench/build-ui.mjs    # Solid UI with ui-capabilities.patch → bench/out/ui
cargo build --release --locked --manifest-path packages/server-rs/Cargo.toml
npx playwright install chromium                                         # or CODENOMAD_BROWSER_PATH
```

`ui-capabilities.patch` (hides panels the backend does not declare in `capabilities`, sends `expectedVersion` with writes) is not part of `packages/ui`: `build-ui.mjs` applies it to copies loaded by Vite without touching the sources. Only the `solid` mode uses that UI.

Rust binary: `CODENOMAD_RS_BINARY` or `CNRS_RUST_BINARY`, else `$CARGO_TARGET_DIR/release/codenomad-rs.exe`, else `packages/server-rs/target/release/`. OpenCode: absolute path of a native OpenCode 2 executable (not an npm shim), passed as an argument.

```powershell
$OpenCode = "<absolute path>\opencode.exe"
cd packages/server-rs/bench
node compare.mjs http $OpenCode           # one mode
pwsh -NoProfile -File run-all.ps1 -OpenCode $OpenCode [-Only http,contract]   # all modes, summary and CPU load in out\summary.txt
node security.mjs $OpenCode
node hardening.mjs $OpenCode
node launch.mjs
```

| Mode | Covers |
|---|---|
| (every mode) | Sign-in on both servers, then the Rust local admission surface (device, authority and server-pairing refusals; workspace claims, instance storage, `pending-requests`). |
| `http` | Linked worktrees: creation, session move, evacuation on deletion, refusal of a modified checkout; owned locations and VCS reads. |
| `files` | Files and Git on a rich repository (rename, gitlink, conflict, CRLF, large and binary files), mutations, refusals, watches. |
| `contract` | Session placement header, foreign sessions, outline in a worktree, `pending-requests`. |
| `depth` | `subagent-depth` on subfolders, linked worktree, junctions, written documents, worktree deletion fence. |
| `worktree-gone` | Registered worktree whose `.git` or administrative folder is gone. |
| `links` | Symbolic links and junctions (internal, outgoing, broken, loop) for read, write, diff, status and search. |
| `search` | `files/search`: queries, limits, zod refusals, folders, cache and 30 s TTL, busy scans. |
| `memory` | Agent memory: Preferences routes, automation bridge and the TS plugin client, memory store and its Git history. |
| `design` | Design request written to the pruning plugin lease according to an API 4 extension state. |
| `automation` | Automation bridge under a scripted desktop host (native requests over stdout/stdin): registration file, token and body refusals, session ownership, Missions not-owner answers, browser claim/probe/execute with the exact native requests, window status and command validation, the TS plugin's browser client; preview page actions compare their reply. Rust alone: window commands forwarded to the host (`developer.execute`), the inspected run and window pinned per conversation, refusals by stage, restart and diagnostics. |
| `host` | Both servers with `--unrestricted-root` on equal `config.yaml`: the `config` owners read at start-up (normalization and repair, speech keys) and the `/api/meta` feed, `state/ui` merge patches and refusals, the folder browser over the home and drives, folder creation and its refusals, a workspace outside the root and its files. Rust alone: lexical refusals (network, device, verbatim paths) with and without the option. |
| `solid` | Real UI served by TS: HTTPS pairing of Rust, two prompts, two isolated tabs, worktree, Files, Rust memory under 48 MiB, no error toast. |
| `security.mjs` | TLS and pairing: same checks on the Rust HTTPS listener and the TS remote surface, revocation during SSE, certificate reuse and rotation. |
| `launch.mjs` | Both servers launched as Tauri launches them (same `serve` arguments and variables, private homes): stdout contract lines, bootstrap token exchange, sign-in pages and redirects, UI bundle and single-page fallback, `tls/` and identity files, stop over stdin. No OpenCode needed. |
| `tauri-automation.mjs` | Windows real trial: `node tauri-automation.mjs <opencode.exe> <codenomad-tauri.exe>` starts an isolated daemon and the given Tauri build with `CODENOMAD_SERVER_IMPL=rust` in the same private home and profile, then runs the automation plugin's own tool code against it through the private bridge registry: inspect, type, click, screenshot, browser, restart. It stops only processes of that executable path. |
| `hardening.mjs` | Rust only: HTTPS admission under silent-socket floods, device and network paths, cross-site navigation, Git configuration guard, data folder ACL, SSE budgets. |

`node host-survey.mjs $OpenCode` records every request the Solid UI makes to a TS local host (start-up, folder picker, conversation, Files, Git, worktree, recents, Settings) in `out/host-survey.json`; [HOST_ROUTES.md](HOST_ROUTES.md) classifies them.

Results: `bench/out/<mode>.json` (TS and Rust observations, or `error`), redacted logs `out/<mode>-ts.log` / `out/<mode>-rs.log`, screenshots `out/screenshots/<mode>/`. `out/` is ignored by Git; `out/tmp/` keeps each fixture for diagnosis (about 700 MiB after a full run) and can be deleted.

Missions modes (lifecycle, families, admission, calendar, recurrences) are not part of the bench while their contract is revised. Rust still starts with its fixture Missions routes and the Missions plugin, as in the qualified configuration.

## Parity cases for unit tests

Computed by the built TypeScript server and written to `tests/fixtures/` (or the folder given as argument):

```powershell
node generate-memory-cases.mjs          # memory-cases.json
node generate-search-query-cases.mjs    # search-query-cases.json
node generate-depth-golden.mjs          # depth-golden.json
node generate-fuzzy-cases.mjs           # fuzzy-cases.json (pool drawn from the repository's paths)
node generate-contracts.mjs             # ../contracts/*.json (history and pending-requests schemas)
```
