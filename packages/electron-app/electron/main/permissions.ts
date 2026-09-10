import { session, systemPreferences, type Session } from "electron"
import { isAllowedRendererOrigin } from "./renderer-origin"

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
  targetSession.setPermissionCheckHandler(() => false)
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  targetSession.setDevicePermissionHandler(() => false)
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
