import { dialog, session, systemPreferences, type Session } from "electron"
import { isAllowedRendererOrigin } from "./renderer-origin"
import { browserPermissionDecision, permissionOrigin, permissionResource } from "./browser-permission-policy"
import { nativeMenuLabels } from "./view-menu"
import { configureBrowserDeviceChoosers } from "./browser-device-chooser"
import { configureBrowserDisplayChooser } from "./browser-display-chooser"
import { browserGuestLifetime } from "./browser-guest-lifetime"

export { isAllowedRendererOrigin } from "./renderer-origin"

const isMac = process.platform === "darwin"

export function configureMediaPermissionHandlers(getAllowedOrigins: () => string[], targetSession: Session = session.defaultSession) {
  const isAudioMediaRequest = (permission: string, details?: unknown) => {
    if (permission !== "media") {
      return false
    }

    const mediaTypes = (details as { mediaTypes?: string[] } | undefined)?.mediaTypes ?? []
    return mediaTypes.length === 0 || mediaTypes.includes("audio")
  }

  targetSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (!isAudioMediaRequest(permission, details)) {
      return false
    }

    return isAllowedRendererOrigin(requestingOrigin, getAllowedOrigins())
  })

  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!isAudioMediaRequest(permission, details)) {
      callback(false)
      return
    }

    const requestingOrigin = (details as { requestingOrigin?: string } | undefined)?.requestingOrigin || webContents.getURL()
    callback(isAllowedRendererOrigin(requestingOrigin, getAllowedOrigins()))
  })
}

export function configureBrowserPermissionHandlers(targetSession: Session) {
  const grants = new Set<string>()
  const pending = new Map<string, Promise<boolean>>()
  const unknown = new Set<string>()
  const key = (origin: string, permission: string, resource = "") => JSON.stringify([origin, permission, resource])
  targetSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (!_webContents || !browserGuestLifetime.live(_webContents)) return false
    const origin = permissionOrigin(details.securityOrigin ?? requestingOrigin)
    if (!origin) return false
    const decision = browserPermissionDecision(permission)
    if (decision !== "consent") return decision === "browser" || decision === "chooser"
    let embeddingOrigin = details.embeddingOrigin
    try { embeddingOrigin ??= _webContents?.mainFrame.origin } catch {}
    const resource = permissionResource(permission, details, embeddingOrigin)
    return resource !== undefined && grants.has(key(origin, permission, resource))
  })
  targetSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const revision = browserGuestLifetime.revision(contents)
    const owner = browserGuestLifetime.owner(contents)
    const live = () => Boolean(owner && browserGuestLifetime.owner(contents) === owner && browserGuestLifetime.revision(contents) === revision)
    const decision = browserPermissionDecision(permission)
    if (decision === "deny" || !live()) { callback(false); return }
    const frameOrigins = new Set(contents.mainFrame.framesInSubtree
      .filter(frame => frame.url === details.requestingUrl && (!details.isMainFrame || frame === contents.mainFrame))
      .map(frame => permissionOrigin(frame.origin)).filter((origin): origin is string => Boolean(origin)))
    const origin = permissionOrigin(details.requestingUrl) ?? (frameOrigins.size === 1 ? [...frameOrigins][0] : undefined)
    const resource = permissionResource(permission, details, contents.mainFrame.origin)
    const labels = nativeMenuLabels(owner ?? null)
    const requestKey = key(origin ?? "null", permission, resource)
    if (decision === "unknown" || !origin || resource === undefined) {
      callback(false)
      if (!unknown.has(requestKey)) {
        unknown.add(requestKey)
        const options = { type: "warning" as const, title: origin ?? "null", message: labels.browserPermissionUnknown.replace("{permission}", permission) }
        void (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options))
          .catch(error => console.warn("[browser-permission] closed owner", error))
      }
      return
    }
    if (decision === "browser" || decision === "chooser") { callback(true); return }
    if (grants.has(requestKey)) { callback(true); return }
    let request = pending.get(requestKey)
    if (!request) {
      const options = { type: "question" as const, title: origin,
        message: labels.browserPermission.replace("{permission}", permission).replace("{origin}", origin),
        ...("filePath" in details && typeof details.filePath === "string" ? { detail: details.filePath } : {}),
        buttons: [labels.browserDeny, labels.browserAllow], defaultId: 0, cancelId: 0, noLink: true }
      request = (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options))
        .then(result => {
          if (result.response !== 1 || !live()) return false
          grants.add(requestKey)
          return true
        }, () => false).finally(() => pending.delete(requestKey))
      pending.set(requestKey, request)
    }
    void request.then(allowed => {
      let current = false
      try { current = allowed && live()
        && contents.mainFrame.framesInSubtree.some(frame => permissionOrigin(frame.origin) === origin) } catch {}
      callback(current)
    }).catch(error => console.warn("[browser-permission] expired request", error))
  })
  // Device grants require a chooser selection, not just a general API consent.
  configureBrowserDeviceChoosers(targetSession)
  configureBrowserDisplayChooser(targetSession)
}

export async function requestMicrophoneAccess(): Promise<boolean> {
  if (!isMac) {
    return true
  }

  const status = systemPreferences.getMediaAccessStatus("microphone")
  if (status === "granted") {
    return true
  }

  return systemPreferences.askForMediaAccess("microphone")
}
