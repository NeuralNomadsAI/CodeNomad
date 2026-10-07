# Windows WebView2 F6 browser-process crash

## Captured failure (#875, 2026-10-07)

On installed Tauri `0.20.1-dev-20261007-c995044b`, foreground- and
ownership-checked Win32 `SendInput` F6 at `19:19:00.118Z` made the client
area black. The native host still answered `WM_NULL`, while automation lost
its visible session and the WebView2 process tree exited. OpenCode remained
available through the TUI.

Crashpad recorded the WebView2 **browser process** at `19:19:01Z`.
Its command line identifies the tested CodeNomad host; `msedge.dll` is
`154.0.4258.62`. Matching public symbols identify this stack:

```
BrowserView::AcceleratorPressed
chrome::FocusNextPane
BrowserView::RotatePaneFocusFromView
BrowserFocusControllerViews::ActivateFirstInactiveBubbleForAccessibility
MultiContentsView::GetActiveContentsContainerView
```

The final instruction reads `[rcx + 0x420]` with `rcx = 0`, causing
`0xc0000005`. This establishes the browser's native F6 pane-focus crash
for this capture, not a refresh, renderer-only hang or Tao mutex deadlock.
The dump remains local: dumps and debugger environment output can contain
credentials and must not be uploaded.

## Narrow host mitigation

`src-tauri/src/windows_browser_accelerators.rs` installs one handler on
each created local, preferences, remote and preview webview. It disables
only F6 key-down/system-key-down **browser actions**, including modified F6,
through `ICoreWebView2AcceleratorKeyPressedEventArgs2`.

The [per-key property][per-key] skips the browser action but preserves DOM
delivery, unlike `Handled`. Therefore configured UI shortcuts continue
working. Other keys, normal text editing and Tab navigation are unchanged.
Older runtimes without that COM interface fall back to swallowing F6 only;
no runtime-version gate or global accelerator disable is introduced.
The callback performs no application locking, message pumping, navigation
or IPC. Its controller owns the handler; it captures no host/controller.

This is a Windows WebView2-specific mitigation. Electron, browser, Linux
and macOS handling remain unchanged; no new shared UI shortcut is added.
Removing the mitigation requires an upstream fix and a qualified retest
of the captured scenario, not merely a newer version label.

## Validation and limits

Run in a graphical Windows PowerShell 7 session:

```powershell
./scripts/test-tauri-f6.ps1
./scripts/test-tauri-f6.ps1 -Decorated
```

The isolated Tauri example uses static loopback HTML, a fresh temporary
WebView2 profile, no backend and no OpenCode connection. The runner checks
the executable/PID/HWND and foreground before native input; only its own
fixture can be closed. The fixed runs exercise F6, Shift+F6, Ctrl+F6 and
F8. They verify disabled browser policy for F6, retained DOM delivery,
untouched F8 policy/delivery, continuing JavaScript heartbeats and no
`ProcessFailed`. Both decorated and frameless runs passed on
`154.0.4258.62`; all 196 Windows Rust host tests passed in serial mode.

`-Baseline` omits the mitigation and sends one F6. The minimal baseline
did **not** reproduce the installed-app crash. These native checks verify
the actual prevention mechanism and keyboard preservation, not an A/B
reproduction of the full captured application state. No fixed installed-app
retest or Electron/Linux/macOS runtime qualification is claimed.

[per-key]: https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2acceleratorkeypressedeventargs2
