# Notification icon badges

Invoke `notification_badge_set` with `{ count }`, an integer from 0 through 50.
Only registered local/remote primary webviews at their owned origins have this
capability. Preferences and preview guests have no badge permission. There is no
window target or renderer-provided image argument.

The host sums live windows’ unread bell/history contributions. Page-load starts
and window destruction clear only that window; generation checks fence queued
updates across reload and replacement. On Windows, WebView2 `ProcessFailed`
clears the contribution only for browser/main-renderer exits, not frame exits,
unresponsiveness or auxiliary-process failures. On Linux, WebKitGTK's
`web-process-terminated` signal clears it for every web-process termination reason.
Failure also revokes count admission until a new page starts. Native handlers
are enrolled by the native local/remote factories before build, then installed
once on the first page-load start or the post-build fallback. This does not
depend on when LocalWindows/remote metadata is registered, and the fallback
does not erase a first-load publication. Renderer admission still requires the
registered owned origin. Page, termination and close callbacks carry a separate
physical-window identity so retired callbacks cannot reset/remove replacements.

Native subscriptions hold only a `Weak<AppHandle>` and no COM/GObject reference;
the host root is held outside managed application state until `app.run` returns.
This avoids native-handler/AppHandle ownership cycles. The subscriptions are
released with their native controller/widget; no native callback retains itself
or its owning view. No polling, new dependencies or guest capabilities are added.

**macOS:** when a renderer's web content process terminates while its window
survives, Tauri's runtime reloads that webview, because the application registers
no `Builder::on_web_content_process_terminate` hook. The reload's page-load start
resets the window's count like any other page start. The remaining gap is a
reload that fails (or that the runtime cannot start); the count then stays until
navigation or close. Registering that application-wide, label-keyed hook would
replace the runtime's reload and carries no physical-window binding to fence a
replaced window. WKWebView's navigation delegate stays runtime-owned: never
replace/swizzle it or invent process monitoring.

Windows overlays are generated from
trusted native RGBA pixels (`99+` above 99); macOS/Linux use the native count API.
Linux display depends on launcher support. No notification permission is needed,
and the host does not query sessions or persist badge state.

Check without launching the application:

```sh
cargo test --manifest-path packages/tauri-app/src-tauri/Cargo.toml
```
