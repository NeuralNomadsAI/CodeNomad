import { session, systemPreferences } from "electron"

const isMac = process.platform === "darwin"

export function isAllowedRendererOrigin(origin: string | undefined | null, allowedOrigins: string[]): boolean {
  if (!origin) {
    return false
  }

  try {
    const normalized = new URL(origin).origin
    return allowedOrigins.includes(normalized)
  } catch {
    return false
  }
}

export function configureMediaPermissionHandlers(getAllowedOrigins: () => string[]) {
  const isAudioMediaRequest = (permission: string, details?: unknown) => {
    if (permission !== "media") {
      return false
    }

    const mediaTypes = (details as { mediaTypes?: string[] } | undefined)?.mediaTypes ?? []
    return mediaTypes.length === 0 || mediaTypes.includes("audio")
  }

  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (!isAudioMediaRequest(permission, details)) {
      return false
    }

    return isAllowedRendererOrigin(requestingOrigin, getAllowedOrigins())
  })

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!isAudioMediaRequest(permission, details)) {
      callback(false)
      return
    }

    const requestingOrigin = (details as { requestingOrigin?: string } | undefined)?.requestingOrigin || webContents.getURL()
    callback(isAllowedRendererOrigin(requestingOrigin, getAllowedOrigins()))
  })
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
