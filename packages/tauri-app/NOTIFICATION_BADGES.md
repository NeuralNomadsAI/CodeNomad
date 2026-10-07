# Notification icon badges

Invoke `notification_badge_set` with `{ count }`, an integer from 0 through 50.
Only registered local/remote primary webviews at their owned origins have this
capability. Preferences and preview guests have no badge permission. There is no
window target or renderer-provided image argument.

The host sums live windows’ unread bell/history contributions. Page-load starts
and window destruction clear only that window; generation checks fence queued
updates across reload and replacement. Windows overlays are generated from
trusted native RGBA pixels (`99+` above 99); macOS/Linux use the native count API.
Linux display depends on launcher support. No notification permission is needed,
and the host does not query sessions or persist badge state.

Check without launching the application:

```sh
cargo test --manifest-path packages/tauri-app/src-tauri/Cargo.toml notification_badge
```
