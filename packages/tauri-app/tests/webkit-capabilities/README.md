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
