# Mobile delivery gates

## Architecture decision

The Android-first companion is a separate Tauri v2 host, not a mobile build of
the desktop process supervisor. It displays the selected CodeNomad server's
hosted UI as a top-level page. Node, Git, OpenCode, directory authorization,
session environment writes, and all execution remain on that server.

Same-origin hosting preserves the existing login cookie, CodeNomad API,
allowlisted OpenCode proxy, and multiplexed SSE transport. A bundled copy of
the transcript UI with cross-origin APIs is deliberately out of scope.

Only the bundled connection screen may manage endpoints. Remote content must
have no native capabilities. A JavaScript host override selects web/remote UI
behavior; this is not a replacement for native capability/origin enforcement.
Endpoints require device-trusted HTTPS. There is no certificate bypass or
cleartext fallback. The initial deployment is a controlled pilot, not a claim
of unrestricted public-Internet or app-store readiness.

## Validation levels

Keep these outcomes separate in release reports:

1. Source and deterministic policy tests pass.
2. Launcher build, shared UI typecheck, and browser fixtures pass.
3. Rust/Tauri host compiles on a development host.
4. Android APK compiles with an actual Android SDK/NDK and target.
5. Emulator/physical-device acceptance checks pass.
6. Signed distribution build and store requirements are satisfied.

A Chromium mobile viewport is not Android WebView or WKWebView validation.
A Windows host compile is not an Android compile. A workflow definition is
not evidence that the workflow ran or produced an installable APK.

## Android acceptance checklist

- Install a debug APK; confirm no Node/server/CLI resources are included.
- Connect to a disposable authenticated CodeNomad fixture with trusted HTTPS.
- Reject HTTP, credentials in URLs, unsupported URL components, and launcher
  origin collisions. Fence cross-origin navigation, redirects, and popups.
- Prove remote pages and their frames cannot invoke launcher/native commands.
- Prove invalid, expired, and hostname-mismatched TLS certificates fail closed.
- Exercise native return/disconnect while loading, offline, and on TLS errors.
- Log in, stream a response, settle Forms/permissions, and upload a device file.
- Suspend and resume while work finishes; reconcile authoritative state and
  never replay failed prompt mutations on reconnection or reauthentication.
- Restart the test backend and recover authentication without losing an
  in-memory draft or submitting it twice.
- Check IME resize, rotation, safe areas, touch/nested scroll, RTL, and upload
  cancellation on the actual webview.
- Kill and relaunch the app. Record cookie behavior and document that remote
  web mode does not inherit native desktop draft/tab restoration.

Use isolated fixture backends and databases, never the shared user daemon.

## iOS follow-up

Tauri supports iOS, but compilation requires macOS and full Xcode, CocoaPods,
and iOS Rust targets. An installed macOS Rust target on Windows is insufficient.
Repeat the acceptance checklist on WKWebView, including safe areas, keyboard,
file selection, authentication persistence, and suspension. Signing and App
Store distribution require an Apple team, certificate, and provisioning.

## Server exposure prerequisites

The architecture audit of Git HEAD `9597853e` identified separate hardening
work before claiming unrestricted Internet readiness:

- Session expiry, bounded storage, revocation on logout/password changes.
- Credentialed CORS and request-origin/CSRF policy.
- Login abuse protection.
- Explicit reverse-proxy TLS trust and Secure-cookie behavior.

Mobile login is full backend access, not a read-only observer role. Hiding
administrative controls does not create an authorization boundary. A VPN
reduces exposure but does not turn these open hardening items into completed
security work.

## Official references

- https://v2.tauri.app/start/prerequisites/
- https://v2.tauri.app/start/project-structure/
- https://v2.tauri.app/security/capabilities/
- https://v2.tauri.app/distribute/google-play/
- https://v2.tauri.app/distribute/sign/android/
- https://v2.tauri.app/distribute/sign/ios/
- https://v2.tauri.app/distribute/app-store/
