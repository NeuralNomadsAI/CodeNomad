# Desktop Conventions

## Dual Platform: Electron + Tauri

CodeNomad supports two desktop platforms:
- **Electron** (primary, mature)
- **Tauri** (emerging, Rust-based)

## Electron

### Directory Structure

```
packages/electron-app/electron/
├── main/           # Main process code
│   ├── main.ts     # Entry point, window management
│   ├── menu.ts     # Application menu
│   ├── ipc.ts      # IPC handlers
│   ├── storage.ts  # File system storage
│   ├── permissions.ts  # Media permissions
│   ├── user-shell.ts   # Shell command execution
│   └── process-manager.ts  # CLI process management
├── preload/        # Preload scripts
│   └── index.cjs   # API exposure to renderer
└── resources/      # Bundled resources
    └── cli-supervisor.cjs  # Process supervisor
```

### Main Process Responsibilities

- Create and manage browser windows
- Spawn and monitor CLI server process
- Handle native APIs (file dialogs, notifications)
- Manage application lifecycle

### IPC Pattern

```typescript
// Main process handler
// packages/electron-app/electron/main/ipc.ts
function setupCliIPC() {
  ipcMain.handle("dialog:open", async (_, options) => {
    return dialog.showOpenDialog(options)
  })
}

// Preload exposure
// packages/electron-app/electron/preload/index.cjs
contextBridge.exposeInMainWorld("electronAPI", {
  openDialog: (options) => ipcRenderer.invoke("dialog:open", options)
})
```

## Tauri

### Directory Structure

```
packages/tauri-app/
├── src-tauri/
│   ├── src/           # Rust backend code
│   │   ├── main.rs           # Entry point
│   │   ├── cli_manager.rs    # CLI process management
│   │   ├── cert_manager.rs   # TLS certificate management
│   │   └── linux_tls.rs      # Linux TLS handling
│   └── capabilities/  # Permission capabilities
└── src/             # Frontend code (same as UI)
```

### Rust Backend

- Commands exposed to frontend via `#[tauri::command]`
- Process management similar to Electron's process-manager.ts
- Certificate management for HTTPS

### Command Pattern

```rust
// packages/tauri-app/src-tauri/src/main.rs
#[tauri::command]
fn open_dialog(options: DialogOptions) -> Result<DialogResult, String> {
  // Implementation
}
```

## Parity Rules

| Scenario | Rule |
|----------|------|
| Existing IPC/handlers (pre-Tauri) | MUST implement in both Electron + Tauri |
| New features | Implement in Electron first, Tauri if time permits |
| Native APIs | Use `packages/ui/src/lib/native/` abstraction layer |

## Native Abstractions

CodeNomad abstracts native APIs to work across Electron, Tauri, and Web:

| Feature | Abstraction File |
|---------|-----------------|
| File dialogs | `packages/ui/src/lib/native/native-functions.ts` |
| Desktop file drop | `packages/ui/src/lib/native/desktop-file-drop.ts` |
| Electron-specific | `packages/ui/src/lib/native/electron/functions.ts` |
| Wake lock | `packages/ui/src/lib/native/wake-lock.ts` |
| Remote windows | `packages/ui/src/lib/native/remote-window.ts` |
| CLI restart | `packages/ui/src/lib/native/cli.ts` |

### Abstraction Pattern

```typescript
// packages/ui/src/lib/native/native-functions.ts
export type NativeDialogResult = string | string[] | null

export async function openNativeFileDialogs(
  options?: Omit<NativeDialogOptions, "mode" | "multiple">
): Promise<string[]> {
  const result = await openNativeDialog({ mode: "file", multiple: true, ...options })
  // Platform-specific implementation
}
```

## Platform Detection

```typescript
// packages/ui/src/lib/runtime-env.ts
export function isElectronHost(): boolean { /* ... */ }
export function isTauriHost(): boolean { /* ... */ }
export function isWebHost(): boolean { /* ... */ }
```

## Checklist for Desktop Features

- [ ] Electron main-process changes? (`packages/electron-app/electron/main/`)
- [ ] Tauri Rust changes? (`packages/tauri-app/src-tauri/src/`)
- [ ] Preload API exposure? (`packages/electron-app/electron/preload/`)
- [ ] Native abstraction? (`packages/ui/src/lib/native/`)
- [ ] Cross-platform test (Electron + Tauri + Web)
