# Rune application

Native Rune client for CodeNomad, replacing the Solid UI and the Tauri host module by module. It runs on the desktop and, built for `wasm32-unknown-unknown`, in a browser for remote and mobile access. It talks to `codenomad-rs` through the same HTTP/SSE API as the Solid UI.

## Code style

- The module tree explains the program: one folder per domain (`chat/`, `composer/`, `sessions/`, `git/`, `settings/`…), each holding its state, actions and views. No flat `src/` with name prefixes. Probes and fixtures live in `tests/` or a separate binary, never in the shipped one.
- Short, dense code over verbose code: one dense page beats ten wordy ones. Comments only for a non-obvious why.
- Plain functions and data, as in Tauri's Rust. No trait towers, gratuitous generics or lifetimes, home-made macros or abstraction without a second caller.
- Reuse before writing: `rune-kit`, then Rune, the standard library, an established crate, existing CodeNomad code.
- No `unwrap`/`expect` on data from the network, disk or user: a bad value shows an error state, never a crash.
- Before writing, ask in order and stop at the first yes: can the product make it unnecessary; is it already covered; does one line do; only then write the minimum. Fix bugs at their root, once, for every caller.

## UI rules

1. **No style value in application code.** Colours, sizes, radii, spacing, type and motion come from the theme, generated from `packages/ui/src/styles/tokens.css` at build time. CI rejects style literals outside the theme crate.
2. **Never adapt a component for one use.** A screen that needs something different gets a reviewed variant or option of the shared component.
3. **Screens only assemble components**, `rune-kit` first, otherwise a shared CodeNomad component. Logic lives in state, not in views.
4. **Text comes from the existing catalogues** (`packages/ui/src/lib/i18n/messages/<locale>`, ten locales), generated at build time; never written in Rust.
5. **Accessibility is complete**: role, name and state on every interactive element.

Kit builders consume the mapped `Kit` directly. Keep visual configuration before `build(kit)` through public builder options and reviewed shared-theme variants; never restyle the resulting control. `Kit` exposes palette, typography, radii, elevation and motion. Component spacing and several dimensions are fixed inside the pinned kit; [Rune issue 573](https://github.com/anomalyco/rune/issues/573) tracks theme-owned component metrics. Source geometry qualification remains required for those controls. Use the public kit components for fields, selectors, menus, dialogs, tabs, shell regions and document renderers as their owning modules are assembled.

`TextInput` and `TextArea` use the cached `field_kit` variant, whose base surface resolves to `surface-field` before building. The general Kit retains the canvas role for reading components.

## Platform

- Shared code builds for native and `wasm32-unknown-unknown`; CI builds both.
- The API client is asynchronous with an interchangeable transport (native HTTP/SSE; browser `fetch`/`EventSource`). No blocking I/O or threads in shared code.
- Desktop-only features (server launch, local files, system notifications, clipboard, windows, updates) sit behind a platform interface with a web implementation.
- Layouts adapt to phone, tablet and desktop, with touch input.

## Conversion

Each Solid component or module is converted as is, then simplified:

1. A sheet generated from the Solid source: props, states, tokens, i18n keys, tests, uses.
2. Port with kit primitives and the theme only.
3. Parity: Solid fixture screenshot against Rune's headless PNG (light and dark, with a threshold), accessibility tree, scripted interaction test.
4. Simplify: merge duplicates, drop unused props and states, move logic to state.
5. Two fresh blind reviews; a blocking or medium finding needs a failing test.

When a whole module reaches parity, its Solid and Tauri version is deleted on `feat/rust-server`. If `dev` later changes a deleted file, the change is ported to the Rune twin; the file is never restored. The [correspondence table](#correspondence) records each pair.

## Correspondence

| Solid / Tauri | Rune | State |
|---|---|---|
| HTTP, SSE, pagination and recovery | CodeNomad API and contract fixtures | `crates/codenomad-client`: native contracts, 606-row recovery and authenticated browser session reading qualified |
| Workspace file listing and preview API | Solid `api-client.ts`, shared server Files routes | `crates/codenomad-client/files`: typed bounded reads, identities and bytes qualified through HTTP fixtures and Windows shared Rust with private files; browser execution and interface qualification pending |
| Workspace file tree state | `useWorkspaceTree.ts`, `WorkspaceTree.tsx` | `files/`: lazy snapshots, scoped cancellable reads, refresh coalescing and physical-subtree invalidation; native contracts exercised. `platform/collation` owns stable ICU/Intl sorting, with actual Rust WASM exercised in six browser locales under CSP. Windows/macOS/Linux shared-Rust filesystem watches and hidden-tab state exercised with simulated OpenCode; UI assembly, live reconnect and physical replacement remain pending |
| Workspace tree row | `WorkspaceTree.tsx`, `workspace-tree.css` | Shared `workspace_tree`: generated CSS/AST geometry and Source Lucide icons; native semantics and twenty Windows light/dark LTR/RTL pairs pass reviewed regional budgets at scale one and width 360. Full tree, caller actions, motion, other dimensions and web accessibility remain pending |
| Tokens and typography | `packages/ui/src/styles/tokens.css` | `crates/rune-theme-codenomad`: generated values; component parity qualified individually |
| Text | Ten UI catalogues | Generated catalogues, fallback and Hebrew direction qualified |
| Window close | `components/window-close-button.tsx` | `components/window_close_button.rs`: six Windows light/dark pairs, accessibility and interaction qualified at scale 1 |
| Server startup | Tauri `cli_manager.rs` | `platform/host/`: isolated Windows bootstrap, shutdown and generation qualified |
| Chat, composer and session launcher | Solid transcript, composer and project fixtures | `chat/`, `agent/`, `launcher/`: native flows with shared Rust and simulated OpenCode qualified; Solid parity pending |
| Browser client | Remote access contracts and Rune web target | Shared WASM state/views: six local and six authenticated session-reading contexts qualified with shared Rust and simulated OpenCode; physical mobile pending |
| Window state | Host client-state and browser sessionStorage contracts | `workspace/` restores projects, tabs, selected sessions and drafts; shared Rust with simulated OpenCode qualified on three OS; Windows private OpenCode storage qualified with 600 imported rows across three Rune boots; browser reload/quota and in-flight creation qualified separately |
| Project tabs | `components/instance-tabs.tsx`, `instance-tab.tsx`, `tab-scroll.tsx` | Shared rune-kit Button composite with CSS-generated geometry: select/close/New, keyboard navigation, web tab roles, direction, column sizing and focus halo qualified; SVG/text raster, complete bar parity and web tablist grouping pending |
| Action overflow menu | `components/action-overflow-menu.tsx` | Shared `action_menu`: CSS-generated geometry, keyboard, selection, focus and item-removal contracts exercised in Rune Runtime; actual Solid fixtures and native gallery available. Six Windows popup pairs pass reviewed regional budgets; complete caller, tooltip, responsive and touch parity remains pending |

## Workspace and qualification

`packages/rune-app` holds application state and views. `crates/codenomad-client` owns typed API contracts and transports; `crates/rune-theme-codenomad` owns generated visuals/catalogues; `crates/codenomad-host-process` confines native child processes behind a safe API. The workspace pins Rune and its platform patches with Cargo Git dependencies at one revision; `Cargo.lock` records the resolved versions and source identities. Asset packaging and API qualification locate Rune through locked Cargo metadata.

Workspace file trees own their requests and eight departed-directory snapshots. A completion retains its tree occurrence, directory, request identity and read version; cancellation or a foreign occurrence fences publication before sorting. The owner drains coalesced refreshes after the shared debounce and the last completion. Sorting belongs to a captured platform collator and completes before any snapshot change: native ICU uses the system locale, or Unicode root collation in unconfigured/POSIX environments; browser Intl uses its default locale. Translation selection remains independent. Equal names retain input order, and errors preserve the last complete listing.

Files controllers belong to the validated project/session occurrence and move with its live tab cache. Suspending a tab cancels its reads and retains selection, expansion and snapshots; reconnect invalidates retained directories for their next visible demand. Workspace file observations use the existing SSE and preserve transcript recovery versions. Passive batches publish after a short quiet delay, at most once per five seconds under continuous activity, then refresh visible stale listings. Matching directory spelling follows the shared server-path rules, preserving POSIX case and logical aliases. Secondary reads share two owned admission slots; preview has one independent slot, held through body decoding or cancellation.

The typed workspace write API requires an observed opaque version and sends the exact directory/path with `expectedVersion` to the shared Rust server. It distinguishes saved content from a conflict, bounds UTF-8 content and serialized JSON before dispatch, and performs one request. Document owners retain their drafts and reconcile uncertain mutations before dependent reads.

Each Files owner carries a reader scoped to its captured session, directory and path. Replacement, closure and suspension cancel reads and fence late completions by request identity. Reconnection revalidates the retained preview; hiding the tree keeps the reader active. Coalesced filesystem observations refresh its bytes through the independent preview admission slot. Raw preview ownership has native HTTP fixture coverage and compiles for WASM. Windows shared-Rust watches exercise UTF-8 bytes, content versions and suspended-tab revalidation with simulated OpenCode; rendering, content codecs and actual network interruption require their own qualification.

Text fragments retain native ordinals and live/partial/closed provenance. One shared helper updates both ordered parts and the display body. Open page prefixes preserve longer live text; full native endings and committed pages settle ambiguous fragments through bounded recovery reads.

Persistent isolated hosts require an explicit root and `trial-*` profile. A versioned marker binds the root, profile and configuration; an OS lock covers child containment and reader drain. Window-state writes use the alpha-owned store, preserving the last complete file through atomic replacement. Browser state belongs to the current tab's sessionStorage. The snapshot uses the existing v1 field names and UTF-16 budgets; unsupported payloads require explicit recovery before any replacement.

Each project tab owns its server record and live conversation state. Drafts remain scoped to the validated server, folder occurrence and native session. Restoration performs a targeted session read, with identity and location validation. Browser departure writes the snapshot and release marker before issuing keepalive deletion of its owned records; storage failure preserves those records. The last browser store also performs this bounded synchronous handoff when Rune unload drops its listener. A preserved BFCache document retains its state and records.

Active and cached tabs share the same guard for pending replies and edited permission/question forms. Closing an inactive tab preserves the active reader and composer. Closed drafts transfer after validated session binding; independent edits and undelivered sessions retain their ownership. Tab capacity is checked before project creation.

The isolated 12px SVG stroke raster discrepancy is tracked in [Rune issue 1346](https://github.com/anomalyco/rune/issues/1346), with a public API reproduction and Chromium cross-prediction controls. Component pixel budgets require separate qualification.

Lazy and empty folders require branch semantics independent of loaded children. The pinned Rune Tree projects these nodes as leaves despite the directory flag and stored expansion bit; public-model, keyboard and accessibility reproductions are tracked in [Rune issue 1348](https://github.com/anomalyco/rune/issues/1348).

The component index is `rune-components.generated.json`; full sheets and captures are generated under ignored `target/`. Install locked npm dependencies before generating checker-derived sheets. Each qualified component requires a gallery, explicit light/dark pixel thresholds, accessibility and simulated interactions, then two independent blind reviews. Solid/Tauri modules are removed only at complete qualified parity. Integration uses short branches and merge commits into `feat/rust-server`; its synchronization owns merges from `dev`.

Shared action menus keep their state outside virtualized rows. Model updates call `action_menu::sync` when items or their minimum count change, and `clear` when an owner disappears; the host calls `poll` after input commits. Captured selections survive these updates. A gesture action runs immediately; its deferred focus target respects focus already established outside the closing menu. Popup raster qualification separates the initial hover from deferred platform help and checks frame, surface, text and shadow independently.

Tests use isolated `trial-*` profiles, owned processes and existing Cargo caches, without visible windows or writes to installed profiles, shared OpenCode or user sessions. JavaScript fixtures live in `packages/rune-app/fixtures/`; qualification commands are in `scripts/rune/QUALIFICATION.md`, and execution evidence belongs in ignored output directories or CI artifacts. Synthetic scenes and probes require explicit `test-support`; default native/WASM artifacts retain Rune inspection and simulated-input tooling.

Browser/mobile risks and physical-device gates are in [RUNE_WEB.md](RUNE_WEB.md). The latency guard reuses `scripts/perf/` markers and TUI budgets. Webview and PTY capabilities require a short decision before implementation.

Published switchover requires signed updates using the current [Tauri updater contract](TAURI_UPDATER.md), rollback, and qualification on Windows/macOS/Linux. Reuse `packages/server-rs/install/` where applicable. The final Tauri version must install the first Rune package without user action, preserving identity and data; incompatible installation contracts require a decision before switchover.
