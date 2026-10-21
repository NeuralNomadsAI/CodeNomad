# Custom keyboard shortcuts

Settings → Keyboard shortcuts manages the 74 renderer actions in
`packages/ui/src/lib/hotkey-definitions.ts`, without mounting the app first.
The 23 initially unbound palette commands appear with “No shortcut” and reuse
their existing translated names. Existing aliases (such as `new-session` →
`session-new`) keep one settings row. Native workspace actions can be configured
here but only register for execution in local desktop windows.
Bindings live in the UI owner's `settings.hotkeyOverrides`: a missing ID uses
its default, `[]` disables it, and merge-patch `null` resets one ID or the map.
The saved `promptSubmitOnEnter` preference supplies Enter defaults until an
explicit composer override replaces them.

Recording is renderer-only and target-scoped. It suppresses app shortcuts and
ends on blur, cancellation, inactive settings or disposal. IME composition and
bare modifier keys are ignored; unmodified Tab leaves recording normally.
Conflicts warn on every affected row; they never silently disable a binding.
Shortcut hints belong in tooltips and the manager, not status strips or help
footers. Manager controls keep square, token-based styling.

`use-app-lifecycle.ts` registers initially unbound commands in the existing
keyboard registry and calls the palette's real action, respecting its disabled
state, active project/session, modal and selector guards. Key repeat does not
repeat these commands. Global commands also work on the home view.

Jump to previous/next user message (`user-message-prev`/`-next`, default
Shift+↑/↓) is handled by the active conversation's `MessageSection` in the
capture phase, before the transcript reads arrow keys as a scroll gesture;
the palette commands reach it through `JUMP_USER_MESSAGE_EVENT`. Text fields,
arrow-key widgets, IME composition and modal dialogs keep the keystroke, and
key repeat does not repeat the jump. Targets come from the timeline's markers,
including indexed history beyond the resident window: the jump requests that
index even while the timeline is hidden, and a jump that finds nothing
resident before it arrives runs once it does. The last target remains the
reference while it is loading or shown, because the list cannot raise a
message near the end to its top; a scroll gesture or other navigation ends it.

Digit-row and bracket shortcuts share one physical identity for recording,
dispatch and conflicts (`Digit1` → `1`, `BracketLeft` → `[`), including AZERTY
and QWERTZ. Other keys stay logical. Legacy layout-symbol overrides such as
`&`, `ü` or `!` must be re-recorded to bind those physical slots; their stored
symbols are not guessed or silently migrated.

Native hotkeys are not customized and retain their original platform defaults.
Native menu keys and OS-reserved combinations may intercept some assignments
before they reach the renderer. Recording does not suppress native accelerators.

## Agent conventions

These rules moved here from `AGENTS.md`, which indexes this document; they bind every change in this area.

- Keyboard shortcuts use the static renderer-only catalog in `lib/hotkey-definitions.ts` in both app and native Preferences renderers, including initially unbound palette commands. Preserve existing shortcut aliases as single rows; new assignments dispatch the real command through `use-app-lifecycle.ts`, with its disabled state, project/session context and modal/selector guards, without key repeat. The manager lives in `components/settings/hotkeys-settings-section.tsx`, with square, token-based styles in `styles/components/hotkeys-settings.css`; renderer-only recording is target-scoped, suppresses app shortcuts and ends on blur/cancel/disposal. Conflicts warn on every affected row without silently disabling bindings. Keep the `hotkeys` section allowlist identical in renderer, Electron and Tauri. Native hotkeys retain their original defaults and are not customized; native menu keys may intercept some combinations. Keep shortcut hints in tooltips and the manager, not status strips or explanatory footers: a control whose action has a binding sets `title={withHotkey(label, id)}` (`lib/hotkeys.ts`), and menu items set `description: hotkeyLabel(id) || undefined`, leaving the accessible name unchanged, only where the shortcut performs that action in the control's current context (Ctrl+W only on the active tab). Composer shortcuts (Clear, agent/model/thinking selectors) reach the shown composer, including the no-session draft, through the instance's `session-sidebar-events` request; Clear dispatches `PROMPT_CLEAR_EVENT` so the composer runs its own Clear action, never a bare textarea write. Jump to previous/next user message (Shift+↑/↓, `components/user-message-navigation.ts`) runs in the active `MessageSection`'s capture-phase handler, before the transcript reads arrows as scrolling, and leaves text fields, arrow-key widgets and IME composition their keys; covered by `tests/browser/history-navigation.test.ts`. See `dev-docs/HOTKEYS.md`.
