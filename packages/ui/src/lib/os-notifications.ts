import { isElectronHost, isTauriHost } from "./runtime-env"
import { getLogger } from "./logger"

export type OsNotificationPermission = "granted" | "denied" | "default" | "unsupported"

export type OsNotificationCapability = {
  supported: boolean
  permission: OsNotificationPermission
  info?: string
}

export type OsNotificationPayload = {
  title: string
  body: string
}

const log = getLogger("actions")

function hasWebNotificationApi(): boolean {
  return typeof window !== "undefined" && typeof (window as any).Notification !== "undefined"
}

function getWebPermission(): OsNotificationPermission {
  if (!hasWebNotificationApi()) return "unsupported"
  const permission = (window as any).Notification.permission as string
  if (permission === "granted") return "granted"
  if (permission === "denied") return "denied"
  return "default"
}

async function requestWebPermission(): Promise<OsNotificationPermission> {
  if (!hasWebNotificationApi()) return "unsupported"
  try {
    const next = await (window as any).Notification.requestPermission()
    if (next === "granted") return "granted"
    if (next === "denied") return "denied"
    return "default"
  } catch (error) {
    log.warn("[os-notifications] requestPermission failed", error)
    return getWebPermission()
  }
}

async function sendWebNotification(payload: OsNotificationPayload): Promise<void> {
  if (!hasWebNotificationApi()) {
    throw new Error("Web notifications not supported")
  }

  // Browsers generally require permission prior to sending.
  if (getWebPermission() !== "granted") {
    throw new Error("Web notification permission not granted")
  }

  // eslint-disable-next-line no-new
  new (window as any).Notification(payload.title, { body: payload.body })
}

function hasElectronNotifier(): boolean {
  if (typeof window === "undefined") return false
  const api = (window as Window & { electronAPI?: any }).electronAPI
  return Boolean(api && typeof api.showNotification === "function")
}

export function isOsNotificationSupportedSync(): boolean {
  if (typeof window === "undefined") return false
  if (isElectronHost()) {
    return hasElectronNotifier()
  }
  if (isTauriHost()) {
    // The authoritative check requires async import; treat Tauri as supported and let the
    // settings modal surface missing plugin/capability errors.
    return true
  }
  return hasWebNotificationApi()
}

async function sendElectronNotification(payload: OsNotificationPayload): Promise<void> {
  const api = (window as Window & { electronAPI?: any }).electronAPI
  if (!api || typeof api.showNotification !== "function") {
    throw new Error("Electron notification bridge unavailable")
  }
  await api.showNotification(payload)
}

async function getTauriNotificationModule(): Promise<any | null> {
  try {
    const mod = await import("@tauri-apps/plugin-notification")
    return mod
  } catch (error) {
    log.info("[os-notifications] tauri notification plugin not available", error as any)
    return null
  }
}

async function getTauriPermission(): Promise<OsNotificationPermission> {
  const mod = await getTauriNotificationModule()
  if (!mod) return "unsupported"
  try {
    const granted = await mod.isPermissionGranted()
    return granted ? "granted" : "default"
  } catch (error) {
    log.warn("[os-notifications] failed to check tauri notification permission", error)
    return "default"
  }
}

async function requestTauriPermission(): Promise<OsNotificationPermission> {
  const mod = await getTauriNotificationModule()
  if (!mod) return "unsupported"
  try {
    const result = await mod.requestPermission()
    if (result === "granted") return "granted"
    if (result === "denied") return "denied"
    return "default"
  } catch (error) {
    log.warn("[os-notifications] failed to request tauri notification permission", error)
    return await getTauriPermission()
  }
}

async function sendTauriNotification(payload: OsNotificationPayload): Promise<void> {
  const mod = await getTauriNotificationModule()
  if (!mod) {
    throw new Error("Tauri notification plugin unavailable")
  }
  await mod.sendNotification({ title: payload.title, body: payload.body })
}

export async function getOsNotificationCapability(): Promise<OsNotificationCapability> {
  if (typeof window === "undefined") {
    return { supported: false, permission: "unsupported", info: "Not available in this environment." }
  }

  if (isElectronHost()) {
    if (!hasElectronNotifier()) {
      return {
        supported: false,
        permission: "unsupported",
        info: "Electron notification bridge is not available.",
      }
    }

    // Electron notifications are controlled by OS-level settings; Electron doesn't expose a reliable permission probe.
    return {
      supported: true,
      permission: "granted",
      info: "Notifications are managed by your OS notification settings.",
    }
  }

  if (isTauriHost()) {
    const permission = await getTauriPermission()
    const supported = permission !== "unsupported"
    return {
      supported,
      permission,
      info: supported ? undefined : "Tauri notification support is not available in this build.",
    }
  }

  // Web
  const permission = getWebPermission()
  const supported = permission !== "unsupported"
  return {
    supported,
    permission,
    info: supported
      ? undefined
      : "This browser does not support OS notifications (or notifications are blocked by the environment).",
  }
}

export async function requestOsNotificationPermission(): Promise<OsNotificationPermission> {
  if (typeof window === "undefined") return "unsupported"

  if (isElectronHost()) {
    // Electron permissions are handled by the OS. No explicit request mechanism.
    return hasElectronNotifier() ? "granted" : "unsupported"
  }

  if (isTauriHost()) {
    return await requestTauriPermission()
  }

  return await requestWebPermission()
}

export async function sendOsNotification(payload: OsNotificationPayload): Promise<void> {
  if (typeof window === "undefined") {
    return
  }

  if (isElectronHost()) {
    await sendElectronNotification(payload)
    return
  }

  if (isTauriHost()) {
    await sendTauriNotification(payload)
    return
  }

  await sendWebNotification(payload)
}
