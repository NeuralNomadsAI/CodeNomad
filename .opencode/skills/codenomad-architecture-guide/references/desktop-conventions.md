# Desktop Conventions

## Shared Model

CodeNomad supports Electron and Tauri as equal desktop hosts. Identity is update channel plus config profile: each scope has one native singleton process and one CodeNomad backend, with multiple UUID-backed windows. A second launch opens another window by default; Advanced settings can restore MRU focus, while `--new-window` always requests another window.

OpenCode sessions and messages stay in the shared global daemon. Tabs, drafts, views, restore membership, and native bounds are per-window. Client-state V3 is a per-window envelope over the V2 SHA-256 content-addressed partition graph: prepare immutable partitions, fence migration and writes on current ownership and renderer authority, atomically publish the root, then remove only partitions unreferenced by every window.

Native SideCar/browser previews are sandboxed without `allow-same-origin`; DOM comment inspection is web-only.

## Current Host Paths

| Concern | Electron | Tauri |
|---|---|---|
| Entry and host wiring | `packages/electron-app/electron/main/main.ts` | `packages/tauri-app/src-tauri/src/main.rs` |
| Backend process | `packages/electron-app/electron/main/process-manager.ts` | `packages/tauri-app/src-tauri/src/cli_manager.rs` |
| Launch and singleton behavior | `packages/electron-app/electron/main/startup.ts` | `packages/tauri-app/src-tauri/src/launch.rs`, `identity.rs`, `local_windows.rs` |
| Native commands | `packages/electron-app/electron/main/ipc.ts` | command handlers registered in `packages/tauri-app/src-tauri/src/main.rs` |
| Renderer bridge | `packages/electron-app/electron/preload/index.cjs` | Tauri invoke/plugins through `packages/ui/src/lib/native/tauri/functions.ts` |
| Client state | `packages/electron-app/electron/main/client-state.ts` and `client-state-*.ts` | `packages/tauri-app/src-tauri/src/client_state.rs` and `client_state/` |
| Shutdown | `packages/electron-app/electron/main/multiwindow-lifecycle.ts` | `packages/tauri-app/src-tauri/src/shutdown.rs` |
| Workspace open | `packages/electron-app/electron/main/workspace-open.ts` | `packages/tauri-app/src-tauri/src/workspace_open.rs` |

The desktop process managers start and supervise the CodeNomad backend. They do not own or stop the shared OpenCode daemon.

## Native Abstractions

- Shared dispatch and dialogs: `packages/ui/src/lib/native/native-functions.ts`
- Shared types: `packages/ui/src/lib/native/types.ts`
- Electron adapter: `packages/ui/src/lib/native/electron/functions.ts`
- Tauri adapter: `packages/ui/src/lib/native/tauri/functions.ts`
- Desktop file drop: `packages/ui/src/lib/native/desktop-file-drop.ts`
- Client state: `packages/ui/src/lib/native/client-state.ts`
- Remote Control lifecycle: `packages/server/src/remote-control/manager.ts`
- Runtime detection: `packages/ui/src/lib/runtime-env.ts`

Use these abstractions instead of importing host APIs into feature components.

## Strict Parity

- Every desktop behavior change must ship for Electron and Tauri in the same change. There is no Electron-first or follow-up parity exception.
- Keep lifecycle, singleton identity, window restore, client-state safety, navigation security, native commands, and shutdown semantics equivalent.
- Add or update tests for both hosts. Include Web behavior when the shared abstraction has a browser fallback.
- Platform-specific implementation details may differ, but user-visible behavior and security boundaries must not.

## Checklist

- [ ] Electron main/preload behavior updated and tested
- [ ] Tauri Rust/plugin behavior updated and tested
- [ ] Shared UI native abstraction remains host-agnostic
- [ ] Multi-window, restore, navigation, and shutdown invariants preserved
