# TS / Rust comparison bench

## Compare with the TypeScript server

The bench starts two isolated OpenCode daemons (profile, database, synthetic provider and private folders under `bench/out/tmp/`), runs this repository's TypeScript server (`packages/server/dist`) on one and the Rust binary on the other, replays the same sequence on both and requires identical observations. Windows only (memory samples, named pipes, ACLs). It never touches the user's OpenCode daemon.

Requirements, from the repository root:

```powershell
npm ci
npm run build --workspace @neuralnomads/codenomad                       # TS server dist and bundled plugins
node --max-old-space-size=8192 packages/server-rs/bench/build-ui.mjs    # Solid UI of this checkout → bench/out/ui
cargo build --release --locked --manifest-path packages/server-rs/Cargo.toml
npx playwright install chromium                                         # or CODENOMAD_BROWSER_PATH
```

Only the `solid` mode uses that UI. It hides the features of route families a backend leaves out of `capabilities` in `/api/meta`.

Rust binary: `CODENOMAD_RS_BINARY` or `CNRS_RUST_BINARY`, else `$CARGO_TARGET_DIR/release/codenomad-rs.exe`, else `packages/server-rs/target/release/`. OpenCode: absolute path of a native OpenCode 2 executable (not an npm shim), passed as an argument.

```powershell
$OpenCode = "<absolute path>\opencode.exe"
cd packages/server-rs/bench
node compare.mjs http $OpenCode           # one mode
pwsh -NoProfile -File run-all.ps1 -OpenCode $OpenCode [-Only http,contract]   # all modes, summary and CPU load in out\summary.txt
node security.mjs $OpenCode
node hardening.mjs $OpenCode
node service.mjs $OpenCode
node opencode-install.mjs
node launch.mjs
node roundtrip.mjs $OpenCode
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
| `automation` | Scripted native parent: private bridge registration, token and ownership checks, browser and desktop command forwarding, guarded window and document selection, diagnostics. No desktop window. |
| `missions` | One-time Mission HTTP routes over the shipped plugin: creation receipts, list/map/admission, bounded content and task reads, panel, text edits, recovery refusals and deletion with session retention. |
| `missions-family` | Native coordinator and three descendants held by a loopback provider: deepest-first Stop and Pause, idle verification, queue ownership and exact receipt replay. Set `CNRS_BENCH_RS_FIRST=1` to run Rust first. |
| `sidecars` | SideCar records seeded in `config.yaml`, management and its zod and Fastify refusals; the proxy against a recording upstream: prefix modes, raw paths and queries, parsed bodies, redirects, cookies both ways, credential and routing headers, this server's own port, HTTPS without a trusted certificate, a stopped port, WebSocket handshakes and their refusals. |
| `usage` | Settings › Stats: the native service aggregate, its display cache in `state.yaml`, the restored period, query refusals, an unknown workspace. |
| `host` | Both servers with `--unrestricted-root` on equal `config.yaml`: the `config` owners read at start-up (normalization and repair, speech keys) and the `/api/meta` feed, `config/:owner` merge patches (normalization, speech key pairing, refusals, Missions conditions), the OpenCode config file editor, binary validation, the OpenCode update status and the Remote Control status (install, restart, reload and preview flags excepted), `state/ui` merge patches and refusals, the folder browser over the home and drives, folder creation and its refusals, a workspace outside the root and its files. Rust alone: lexical refusals (network, device, verbatim paths) with and without the option. |
| `providers` | Conversation Status usage against an isolated daemon with synthetic credentials. A local recorder substitutes for every provider; compares the route results and outgoing requests for each adapter. |
| `previews` | Local source previews against a loopback fixture: token creation/deletion, HTTP/WS, HTML/CSS/module rewriting, redirects, cookie and credential isolation, partial and compressed documents. |
| `remote-previews` | Remote preview generations and isolated content origins; paired browser path capabilities; HTTP and WebSocket relay, credential and origin isolation, and revocation of live streams. The TS tunnel terminates on a local fixture; no browser or desktop host starts. |
| `solid` | Real UI served by TS: HTTPS pairing of Rust, two prompts, two isolated tabs, worktree, Files, Rust memory under 48 MiB, no error toast. |
| `security.mjs` | TLS and pairing: same checks on the Rust HTTPS listener and the TS remote surface, revocation during SSE, certificate reuse and rotation. |
| `launch.mjs` | Both servers launched as Tauri launches them (same `serve` arguments and variables, private homes): stdout contract lines, bootstrap token exchange, sign-in pages and redirects, UI bundle and single-page fallback, `tls/` and identity files, stop over stdin. No OpenCode needed. |
| `roundtrip.mjs` | One private profile served by TS, then Rust, then TS on an isolated daemon and a private address (and a profile Rust creates, then TS): same TLS authority and certificates accepted by a client trusting only it, devices paired and revoked on either side, `config.yaml` and `state.yaml` byte for byte, server identity, password set by either, agent memory edited by Rust and read by TS. Needs a private IPv4 address. |
| `hardening.mjs` | Rust only: HTTPS admission under silent-socket floods, device and network paths, cross-site navigation, Git configuration guard, data folder ACL, SSE budgets. |
| `service.mjs` | The daemon lifecycle through each server's own CLI discovery, on two isolated profiles and daemon ports: start on the first workspace, discovery after a backend restart, reconnection after a daemon restart, a conversation each time; refusals of a V1 CLI, malformed CLI output and a daemon below the minimum version. |
| `opencode-install.mjs` | OpenCode installed by each server on a machine without it, in private profiles, from a loopback registry behind a token (`@opencode` scope of a private npmrc): fresh install and update compared (version, discovery by the TS functions, `.cmd`/`.ps1` shims, package.json); a substituted 2.6.0 platform package refused by Rust (TS accepts it through the package's postinstall fallback, recorded as a divergence); a foreign `opencode.exe` first in PATH (below the minimum: OpenCode 2 installed beside it and preferred, the file untouched; current: refused), a running 2.0.14 refused (`installation_in_use`), Rust and the TS functions reading every layout alike; Rust rollback, update while OpenCode runs, through an HTTP proxy, and `POST /api/opencode/update`. The account's npm prefix and user PATH must not change. Needs `rustc` for the fake binaries. |

`node host-survey.mjs $OpenCode` records every request the Solid UI makes to a TS local host (start-up, folder picker, conversation, Files, Git, worktree, recents, Settings) in `out/host-survey.json`; [HOST_ROUTES.md](HOST_ROUTES.md) classifies them. The local-host fixtures require explicit private profile and config paths outside the user's home. The `host` comparison checks the served `homePath` before navigating there.

`sidecars` serves a private static UI fixture on both servers to check the SPA fallback for unmatched paths. Set `CNRS_SIDECARS_NO_UI=1` to compare the same paths with no UI bundle. Neither run launches a window.
`CNRS_BENCH_STARTUP_TIMEOUT_MS` changes the readiness budget for `compare.mjs` when the machine is busy.

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
