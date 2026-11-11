export type BrowserPermissionDecision = "deny" | "browser" | "chooser" | "consent" | "unknown"

const denied = new Set(["media", "camera", "microphone", "geolocation", "geolocation-approximate", "notifications"])
const consent = new Set([
  "clipboard-read", "deprecated-sync-clipboard-read", "local-network-access", "local-network", "loopback-network",
  "fullscreen", "pointerLock", "midi", "midiSysex", "hid", "usb", "serial", "local-fonts", "sensors",
  "screen-wake-lock", "system-wake-lock", "persistent-storage", "storage-access", "top-level-storage-access",
  "window-management", "payment-handler", "fileSystem", "mediaKeySystem", "speaker-selection", "idle-detection",
  "background-fetch", "background-sync", "periodic-background-sync", "display-capture", "keyboardLock",
  "automatic-downloads",
])

export function browserPermissionDecision(permission: string): BrowserPermissionDecision {
  if (denied.has(permission)) return "deny"
  if (permission === "clipboard-sanitized-write") return "browser"
  if (["hid", "usb", "serial", "display-capture"].includes(permission)) return "chooser"
  return consent.has(permission) ? "consent" : "unknown"
}

export function permissionOrigin(raw: string | undefined): string | undefined {
  try {
    const url = new URL(raw ?? "")
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.origin
  } catch {}
}

export function permissionResource(permission: string, details: unknown, embeddingOrigin?: string): string | undefined {
  if (permission === "fileSystem") {
    if (!details || typeof details !== "object") return undefined
    const value = details as { filePath?: unknown; fileAccessType?: unknown; isDirectory?: unknown }
    if (typeof value.filePath !== "string" || !value.filePath || (value.fileAccessType !== "readable" && value.fileAccessType !== "writable")
      || typeof value.isDirectory !== "boolean") return undefined
    return JSON.stringify([value.filePath, value.fileAccessType, value.isDirectory])
  }
  if (permission === "storage-access" || permission === "top-level-storage-access") return permissionOrigin(embeddingOrigin)
  return ""
}
