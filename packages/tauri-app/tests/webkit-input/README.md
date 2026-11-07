# Native WebKit input qualification

The harness compiles the native adapter candidates in `src-tauri/src/embedded_view/input_{linux.c,macos.m}` directly. The application keeps its current capabilities while qualification is incomplete. The candidates are isolated from the application build and transport.

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

The AppKit candidate uses public targeted NSEvent/responder APIs. Its drag path must produce `pointermove.buttons == 1`; a trusted event alone is insufficient. Select-all must replace the entire input value, and Enter must reach contenteditable. Keep these assertions strict when investigating an alternative native path.

WebKit's `WebEventFactory::createWebMouseEvent` obtains ordinary NSEvent button state from `WebCore::currentlyPressedMouseButtons`, which reads `[NSEvent pressedMouseButtons]`. The automation event path has distinct handling. Source references for investigation:

- <https://github.com/WebKit/WebKit/blob/main/Source/WebKit/Shared/mac/WebEventFactory.mm>
- <https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/mac/PlatformEventFactoryMac.mm>
- <https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/Automation/mac/WebAutomationSessionMac.mm>
- <https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/_WKAutomationSession.h>

An alternative based on WebKit automation SPI requires explicit contract qualification and runtime capability checks. Its background-window behavior must pass this harness before application integration. Never use global CGEvent posting, global event-state swizzling, XTest, DOM-event substitutes, or broad script evaluation to satisfy a failed assertion.
