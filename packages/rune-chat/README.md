# Native Rune chat prototype

Windows-native Rune client for a CodeNomad conversation: a multiline composer and a virtualized, selectable transcript. The native surface palette resolves the existing dark tokens from `packages/ui/src/styles/tokens.css` at compile time. UI labels have catalogues for all ten CodeNomad locales; `RUNE_LOCALE` selects one, with French as the default.

Rune source is pinned to `21e5342b9a4cc33eeee88071b4b1f0eafb1247d4` from `https://github.com/anomalyco/rune`. `setup.ps1` installs that source under the checkout's `.prototype-deps/rune`, verifies its revision and cleanliness, and builds with Rust 1.99.1. `build.rs` checks the pin for direct Cargo builds. `Cargo.lock` fixes transitive dependencies. The root manifest applies Rune's required vendored patches.

## Build and run

Run from this isolated CodeNomad worktree:

```powershell
./packages/rune-chat/setup.ps1
./packages/rune-chat/target/debug/codenomad-rune-chat.exe
```

The default in-memory fixture opens 10,000 synthetic Unicode messages and streams a deterministic Rust code sample. Enter sends; Shift+Enter adds a line. The transcript follows its end while the reader stays at the bottom; scrolling upward holds the reading position. Select text with the pointer and copy with Ctrl+C. “Derniers messages” returns to the end. The message field grows within its height bound.

## Existing backend contract

The adapter accepts an explicit HTTP loopback endpoint in `RUNE_BACKEND`, an existing workspace in `RUNE_WORKSPACE`, and its exact session in `RUNE_SESSION`. Authentication uses an explicitly supplied `RUNE_BOOTSTRAP_TOKEN` or `RUNE_PASSWORD` and an in-memory cookie jar.

- `POST /api/auth/token` or `POST /api/auth/login`.
- `POST /api/workspaces/{workspace}/session-history/window`, with `{sessionID,target:{kind:"latest"}}`; at most 200 native message records, a 2 MiB response limit.
- `GET /api/events?clientId=…&connectionId=…`, decoding `instance.event` envelopes and native V2 `session.step.started`, `session.text.delta` and terminal execution events. Ping events receive `POST /api/client-connections/pong`.
- `POST /workspaces/{workspace}/instance/api/session/{session}/prompt`, with `{text}`.

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
