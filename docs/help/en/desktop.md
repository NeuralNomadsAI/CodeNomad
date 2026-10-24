# Desktop windows and data

## Windows, tabs and the shared service {#windows-tabs}

1. Use **New instance** to open another project/home tab in the current window.
2. Use native **Window → New Window** (`Ctrl+Shift+N` or `Cmd+Shift+N`) for a separate application window.
3. In **Settings → Advanced**, enable **Focus existing window on second launch** if another launch should focus the most recently used window rather than open a new one.

Project tabs, selected conversations and layout belong to a window. OpenCode sessions/messages belong to the shared native OpenCode service: another window can see the same conversation. Closing a project tab closes that project in CodeNomad, not its OpenCode sessions; reopen it to find them again. Another window displaying the same project connection also closes its tab and shows a notification; separately opened tabs of the same folder are unaffected. Closing a whole window, quitting or reloading preserves project connections for restoration; see [Projects](projects.md). Do not use closing windows as proof that an agent or scheduled Mission has stopped.

Native application menus use CodeNomad's interface language once a window has loaded; they show English until then. **Help → About CodeNomad** (also in the macOS application menu) opens **Settings → Info** with the version, updates and diagnostics.

## Preferences and startup restore {#preferences-startup}

1. Open Settings from the window you want to configure. Local desktop entry points focus the single native Preferences window with that opener's project/Location.
2. In **General**, turn **Restore previous state** on or off.
3. To forget that window's saved layout, use **Clear saved startup state**. It applies immediately, without a confirmation.

Restore can reopen workspace/SideCar tabs and active sessions, unsent text, scroll positions, panels, window placement and zoom. It is per-window client state, not a copy of the native conversation database. Clearing it removes saved tabs, drafts and layout; it does not delete CodeNomad configuration or OpenCode conversations. Save any important unsent draft elsewhere first.

The Preferences window does not own a separate restore state: these controls target the window that opened it. When that window has closed, or is unknown because Preferences reopened at launch, they follow the most recently used window instead; a change prepared for another window is never applied, and the controls first show the new window's value. To configure a specific window, open Preferences from it. Project-scoped settings likewise use the opener's Location; they stay unavailable without one. When Preferences reopens at launch, they reconnect once that project has finished opening; while the folder is still starting, or open in several tabs, they stay unavailable until you open Preferences from the intended window.

Browser and remote settings are embedded rather than a second native Preferences owner. A native Preferences opening error is reported; it is not a reason to assume a hidden embedded settings screen was opened instead.

## Explicit desktop data profiles {#data-profiles}

Without an explicit profile, packaged launches reuse the remembered profile for that configuration. If no choice is remembered, the app checks the default, `dev` and `dev-v2` profiles for restorable work: it selects the sole candidate, asks when several exist, or uses the default when none exists. Selection does not move, merge or delete profile data. Use `CODENOMAD_PROFILE` to open another profile explicitly.

1. For deliberate desktop isolation, set `CODENOMAD_PROFILE` before launching the executable.
2. Use a name of 1–64 ASCII letters/digits, dots, underscores or hyphens, starting with a letter or digit. Names are normalized to lowercase; `default` or `stable` selects the default profile.
3. Check **Settings → General → Restore previous state → Data profile** for a named profile. An invalid name prevents launch instead of selecting another profile.

For example, in PowerShell, before launching the desired desktop executable:

```powershell
$env:CODENOMAD_PROFILE = "review"
```

For an independent server configuration, set `CLI_CONFIG` to a separate configuration file before launch as well. The default is `~/.config/codenomad/config.yaml`. A profile name by itself does not change that file or the shared OpenCode service.

| Isolated by a desktop data profile | Not automatically isolated |
| --- | --- |
| Window/tab restore state, unsent drafts and desktop singleton/backend scope | OpenCode sessions, messages, provider credentials and execution |
| Native Chromium/WebView storage associated with that profile, subject to platform limits | CodeNomad configuration/preferences, speech keys, SideCars and extension activation when configuration is shared |
| Native preview storage within its host/profile | Files in opened projects; remote servers' data |

On macOS Tauri, scoped profiles share system WebKit storage, sign-ins and cache; do not use profile names as account-security isolation. Electron stores web data in its profile. Installed version and **Update feed** never select another data profile. Unpackaged development launches use the `dev` profile unless explicitly selected.

## Delete other saved profiles {#delete-profiles}

1. In native **Settings → General**, find **Other saved profiles** below **Restore previous state**. It appears only when other profiles are present on the machine.
2. Refresh the list if needed, choose **Delete…**, and read the listed targets and skipped profiles.
3. Confirm only after preserving any drafts/sign-ins you need. Inspect any incomplete-removal report before retrying.

Deletion removes other profiles' saved tabs, drafts, layout and owned web storage/cache/sign-ins, including listed profiles from another configuration. It preserves the open profile, OpenCode conversations and project files. Open or unknown-state profiles are skipped; close the relevant CodeNomad windows before explicitly refreshing and retrying. Unrecognized content is retained and reported rather than broadly deleted.

macOS Tauri's shared WebKit store is kept because deleting it would affect other profiles. This is not an undoable cleanup: a surviving native conversation does not restore a deleted unsent draft. **Clear saved startup state** is the smaller action when you only want to reset the current window.

## Zoom and panel geometry {#zoom-panels}

1. Use native **View → Zoom In**, **Zoom Out** or **Actual Size**; keyboard/wheel input also follows host support.
2. Use **Left panel** and **Right panel** at the fixed outer header corners to toggle panels. Pin/unpin drawers when that layout permits it.
3. If controls no longer fit, reduce zoom or widen the window; narrow layouts move controls into menus and panels into overlays.

Main local and remote desktop windows reserve at least 390 × 600 CSS pixels, scaled by application zoom and bounded by the monitor work area. Zooming in can enlarge a window that is too small; zooming out does not shrink an already larger one. Preferences and browser-preview children have separate size rules.

Panels leave a minimum conversation width before floating. Below 420 CSS pixels of conversation width, the timeline hides and header actions use their overflow menu; the saved timeline preference is preserved. These geometry changes do not alter your prompt draft or native session. See [Settings and layout](settings.md) and [Browser previews and SideCars](browser-sidecars.md).
