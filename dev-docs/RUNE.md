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
