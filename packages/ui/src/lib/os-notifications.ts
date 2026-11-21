import { invoke } from "@tauri-apps/api/core"
import { isElectronHost, isTauriHost } from "./runtime-env"
import { getLogger } from "./logger"
import { createNotificationClicks } from "./notification-click"

export type OsNotificationPermission = "granted" | "denied" | "default" | "unsupported"

export type OsNotificationCapability = {
  supported: boolean
  permission: OsNotificationPermission
  info?: string
}

export type OsNotificationPayload = {
  title: string
  body: string
  signal?: AbortSignal
  onClick?: () => void | Promise<void>
}

const log = getLogger("actions")
const clicks = createNotificationClicks()
let listening = false

function listenForNativeClicks(): void {
  if (listening) return
  listening = true
  const run = (id: unknown) => {
    void clicks.run(id).catch(error => log.warn("[os-notifications] action failed", error))
  }
  if (isElectronHost()) window.electronAPI?.onNotificationClick?.(run)
  else window.addEventListener("codenomad:notification-click", event => run((event as CustomEvent).detail))
}

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

  // Routed notifications wait for permission: until it is granted nothing is sent, silently.
  if (getWebPermission() !== "granted") return

  const notification: Notification = new window.Notification(payload.title, { body: payload.body })
  notification.onclick = () => {
    if (payload.signal?.aborted) return
    window.focus()
    notification.close()
    void Promise.resolve(payload.onClick?.()).catch(error => log.warn("[os-notifications] action failed", error))
  }
  const revoke = () => notification.close()
  payload.signal?.addEventListener("abort", revoke, { once: true })
  notification.addEventListener("close", () => payload.signal?.removeEventListener("abort", revoke), { once: true })
}

function hasElectronNotifier(): boolean {
  return typeof window !== "undefined" && typeof window.electronAPI?.showNotification === "function"
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
    // Ask the native plugin directly rather than the page script's cached state.
    const granted = await invoke<boolean | null>("plugin:notification|is_permission_granted")
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

async function sendNativeNotification(payload: OsNotificationPayload, electron: boolean): Promise<void> {
  listenForNativeClicks()
  const { title, body, onClick, signal } = payload
  const actionId = onClick ? clicks.remember({ onClick, signal }) : undefined
  try {
    if (electron) {
      const result = await window.electronAPI?.showNotification?.({ title, body, actionId })
      if (!result?.ok && actionId) clicks.forget(actionId)
    } else {
      await invoke("notification_show", { title, body, actionId })
    }
  } catch (error) {
    if (actionId) clicks.forget(actionId)
    throw error
  }
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
  if (payload.signal?.aborted) return
  if (typeof window === "undefined") {
    return
  }

  const electron = isElectronHost()
  if (electron || isTauriHost()) {
    await sendNativeNotification(payload, electron)
    return
  }

  await sendWebNotification(payload)
}
