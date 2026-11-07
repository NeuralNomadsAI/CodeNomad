# Native WebKit capabilities fixture

Run in a graphical macOS or Linux session, with the Tauri workspace's locked
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
