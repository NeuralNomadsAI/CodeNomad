# Keyboard shortcuts

## Discover commands and open help {#discover-commands}

1. Open **Command Palette** using `Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on macOS, or use its visible button/menu item.
2. Type an action name. The palette includes application actions and the current Location's custom commands; availability depends on the active view.
3. Run **Open help** to open this guide in the current UI language in an external browser context. Native **Help → CodeNomad Help** opens the same guide.

Help leaves the application view and draft untouched. If opening fails, visit [CodeNomad Help](https://neuralnomadsai.github.io/CodeNomad/) directly. A command being discoverable does not mean it has a customizable shortcut: the shortcut manager covers a fixed catalog of 74 renderer actions, not every palette or native-menu action. It includes palette commands such as **Compact Session**, **Undo Last Message** or **Open help** that start with **No shortcut**; project-folder, terminal and editor actions run only in local desktop windows.

## Record, disable and reset {#customize}

1. Open **Settings → Keyboard shortcuts** and use **Filter shortcuts** to find the action or a key combination.
2. Choose **Edit**, then press the desired combination in **Press a key combination**. Recording saves that binding.
3. Use **Clear shortcut** (×) to remove that action's renderer binding, **Reset** to restore its default, or **Reset all** for all renderer bindings.
4. Resolve warnings on every conflicting row; conflicts are reported, not silently disabled.

Bindings are saved in CodeNomad UI configuration and affect clients sharing that configuration. They do not edit OpenCode's CLI/TUI bindings or native menu accelerators. Recording suppresses app renderer shortcuts, but cannot suppress the operating system or native menu. **Cancel**, focus loss, closing the section or leaving the window ends recording. Bare modifiers and IME composition are ignored; plain Tab/Shift+Tab moves focus.

If saving fails, keep the old shortcut available and retry after checking the displayed binding. Reset is the safe recovery for an accidental assignment.

## Renderer defaults {#renderer-defaults}

`Mod` means `Ctrl` on Windows/Linux and `Cmd` on macOS. These are defaults, not guarantees that the OS/native host will deliver the key. Scope matters: the same key can serve a different action on the home page, in a composer or in search.

| Action | Default |
| --- | --- |
| Open command palette | `Mod+Shift+P` |
| New instance / Browse for a folder on the home page | `Mod+N` |
| Close app tab | `Mod+W` |
| Previous / next app tab | `Mod+[` / `Mod+]` |
| App tab 1–9 | `Mod+1` through `Mod+9` |
| Rename instance (tab context) | `F2` |
| New session | `Mod+Shift+N` |
| Close session | `Mod+Shift+W` |
| Previous / next session | `Mod+Shift+[` / `Mod+Shift+]` |
| Session tab 1–9 | `Mod+Shift+1` through `Mod+Shift+9` |
| Instance info | `Mod+Shift+L` |
| Search session history | `Mod+F` |
| Previous / next user message (conversation, outside text fields) | `Shift+ArrowUp` / `Shift+ArrowDown` |
| Next / previous search result (search focused) | `Enter` / `Shift+Enter` |
| Focus prompt / Clear prompt | `Mod+P` / `Mod+K` |
| Open model / agent selector | `Mod+Shift+M` / `Mod+Shift+A` |
| Select model variant | `Mod+Shift+T` |
| Move blocking tools to background (composer) | `Mod+B` |
| Send prompt | `Enter` |
| Send with alternate follow-up behavior | `Alt+Enter` (Windows, Linux) or `Mod+Shift+Enter` |
| Insert new line | `Shift+Enter` or `Mod+Enter` |
| Previous / next prompt (composer) | `ArrowUp` / `ArrowDown` |
| Unfocus prompt / Exit shell mode | `Escape`, according to composer context |
| Stop session | Press `Escape` twice; the first press displays confirmation |
| Send side question (`/btw` window) | `Mod+Enter` |
| Save file (workspace editor) | `Mod+S` |

For a configuration with Enter-to-submit disabled, **Send prompt** defaults to `Mod+Enter` and **Insert new line** to `Enter` or `Shift+Enter`. An explicit shortcut override replaces that default. Use the manager to see the effective binding. On macOS, `Option+Return` stays a line break, so only `Cmd+Shift+Return` sends with the alternate behavior; the composer's **More actions** menu offers the same choice (**Queue message** or **Steer now**) while a session is working. **Clear prompt** runs the composer's own Clear action, including in a new conversation's first draft. Previous/next session cycles the session list; it is not the sidebar's browser-like **Back**/**Forward** history, which has no shortcut.

## Native keys and platform interception {#native-keys}

Native keys are fixed and remain active even after you change or disable the corresponding renderer binding. In particular, native **New Window** uses `Mod+Shift+N`, the renderer's default for New session. Use a visible New Session control or rebind the renderer action if the native menu intercepts it. Likewise, native `Mod+W` can close the window rather than just an app tab.

| Native action | Electron | Tauri |
| --- | --- | --- |
| New Window | `Mod+Shift+N` | `Mod+Shift+N` |
| New Instance / Command Palette | `Mod+N` / `Mod+Shift+P` | `Mod+N` / `Mod+Shift+P` |
| Reload / Force Reload | `Mod+R` / `Mod+Shift+R` | `Mod+R` / `Mod+Shift+R` |
| Actual Size | `Mod+0` | `Mod+0` |
| Zoom | `Mod+Plus` / `Mod+-` | View-menu controls and platform webview zoom input |
| Full Screen | `F11` on Windows/Linux; `Ctrl+Cmd+F` on macOS | `Ctrl+Cmd+F` menu accelerator on macOS; use the menu on other platforms |
| Developer Tools | `Ctrl+Shift+I` on Windows/Linux; `Alt+Cmd+I` on macOS | `Alt+Mod+I` |

Plain browser windows also retain their browser shortcuts. If a binding never reaches CodeNomad, choose another combination rather than disabling security or changing OS-wide keys.

## Keyboard layouts and text entry {#layouts-ime}

Digit-row and square-bracket shortcuts use physical key positions for recording, execution and conflict checks, including AZERTY/QWERTZ layouts. Other keys use their logical values. Record on the keyboard you intend to use, then check the displayed result.

During IME composition, text entry takes precedence. Prompt history and Escape actions also depend on focus, picker/shell state and the current operation; do not assume every ArrowUp or Escape is an unconditional global action. On desktop, sending moves focus to the conversation so arrows, paging keys and Space scroll it; typing a character returns to the composer with that character, and **Focus prompt** returns there before using prompt history. Tooltips name the current shortcut of controls such as the command palette, search, New session, Info and the composer selectors; with the shortcut manager they show the assignments without adding a permanent keyboard-help strip.
