# Updates

## Choose the release feed {#feed}

1. Open **Settings → Info → Updates**.
2. Set **Update feed** to **Stable releases** or **Previews and stable releases**.
3. Refresh/check for updates and review the offered release before accepting an installation.

The feed is saved in CodeNomad server configuration and only changes which releases are offered. It does not change desktop data profiles, drafts, windows, OpenCode sessions or service configuration. Without an explicit selection, preview-labelled builds default to previews, other builds to stable.

Stable selects the latest final release. Preview follows publication order because development builds can share a base version number; do not compare only their numeric versions. A preview release is offered only once all of its builds are published. Preview packages are for users willing to test prerelease behavior; inspect release notes and protect important drafts before restarting.

## Update a desktop installation {#desktop-update}

1. Use **Help → Get Updates...**, the update notification, or the button in **Settings → Info → Updates**.
2. On Electron, follow the release page and obtain the archive/package for the host/platform you use.
3. On eligible local Tauri installations, review the native offer and choose **Install and restart** explicitly.
4. Save important work in every window before installation/restart, then verify **Info** after relaunch.

| Tauri installation | In-app install eligibility |
| --- | --- |
| Windows x64 NSIS installation | Supported with the embedded updater key and a signed release payload. |
| macOS x64 / arm64 application | Supported with the embedded updater key and a signed `.app.tar.gz` payload. |
| Linux x64 AppImage | Requires the AppImage bundle marker and a nonempty `APPIMAGE` path, plus signed update support. `APPRUN` alone is insufficient. |
| Debian/RPM, loose Windows executable, unsigned/keyless build | Opens the release page rather than installing in-app. |

In Tauri application and native **Preferences** windows, the Updates card shows **Install update** when a release is offered. It checks the selected feed and offers **Install and restart** when an in-app update is available; otherwise it opens the release page shown on the card. Electron, web and remote windows instead show the **Download update** link, without a native updater check.

The Tauri **Help → Get Updates...** menu runs the update flow in the focused application window. From Preferences or a remote window, it brings the most recently used application window forward to run the check; it does not install through the remote window. If no application window can receive the action, including a targeted loading, login or pairing screen, the menu opens the release page instead.

Tauri installs only releases with a published update manifest for the chosen feed/target. If an announced release cannot be installed yet, the notification opens its release page instead. Native signature verification is required before installation. Updater signatures are distinct from OS notarization/code-signing assurances.

Installation flushes all application windows and stops the owned CodeNomad backend before replacing/restarting the app. The independently owned OpenCode daemon is not part of this shutdown. Closing CodeNomad still removes backend-dependent features until it returns; do not infer uninterrupted UI services from a continuing OpenCode session.

If a check is busy, wait for the other window's operation. For download, validation or shutdown failures, read the error and perform a fresh check; an old notification is not a license to reinstall stale bytes. A failed installation can restore the backend and reload windows, and does not automatically replay installation. If native installation is unavailable, use the release page for the appropriate package; see [Install](install.md).

## Update a standalone server {#standalone-update}

1. Identify how you launched CodeNomad and save any work that depends on that backend.
2. Stop that CodeNomad server process using its normal process/service control.
3. Update the same package installation, then restart with the intended configuration and flags.

| Launch/install method | Update command |
| --- | --- |
| One-off stable npm launch | `npx @neuralnomads/codenomad@latest` with your normal flags |
| Global stable installation | `npm install -g @neuralnomads/codenomad@latest` |
| Local stable installation | `npm install @neuralnomads/codenomad@latest` in that package directory |
| One-off preview launch | `npx @neuralnomads/codenomad-dev@latest` with your normal flags |
| Global/local preview installation | Install `@neuralnomads/codenomad-dev@latest` with the same global/local npm form |

An already-running process does not acquire new code just because npm installed it. Keep the same configuration path intentionally; selecting a feed in Settings does not replace your npm package or automatically switch stable/preview package names. Preserve authentication/TLS flags when relaunching; see [Server](server.md).

## Keep OpenCode maintenance separate {#opencode-separate}

Updating CodeNomad is not updating the selected OpenCode CLI. Updating that CLI is not restarting the running shared daemon. Reloading native configuration is another explicit operation with its own effects on loaded Locations and requests.

Desktop Node/npm resources are shipped with the application; an application release delivers their updates. This does not replace your system Node/npm, Electron's internal runtime, the platform webview or the independently managed OpenCode service.

Use **Settings → OpenCode** for runtime selection, installation/update and explicit service controls. Check [OpenCode setup](opencode.md) before restarting or reloading, especially when other windows/users or Missions share the daemon. Never repeat an uncertain prompt or mutation simply because an update/reconnect finished.
