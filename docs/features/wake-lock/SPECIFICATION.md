# Wake Lock Behavior

## Product Rule

By default, CodeNomad requests a wake lock only for qualifying active work that is already running and can continue without continuous foreground interaction. A session qualifies while working or compacting and able to continue without waiting for new user input or permission.

With **Keep the computer awake while CodeNomad is running** (`ui.settings.keepComputerAwake`, default `false`) enabled, a local application window also holds the lock for as long as it remains open, including while minimized. Remote windows and the Preferences window follow only the session rule. The wake lock prevents idle system sleep where supported; the display may still turn off.

## Platform Behavior

- **Electron:** request system-sleep-only behavior with `prevent-app-suspension`.
- **Tauri:** request the native keep-awake mode with `display: false`, `idle: true`, and `sleep: false`.
- **Web:** do not fall back to `navigator.wakeLock.request("screen")`; if a true system-sleep-only primitive is unavailable, CodeNomad degrades to no wake lock.

## Release Expectations

The system wake lock is released promptly once all window holds have ended. This includes:

- Qualifying active work ends or its session lifecycle is cleaned up, and no preference-based hold remains.
- The preference is turned off and no qualifying active work remains.
- The last local application window holding the lock closes, with no session-based hold remaining in another window.
