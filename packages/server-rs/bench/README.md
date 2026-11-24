# TS / Rust comparison bench

## Compare with the TypeScript server

The bench starts two isolated OpenCode daemons (profile, database, synthetic provider and private folders under `bench/out/tmp/`), runs this repository's TypeScript server (`packages/server/dist`) on one and the Rust binary on the other, replays the same sequence on both and requires identical observations. Windows only (memory samples, named pipes, ACLs). It never touches the user's OpenCode daemon.

Requirements, from the repository root:

```powershell
npm ci
npm run build --workspace @neuralnomads/codenomad                       # TS server dist and bundled plugins
node --max-old-space-size=8192 packages/server-rs/bench/build-ui.mjs    # Solid UI of this checkout → bench/out/ui
cargo build --release --locked --manifest-path packages/server-rs/Cargo.toml
cargo build --locked -p codenomad-host-process --bin codenomad-fixture-job
npx playwright install chromium                                         # or CODENOMAD_BROWSER_PATH
```

Only the `solid` mode uses that UI. It hides the features of route families a backend leaves out of `capabilities` in `/api/meta`.

Rust binary: `CODENOMAD_RS_BINARY` or `CNRS_RUST_BINARY`, else `$CARGO_TARGET_DIR/release/codenomad-rs.exe`, else `packages/server-rs/target/release/`. OpenCode: absolute path of a native OpenCode 2 executable (not an npm shim), passed as an argument.

On Windows, `compare.mjs` creates both backends and their OpenCode fixtures directly in kill-on-close jobs. `service.mjs` uses one enclosing job so the daemon can outlive an individual backend restart. The runner resolves `codenomad-fixture-job.exe` under `$CARGO_TARGET_DIR/debug/` or `target/debug/`; `CODENOMAD_FIXTURE_JOB_EXE` overrides it with an absolute path.

For `static-assets`, build the TypeScript checkout with precompression support instead of building the local TypeScript checkout in step 2. In the Rust checkout, where `packages/server/dist` is absent, run `New-Item -ItemType Junction -Path packages/server/dist -Target <absolute-reference-dist>` and then `node compare.mjs static-assets $OpenCode` from `bench/`.

```powershell
$OpenCode = "<absolute path>\opencode.exe"
cd packages/server-rs/bench
node compare.mjs http $OpenCode           # one mode
node compare.mjs prompt-admission         # simulated OpenCode, no native CLI/model
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
| (native-daemon modes) | Sign-in on both servers, then the Rust local admission surface (device, authority and server-pairing refusals; workspace claims, instance storage, `pending-requests`). |
| `http` | Linked worktrees: creation, session move, evacuation on deletion, refusal of a modified checkout; owned locations and VCS reads. |
| `receipt-worktree` | Anchored receipts in linked checkouts, including outside the browse root. Covers missing and file-valued project projections, refusal in an unrelated workspace, and inventory calls and elapsed time for repeated reads. |
| `receipt-reconnect` | Reconnect snapshots across two projects. A native reply during a held snapshot retains its original source and resources; the other project recovers before the hold is released. |
| `meta-update` | Isolated release listing: preview offers through `/api/meta`, readiness and installed-release lookup, feed changes, and stale-offer suppression. |
| `files` | Files and Git on a rich repository (rename, gitlink, conflict, CRLF, large and binary files), mutations, refusals, watches. |
| `contract` | Session placement header, foreign sessions, outline in a worktree, `pending-requests`. |
| `history-bytes` | Validated history JSON across the HTTP broker with a native RPC response at exactly 24 MiB, including numbers that expand when serialized again. |
| `history-search` | Literal and ranked history across registered checkouts, foreign-directory exclusion, and cursor continuation without admitting rows beyond its original horizon. |
| `attachment-history` | Reference-only history of large user files; digest-bound reads of inline and native blob data, ownership/undo and size refusals, and live SSE projection of a queued 255 KiB upload. Build the TypeScript reference with the attachment RPC plugin. |
| `prompt-admission` | Real TS/Rust HTTP servers, each on its own recording OpenCode substitute and `trial-*` profile. Two distinct prompt receipts, native fields forwarded intact, project file paths versus inline and remote URI, data validation, 5 MiB/file, 10 inline files, 20 MiB total and 32 MiB JSON boundaries, foreign Location/session and Mission-carrier refusals, environment-before-send, interruption controls and the ordinary 1 MiB mutation bound. Reports lengths and canonical JSON hash checks; no provider, native CLI, UI or account data. |
| `command-admission` | The same recording fixture for slash commands: transparent native fields and validation, environment before dispatch, owned attachments, Mission/foreign-session refusals and the ordinary 1 MiB body limit. |
| `workspace-claims` | Cancellation before creation, JavaScript-trimmed request IDs capped at 128 Unicode scalars across create/cancel/release, independent occurrences, released ownership and exact record cleanup; no model request. |
| `agent-controls` | Native permission decisions and durable reasons, typed stale and cross-session refusals, Form reply/cancellation, and interrupt query options against a held synthetic response and an idle session. |
| `remote-session-controls` | Local and directly paired permission/Form reads and session interruption, including native settlement and the cookie and Origin requirements. Rust terminates TLS with its fixture CA; TypeScript's direct listener verifies the configured origin behind TLS termination. |
| `static-assets` | HTML, JavaScript, style sheets, manifest and WASM served from an isolated static bundle. Negotiation, lengths, decoded bytes, HEAD and cache revalidation on the original URLs. Run explicitly with a TypeScript reference that supports static precompression. |
| `depth` | `subagent-depth` on subfolders, linked worktree, junctions, written documents, worktree deletion fence. |
| `mission-permissions` | Supervised creation and exact receipt recovery; direct child and fork provenance, additive background refresh, owned fork removal and unowned fork refusal. |
| `worktree-gone` | Registered worktree whose `.git` or administrative folder is gone. |
| `links` | Symbolic links and junctions (internal, outgoing, broken, loop) for read, write, diff, status and search. |
| `search` | `files/search`: queries, limits, zod refusals, folders, cache and 30 s TTL, busy scans. |
| `memory` | Agent memory: Preferences routes, automation bridge and the TS plugin client, memory store and its Git history. |
| `design` | Design request written to the pruning plugin lease according to an API 4 extension state. |
| `automation` | Scripted native parent: private bridge registration, token and ownership checks, browser and desktop command forwarding, guarded window and document selection, diagnostics. No desktop window. |
| `missions` | One-time Mission HTTP routes over the shipped plugin: editor branch and repository sources, creation receipts, list/map/admission, bounded content and task reads, panel, text edits, recovery refusals and deletion with session retention. |
| `missions-family` | Native coordinator and three descendants held by a loopback provider: deepest-first Stop and Pause, idle verification, queue ownership and exact receipt replay. Set `CNRS_BENCH_RS_FIRST=1` to run Rust first. |
| `missions-calendar` | Private managed daemon: exact activation and controls through HTTP and native agent tools, Code Mode principal, daily Run now and current-passage reads. |
| `missions-wayfinder` | Native Play, question answered through the authenticated Form dock, decision proof, task readout and terminal report. |
| `sidecars` | SideCar records seeded in `config.yaml`, management and its zod and Fastify refusals; the proxy against a recording upstream: prefix modes, raw paths and queries, parsed bodies, redirects, cookies both ways, credential and routing headers, this server's own port, HTTPS without a trusted certificate, a stopped port, WebSocket handshakes and their refusals. |
| `usage` | Settings › Stats: the native service aggregate, its display cache in `state.yaml`, the restored period, query refusals, an unknown workspace. |
| `host` | Both servers with `--unrestricted-root` on equal `config.yaml`: the `config` owners read at start-up (normalization and repair, speech keys) and the `/api/meta` feed, `config/:owner` merge patches (normalization, speech key pairing, refusals, Missions conditions), the OpenCode config file editor, binary validation, the OpenCode update status and the Remote Control status (install, restart, reload and preview flags excepted), `state/ui` merge patches and refusals, the folder browser over the home and drives, folder creation and its refusals, a workspace outside the root and its files. Rust alone: lexical refusals (network, device, verbatim paths) with and without the option. |
| `providers` | Conversation Status usage against an isolated daemon with synthetic credentials. A local recorder substitutes for every provider; compares the route results and outgoing requests for each adapter. |
| `provider-logins` | Owned-workspace account display metadata: fallback emails, explicit aliases, invalid emails and location refusal, with isolated synthetic credentials. |
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
`prompt-admission` compares the Source `application/json` contract, including exact error envelopes and combined budget/foreign-Location priority. It also checks a real disposable Git worktree, native carrier ownership and uncertain-read refusals, relocation during admission, malformed small JSON, `Content-Length` and chunked boundaries. `outsideJson` retains plain-stream observations separately: TypeScript's `text/plain` serialization failure returns 500 and Rust returns 400. `--transport-only` selects framing/guard probes; `--admission-order-only` selects combined budget/Location probes. Full admission uses the mode without either option. This mode writes its proof and redacted child logs under a fresh `out/trial-prompt-admission-*` directory.
`CNRS_BENCH_STARTUP_TIMEOUT_MS` changes the readiness budget for `compare.mjs` when the machine is busy.
Set `CNRS_BENCH_MISSIONS_SERVE=1` on Windows to compare `missions` or `missions-calendar` with Rust's production `serve` contract. `missions-wayfinder` uses it by default. The packaged plugins and CLI shim are bound to the owned fixture daemon, with no Tauri window.

For `missions-calendar`, `CNRS_BENCH_MISSIONS_ENABLE_IN_PROJECT=1` qualifies the write to enable a missing Automations flag. Run in `serve` and name an existing private `CODENOMAD_NATIVE_FIXTURE_PARENT` outside the user home and all OpenCode configuration ancestors.

On Windows, set `TEMP` and `TMP` to a private directory outside the account's home and run
`node packages/server-rs/bench/missions-human.mjs <OpenCode exe> <Rust exe> <packages/server/dist/plugins>`
with absolute paths. This headless fixture copies OpenCode, uses a local scripted provider and
checks that a session Form reply settles once and only a confirmed UI mark qualifies for ordinary Wayfinder.

Results: `bench/out/<mode>.json` (TS and Rust observations, or `error`), redacted logs `out/<mode>-ts.log` / `out/<mode>-rs.log`, screenshots `out/screenshots/<mode>/`. `out/` is ignored by Git; `out/tmp/` keeps each fixture for diagnosis (about 700 MiB after a full run) and can be deleted.

## Parity cases for unit tests

Computed by the built TypeScript server and written to `tests/fixtures/` (or the folder given as argument):

```powershell
node generate-memory-cases.mjs          # memory-cases.json
node generate-search-query-cases.mjs    # search-query-cases.json
node generate-depth-golden.mjs          # depth-golden.json
node generate-fuzzy-cases.mjs           # fuzzy-cases.json (pool drawn from the repository's paths)
node generate-contracts.mjs             # ../contracts/*.json (history and pending-requests schemas)
node generate-login-start.mjs           # login-start.json (Windows task, Linux unit, macOS plist)
```
