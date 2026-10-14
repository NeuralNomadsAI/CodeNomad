# Notification icon badges

`electronAPI.setNotificationBadge(count): Promise<void>` publishes this main
renderer’s unread bell/history count (an integer from 0 through 50). Registered
local and remote primary renderers may call it; Preferences and browser guests
cannot. The host sums live window contributions without querying the backend.

Reload/navigation, renderer crashes and window closure clear only that window.
Windows uses a host-generated red counter overlay on main windows (`99+` above
99); macOS and supported Linux desktops use Electron’s application badge API.
Unsupported Linux launchers can ignore badges. No OS notification permission is
needed. Counts and badge pixels are never persisted.

Check without launching Electron:

```sh
node --import tsx --test packages/electron-app/electron/main/notification-badge.test.ts packages/electron-app/electron/preload/index.test.ts
npm run typecheck --workspace @neuralnomads/codenomad-electron-app
```
