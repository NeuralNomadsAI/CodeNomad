# Native WebKit capabilities fixture

Run in a graphical Windows, macOS or Linux session, with the Tauri workspace's locked
dependencies installed. This harness includes the production embedded-view layer
and uses neither a CodeNomad backend nor OpenCode.

1. Start `python3 tests/webkit-capabilities/fixture.py` from `packages/tauri-app`.
2. Run `CODENOMAD_PROFILE=<isolated-absolute-directory> cargo run --locked -p
   codenomad-webkit-capabilities-fixture`.
3. Open **OAuth popup**, then **Finish OAuth**. Expect shared cookie/localStorage
   in the round-trip result, `closed: true` and disposal of the native popup.
   Also exercise **Target blank** and **Blocked file popup**.
4. Download twice. Check two distinct `*-capabilities-fixture.txt` files in the
   system Downloads directory, each containing `webkit-capabilities-download`.
   Exercise data downloads and blob downloads where the engine exposes object URLs.
5. Exercise **Dialogs**, accepting and cancelling confirm/prompt. Check the
   returned boolean and string/null, including the prompt's default value.
   Start a download immediately before opening a dialog to check responsiveness.
6. Exercise **Permissions**. Expect geolocation error 1 and media/notification
   rejection or an unavailable API on engines without that API.

On Linux repeat with `GDK_BACKEND=x11` and `GDK_BACKEND=wayland` in their
corresponding graphical sessions. A nested KWin Wayland compositor supports
native Wayland clients and forwards native pointer/key input from its host window.

For opener cleanup, set `CODENOMAD_FIXTURE_CLOSE_AFTER=30` (1–60 seconds), then
open **Hold popup for opener cleanup**. The harness closes the production opener
and asserts that both the child view and popup tree disappear within five seconds.
`mac-input.py` supplies native macOS pointer/key/text events for VM trials;
Linux X11 and nested-compositor input can use `xdotool`.

Windows uses the shared common-controls manifest and a GUI-subsystem release
fixture. Start the page with `node tests/webkit-capabilities/server.mjs`, then build
`cargo build --release --locked -p codenomad-webkit-capabilities-fixture`.
Launch the executable with an isolated absolute `CODENOMAD_PROFILE` directory.
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-renderer-accessibility` enables the
fixture accessibility driver without a fixed debugging port. Run `windows-ui.ps1`
with Windows PowerShell, the fixture PID, `-Invoke <accessible-name>` and
`-NativePointer -Activate` for gesture-sensitive actions; `-Escape` exits browser
fullscreen/pointer lock. The driver restricts actions to this checkout's fixture
and creation-time-fenced descendants. Node/PowerShell console launchers use hidden
windows. App release smoke launches use `src-tauri` as their working directory.

The **Browser APIs** section additionally exercises blank/named pop-ups, prompt
string/cancel, fullscreen, pointer lock, clipboard consent, beforeunload, print,
file selection/drop and WebAuthn availability. Availability is recorded separately
from authentication success. The page reports absent app IPC/Node globals.

Electron uses `packages/electron-app/tests/browser-capabilities/fixture.ts` bundled
with esbuild (`--platform=node --format=esm --external:electron`) and run by the
installed Electron executable (`--loader:.css=text` when bundling). Its own profile directory is mandatory. Set
`CODENOMAD_FIXTURE_NETWORK=1` to test a trusted HTTPS page (`example.com`) requesting
the loopback fixture: the permission dialog must identify the HTTPS origin. The
fixture requires `CODENOMAD_FIXTURE_PROMPT_PRELOAD` pointing to the preview-only
`electron/preload/browser-prompt.cjs`. Set `CODENOMAD_FIXTURE_PROMPT_TEST=1` for
assertions covering root/blank-popup prompt strings, empty strings, cancellation,
page-global isolation, suppressed subframe prompts and selection of entry 25.

For extended qualification, open **Print** and cancel the system print panel;
select a known local fixture through the native file input and drop it on the HTML
zone; open **PDF display** and verify its text, then **PDF download** and verify a
unique 593-byte PDF in Downloads. Arm beforeunload before **Navigate**, **Reload
page** and native closure, testing cancellation and acceptance separately. Record
native closure independently from navigation. **Hardware APIs** reports interface
availability; **WebAuthn availability** reports platform-authenticator availability.

## Isolated native inputs

Set `CODENOMAD_FIXTURE_CONTROLS=1` and `CODENOMAD_FIXTURE_ZOOM_EVIDENCE=1` for
focused WebKit zoom trials. Native Cmd/Ctrl +, − and 0 and the fixture's **View**
menu exercise the production native zoom handlers and focused-menu routing.
`native-zoom.log` records actual primary/guest page zoom, independently of DOM
viewport reports. Run `assert-zoom.py <log>` after both key and menu sequences;
`--app-fallback` also checks primary zoom after explicitly focusing the app.
Compile/run `zoom-policy.c` with the system C compiler and `-lm` for range/reset
assertions. The user zoom factor composes with fitted mobile-profile zoom.

For image downloads, mark the trial start with a file, activate the native image
menu, then run `assert-image-download.py <marker> <count> [Downloads-directory]`.
It checks unique UUID names and exact generated PNG bytes. WKWebView context-menu
and navigation downloads share the same native download delegate and policy.

`CODENOMAD_FIXTURE_LIFETIME` selects `opener-close`, `opener-reload`,
`owner-destroy` or `renderer-reload`. Activate **Lifetime tree**, then **Create
descendant** in its child using native input. The child arms beforeunload and
opens a grandchild. The harness asserts forced descendant disposal, empty
descendant registries and the expected retained/root state, writing the result
inside the isolated profile. A hidden harness window keeps the event loop alive
for assertions after owner destruction. The renderer case replaces the neutral
primary document with the loopback page and uses the production cleanup contract.
Electron's same flag runs the equivalent production-guest assertions directly.

`CODENOMAD_FIXTURE_CONTROLS=1` opens the focused clipboard, file-picker,
context-menu and viewport probe. The fixture enables Tauri's `devtools` feature,
matching the production application. Native chooser input must target its owned
window; the selected filename is reported by the page's actual FileList.

Linux fixtures and native file sources share the same session bus. Set `DISPLAY`
before `dbus-run-session` and update its activation environment before launching
portal clients; a portal with a different display can open its print dialog
outside the test display. Use a dedicated Xvfb display and compositor, with native
Wayland clients connected to that compositor's own socket. Capture both client and
server Wayland traces when qualifying pointer lock, including the compositor's
`locked` event to establish effective lock.

`gtk-file-source.py <known-fixture-file>` offers a genuine `text/uri-list` drag.
Move inside the destination after its initial drag-enter so WebKit receives a
drag-over before release. `mac-file-source.swift`, built with the system `swiftc`,
offers a native NSURL drag; `mac-input.py drag X Y X Y` sends native mouse events.
On Windows, launch `windows-file-source.ps1 -FixtureProcessId <pid>` in hidden
PowerShell and use `windows-file-drop.ps1` with that source PID and fixture PID.
The source is the checked-in `drop-fixture.txt`; the page reports FileList count
and name. WebKitGTK 2.52.6 reproduces WebKit bug 323277 (CVE-2025-13947 protection)
in both the production layer and a bare native WebKit view. Preserve the engine's
file security policy; uploading through the file input is the available path.

For reproducible WebView2 beforeunload checks, start a fresh isolated release
fixture, then run `windows-beforeunload.ps1 -FixtureProcessId <pid>
-EvidenceDirectory <new-directory>`. It asserts Stay/Leave for navigation, reload
and native popup closure, capturing each stage. The driver admits external-browser
dialog windows only through their live HWND owner chain, restores owned minimized
windows and refuses covered controls before foreground pointer input.

Electron's `CODENOMAD_FIXTURE_BEFOREUNLOAD_TEST=1` runs equivalent assertions against
the production guest hooks. Set `CODENOMAD_FIXTURE_DIALOG_DRIVER` to the absolute
`linux-answer-beforeunload.sh` path and `CODENOMAD_FIXTURE_EVIDENCE` to an isolated
output directory. The native answer helper needs `xdotool`, ImageMagick and the
fixture's display; it matches both the owning PID and origin-labelled dialog.
Run the test process under an external `timeout` too, since a synchronous native
dialog can block the main JavaScript event loop. These checks cover individual
popup closure; owning-window/opener teardown is recorded independently.
