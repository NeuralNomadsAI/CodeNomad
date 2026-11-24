# Native WebKit input qualification

The harness compiles the native adapter sources in `src-tauri/src/embedded_view/input_{linux.c,macos.m}` directly. The application's target-gated native build uses the same sources; its private browser controller integrates visible PNG capture through the Rust read adapter. Public WebKit automation stays disabled, and input dispatch retains the qualification boundary below.

Run on the graphical Linux desktop:

```sh
GDK_BACKEND=x11 python3 packages/tauri-app/scripts/test-webkit-input.py --output /path/to/artifacts/x11
GDK_BACKEND=wayland python3 packages/tauri-app/scripts/test-webkit-input.py --output /path/to/artifacts/wayland
```

With an X11 desktop in use, `--nested-kde` starts a separate virtual KWin Wayland compositor, gives its keyboard focus to a sentinel window, and terminates only its own compositor. The WebKit widget uses `GdkWaylandDisplay`. This exercises native Wayland client routing while preserving the desktop session. A full Plasma Wayland login remains a separate qualification target.

On macOS:

```sh
python3 packages/tauri-app/scripts/test-webkit-input.py --output /path/to/artifacts/macos
```

Requirements: a C compiler, Python 3, GTK 3 and WebKitGTK 4.1 development packages on Linux; Xcode command-line tools and AppKit/WebKit on macOS. `xdotool`, when present on the Linux desktop, observes pointer coordinates only. Synthetic input exclusively uses the adapter. The runner bounds compilation, compositor startup and execution. Each native executable checks background-window status throughout input dispatch.

Artifacts: `checkpoint.json` contains the fixed isolated-world callback result and page event observations; `capture.png` is the visible native viewport; `native.log` records window and pointer state; `result.json` lists each acceptance check. Linux also records desktop-pointer observations when X11 observation is available. Wayland's GDK coordinates describe its own compositor, so the desktop observer supplies the external pointer check in nested runs.

The fixture checks left/right click, hover, drag with a held button, wheel, key down/up, the platform select-all chord, Unicode insertion into input/contenteditable, and Enter in contenteditable. Every observed input must be trusted. A page-only global must be absent from the isolated world. The program is fixed in the adapter; callers supply neither script text nor an evaluation expression.

## Qualification boundary

The AppKit candidate uses targeted NSEvent/responder APIs. Its UI-thread dispatch scopes the native `pressedMouseButtons` implementation to the synthetic button state, delegates other threads to the original implementation, and restores it in `@finally`. The native self-check exercises nested dispatch, another thread and exception cleanup; the harness also verifies method restoration after every action. Its drag path must produce `pointermove.buttons == 1`; a trusted event alone is insufficient. Select-all must replace the entire input value, and Enter must reach contenteditable. Keep these assertions strict when investigating an alternative native path.

`CN_INPUT_TRACE=1` records key-equivalent, native editing fallback and hover dispatch paths. Hover first checks for a public `mouseMoved:` implementation on the view and otherwise checks availability of the narrow `_simulateMouseMove:` WebKit SPI. An initial native snapshot establishes the paint callback before input starts. Keyboard delivery targets the exact view; an inactive native editing fallback remains subject to qualification of page cancellation and single execution before integration.

The macOS harness primes hover at `(5,5)`, then targets `(30,160)` on the next timer tick, with tracking areas installed and mouse-moved events enabled. The trace records both CSS and native window coordinates. Chords send native `flagsChanged:` transitions for each modifier, the key equivalent, its matching key-up, and modifier release. Synthetic class modifier state is UI-thread scoped with exception-safe restoration; the native self-check covers nested modifier state and exception cleanup. Fresh key-event timestamps, window numbers and flags are recorded for sequence comparison.

`CN_INPUT_NO_CHORD=1` is a diagnostic that omits only the chord down/up steps. The acceptance assertions remain enabled, so this diagnostic fails the chord criteria by design. Compare its contenteditable keyboard events against the complete sequence; use the complete sequence for acceptance.

`CN_INPUT_DIRECT_HOVER=1` exercises public `mouseEntered:` then `mouseMoved:` directly on the exact WKWebView at the priming and target positions. This variant lives in the native self-test build. The trace includes each tracking area's options and key-window/always-active bits. Keep the window inactive throughout qualification.

## macOS candidate limitations

- A standalone Enter uses WebKit's native `keyDown:` text-input path and produces exactly one `insertParagraph` beforeinput/input pair. The harness counts both events independently to catch duplicate execution. Its DOM trace contains Enter key-down; Enter key-up is missing in this diagnostic.
- In the complete Cmd+A sequence, the native select-all fallback replaces the input value. DOM delivery includes Meta key-down, while the Meta release and following Enter keyboard events are missing. The native trace records direct WKWebView `flagsChanged:` down/up, chord key-up and zero modifiers on the following Enter. After this chord, the agent's subsequent Enter also lacks its native paragraph edit. Keep keyboard actions following a Mod chord gated by this limitation.
- The initial hover lacks `pointermove` at the requested target while the window is inactive, including after priming at a different in-view location. Public direct enter/move and the checked `_simulateMouseMove:` SPI are covered by separate harness variants. Mouse-enter/CSS hover observations occur with subsequent clicks. The agent's initial standalone hover consequently cannot establish the expected pointer-move behavior. The harness preserves background-window operation; tracking-area option logging is diagnostic evidence rather than a key-window positive control.

The strict complete-sequence assertions retain these failures. The private transport integrates navigation and capture; pointer and keyboard dispatch retain the documented macOS limitations and their separate capability gate.

WebKit's `WebEventFactory::createWebMouseEvent` obtains ordinary NSEvent button state from `WebCore::currentlyPressedMouseButtons`, which reads `[NSEvent pressedMouseButtons]`. The automation event path has distinct handling. Source references for investigation:

- <https://github.com/WebKit/WebKit/blob/main/Source/WebKit/Shared/mac/WebEventFactory.mm>
- <https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/mac/PlatformEventFactoryMac.mm>
- <https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/Automation/mac/WebAutomationSessionMac.mm>
- <https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/_WKAutomationSession.h>

An alternative based on WebKit automation SPI requires explicit contract qualification and runtime capability checks. Its background-window behavior must pass this harness before application integration. Never use global CGEvent posting, unscoped event-state overrides, XTest, DOM-event substitutes, or broad script evaluation to satisfy a failed assertion.
