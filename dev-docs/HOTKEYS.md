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
