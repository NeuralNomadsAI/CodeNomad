# Native Rune chat prototype

Windows-native Rune client for opening a CodeNomad project, choosing or creating a session, and sending messages through a multiline composer and a virtualized, selectable transcript. The native surface palette resolves the existing dark tokens from `packages/ui/src/styles/tokens.css` at compile time. UI labels have catalogues for all ten CodeNomad locales; `RUNE_LOCALE` selects one, with French as the default.

Rune source is pinned to `21e5342b9a4cc33eeee88071b4b1f0eafb1247d4` from `https://github.com/anomalyco/rune`. `setup.ps1` installs that source under the checkout's `.prototype-deps/rune`, verifies its revision and cleanliness, and builds with Rust 1.99.1. `build.rs` checks the pin for direct Cargo builds. `Cargo.lock` fixes transitive dependencies. The root manifest applies Rune's required vendored patches.

## Build and run

Run from this isolated CodeNomad worktree:

```powershell
./packages/rune-chat/setup.ps1
./packages/rune-chat/target/debug/codenomad-rune-chat.exe
```

The initial screen connects to an already-running Rust server using its loopback address and password. Open a folder with Browse or an absolute path, select a session by title, or enter a title and Create. Project and session identifiers are resolved by the client. The session list loads 200 records per request, with More sessions and a filter over loaded titles. Sessions returns to that folder after the reply finishes and the composer is empty. A failed creation offers Refresh to reconcile its outcome before another creation.

Enter sends; Shift+Enter adds a line. The transcript follows its end while the reader stays at the bottom; scrolling upward holds the reading position. Select text with the pointer and copy with Ctrl+C. “Derniers messages” returns to the end. The message field grows within its height bound. `--scene synthetic` opens the independent 10,000-message memory fixture and deterministic streaming reply.

The launcher keeps credentials and navigation state in process memory. Its workers serialize opening actions away from the UI thread. Each session binding owns separate display/command channels and a fresh SSE client identity; returning releases the old binding. Empty newly created sessions use the bounded native message endpoint. Existing histories use the history plugin contract below.

## Agent conventions

Keep native UI state, opening actions, API transport and rendering in their dedicated modules. Every visible label belongs in the ten-locale catalogues. Reuse the Rust workspace and native session contracts with exact folder scope and opaque cursors. Keep project/session creation explicit and never automatically repeat an uncertain mutation. Background verification uses the real Rune Runtime and scripted file-dialog results; never open a desktop window from a probe.

## Background opening qualification

```powershell
node packages/rune-chat/launcher-fixture.mjs
node packages/rune-chat/launcher-fixture.mjs --uncertain-create
node packages/rune-chat/launcher-fixture.mjs --with-tools
```

These commands run the actual Rust server against synthetic OpenCode, then exercise the real Rune widgets without a window. They cover login and folder errors, folder-dialog selection/cancellation, catalog continuation, existing history, unsent-draft retention, creation, two distinct streaming sends and return to the original session. The second injects an error after native creation and checks reconciliation with exactly one created session. The third qualifies historical and live tool blocks, running/completed states and text streaming. Set `RUNE_TEST_GIT_COUNT=143` to exercise a Git project with a large native checkout inventory and verify that root sends avoid sibling enumeration.

## Native tool blocks

Assistant content keeps its native text/tool order. Each tool shows its name and preparation, running, completed or error state. Details reveals its input and textual output/error. Tool input/output first renders 10,000 characters with Show all; retained fields are bounded to 256 KiB with an explicit limited-output label. History and reconnection rebuild blocks from native records, while scoped tool events trigger authoritative refreshes. Loaded tool data stays passive.

`interactive-live.mjs <absolute-project-folder> <existing-session-title>` explicitly opens a Windows window against the installed service and an owned Rust backend. It forks the selected long real session, denies tools on the copy, and observes test responses without modifying the original conversation. Its exact-title new-session guard applies tool denial before sending from the test's newly created session. The French test journal separates the interactive observations, fixes, and remaining qualification. Model choice, permission/question controls, interruption and persisted tabs/drafts are the next client milestone.

## Existing backend contract

`RUNE_BACKEND` and `RUNE_PASSWORD` can prefill the connection fields. Supplying `RUNE_WORKSPACE` and `RUNE_SESSION` explicitly selects a session for contract fixtures and direct launches. Authentication uses an explicitly supplied `RUNE_BOOTSTRAP_TOKEN` or `RUNE_PASSWORD` and an in-memory cookie jar.

- `POST /api/auth/token` or `POST /api/auth/login`.
- `GET /api/workspaces` and `POST /api/workspaces` with an absolute `{path}`.
- `GET /workspaces/{workspace}/instance/api/session?directory=…&limit=200`, then cursor-only continuation; `POST` to the same path with `{title,location:{directory}}` creates a root session. Exact native reads validate a session before binding.
- `POST /api/workspaces/{workspace}/session-history/window`, with `{sessionID,target:{kind:"latest"}}`; at most 200 native message records, a 2 MiB response limit.
- `GET /api/events?clientId=…&connectionId=…`, decoding `instance.event` envelopes and native V2 `session.step.started`, `session.text.delta` and terminal execution events. Ping events receive `POST /api/client-connections/pong`.
- `POST /workspaces/{workspace}/instance/api/session/{session}/prompt`, with `{text}`.

Fresh-session reads request `order=asc` and compare their final native ID with a separate latest-message read. Native cursors also anchor future reads, so a present continuation alone does not establish overflow.

The subscription opens before enabling Send. Workspace and session IDs fence event admission. HTTP redirects are refused, requests use explicit loopback addresses and the adapter bounds each SSE frame to 256 KiB. Missing history capability and disconnected streams put the composer into its connection-failure state.

## History pagination and recovery

“Messages précédents” requests the exact server-provided `before` cursor. Adjacent native windows overlap by 16 rows. The client validates ordered overlap, merges by stable native ID, and keeps Rune's visible-row anchor while prepending. Failed pages retain their display and cursor for an explicit retry.

SSE connections have process-specific client IDs and generation-specific connection IDs. A broken connection is retried with capped backoff; native `instance.eventStatus` changes also invalidate the display's connection state. Recovery rereads the resident range from its first native anchor through bounded `around` and `after` windows. The client checks connection generation and event activity before publishing. Rows installed by an authoritative read suppress ambiguous delayed deltas and receive a subsequent authoritative repair. The latest native session busy/idle state settles the composer. Prompt POSTs are sent once.

Prototype bounds are 200 rows and 2 MiB per response, 2,048 resident rows / 8 MiB of text, 16 recovery continuation reads, and 256 KiB per live text row / SSE event. Missing anchors, broken overlap, exhausted limits and scope changes retain the last readable snapshot and disable new sends. A bounded exact-session read supports the explicitly created empty-session mode up to 200 rows; its retained first anchor must remain present.

The background-only qualification uses a separately named executable, leaving open demo executables intact:

```powershell
cargo +1.99.1 build --locked --bin codenomad-rune-recovery --manifest-path packages/rune-chat/Cargo.toml
cargo +1.99.1 test --locked --bin codenomad-rune-recovery --manifest-path packages/rune-chat/Cargo.toml -- --skip selects_code_and_routes_copy_to_memory_clipboard
node packages/rune-chat/recovery-fixture.mjs
```

`recovery-fixture.mjs` runs the real Rust server against a synthetic OpenCode service behind an owned loopback fault proxy. `--probe-recovery` uses the actual Rune `Runtime` and view without creating a window or accessing global input or the clipboard. It checks pagination, failed-page retention, late-response fencing, SSE interruption, delayed duplicate deltas, upstream generation changes, and a missing anchor. The French [test journal](JOURNAL_TESTS.md) records commands, observed results and qualification limits.

## Verification fixtures

```powershell
cargo +1.99.1 test --locked --manifest-path packages/rune-chat/Cargo.toml
node packages/rune-chat/fixture.mjs --probe-contract
cargo +1.99.1 build --locked --manifest-path packages/server-rs/Cargo.toml
node packages/rune-chat/rust-fixture.mjs
```

The Rune tests use the actual runtime and components. They exercise 10,000 messages with bounded mounted elements, scrolling, the bottom action, multiline submission, two consecutive sends with distinct responses, streaming Unicode, pointer selection of an exact multiline code sample, and Ctrl+C into Rune's memory clipboard. The memory clipboard keeps these tests independent of the OS clipboard.

`fixture.mjs` supplies the CodeNomad HTTP/SSE shapes. `rust-fixture.mjs` launches this checkout's actual Rust server, authenticates, opens an owned synthetic folder, and routes history, prompt and streaming through that server to a synthetic OpenCode HTTP service. Its child environment is restricted to Windows system variables plus private profile paths under `fixture-profile/`. It supplies fake credentials, ephemeral loopback ports, a Git ceiling, and fixture-native endpoints. Shutdown targets its owned child processes. This fixture requires the locally built Rust server executable.

Both contract probes assert 200 history records and two consecutive prompts with unique response IDs, distinct content and multiple Unicode-safe fragments. Fixture responses include their turn and prompt. `node packages/rune-chat/rust-fixture.mjs --window` opens the client against the isolated Rust fixture until its window is closed. The standalone `fixture.mjs` opens a window when launched without arguments. Set `RUNE_CLIENT_EXE` to select the separately built `target/debug/codenomad-rune-live.exe` while the stress-test executable stays open.

## Live OpenCode test

`cargo +1.99.1 build --locked --bin codenomad-rune-live --manifest-path packages/rune-chat/Cargo.toml` builds a separate executable, allowing the stress window to stay open. `node packages/rune-chat/live.mjs` connects to the installed OpenCode V2 service, creates a disposable empty Git project under `fixture-profile/`, and creates an exact new session with the native deny-all permission rule. It launches an owned Rust server with a private profile and an identifiable `Code Nomad · Rune · OpenCode V2` window. The existing service's authentication is held in process memory. Its service and account configuration remain managed by their existing owner.

The explicit `RUNE_EMPTY_SESSION=1` launch path verifies that the exact native session's message list is empty before enabling Send. It uses the native empty-session read independently of the history plugin. Existing sessions continue to use the bounded history-window path. The live observer filters by the exact newly created workspace and session, counts text-delta frames and tool events, and prints one summary at each native execution terminal event. Closing the live window shuts down its owned Rust server; the independently running OpenCode service remains active.

`real-history-prepare.mjs`, `real-history-seed.mjs` and `real-history-fixture.mjs` qualify a real native history entirely in the background. They install the existing history plugin only in a disposable project's `.opencode/plugins`, import 600 synthetic archives through OpenCode's native API, page them through the real Rust server, and cut only the test client's SSE during a real model response. `real-history-cleanup.mjs` verifies and removes the two owned test sessions. The test journal provides the exact commands and observed results. This protocol requires the already-installed dependencies in `D:/CodeNomad/node_modules` and the existing OpenCode service's working model access.

For a reproducible offline image:

```powershell
./packages/rune-chat/target/debug/codenomad-rune-chat.exe --scene synthetic --snap packages/rune-chat/evidence/synthetic.png --tree packages/rune-chat/evidence/tree.json
```

## Prototype scope

The adapter opens the latest bounded history window and supports older pages plus authoritative recovery after stream interruptions. The offline stress fixture supplies the complete 10,000-row synthetic collection independently of the connected resident bound. Markdown is displayed as selectable text; Rust-looking code and fenced samples use a monospace style. Concurrent writers during sustained traffic, complete fragment-level reconciliation, tool rendering, cancellation, model selection, persistent preferences and project discovery remain qualification or integration work. The upstream OpenCode service and model response in `rust-fixture.mjs` and `recovery-fixture.mjs` are synthetic. `live.mjs` uses the existing real service on its newly created disposable session. Interactive Windows checks and background runtime tests have separate evidence in the test journal.

## Agent conventions

Keep this package isolated from the shipped hosts. Use explicit synthetic profile paths and owned process handles for fixtures. Preserve the Rust server's consumed HTTP/SSE contract and Rune's dependency pin. Extend the native catalogue for every supported locale when adding UI labels.
