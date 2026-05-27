# Wake Lock Behavior

## Product Rule

CodeNomad only requests a wake lock for qualifying active work that is already running and can continue without continuous foreground interaction. The goal is to prevent idle system sleep where the platform supports that behavior without intentionally keeping the display awake.

Wake lock must not be held when work is idle, paused, completed, cancelled, failed, or waiting for new user input or permission before it can continue.

## Platform Behavior

- **Electron:** request system-sleep-only behavior with `prevent-app-suspension`.
- **Tauri:** request the native keep-awake mode with `display: false`, `idle: true`, and `sleep: false`.
- **Web:** do not fall back to `navigator.wakeLock.request("screen")`; if a true system-sleep-only primitive is unavailable, CodeNomad degrades to no wake lock.

## Release Expectations

Wake lock should be released promptly when qualifying active work ends or when the app cleans up the active session lifecycle.
