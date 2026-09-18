import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type { RuntimeEnvironment } from "../runtime-env"

export interface BrowserTargetBounds {
  x: number
  y: number
  width: number
  height: number
}

export function selectBrowserOpenOwner<T extends { id: string }>(
  owners: readonly T[],
  activeInstanceId: string | undefined,
): T | undefined {
  const activeOwner = activeInstanceId ? owners.find((owner) => owner.id === activeInstanceId) : undefined
  if (activeOwner) return activeOwner
  return owners.length === 1 ? owners[0] : undefined
}

export function nativeBrowserHost(
  environment: Pick<RuntimeEnvironment, "host" | "windowContext">,
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): "electron" | "tauri" | undefined {
  if (environment.windowContext !== "local") return undefined
  if (environment.host === "electron") return "electron"
  if (environment.host === "tauri" && userAgent.includes("Windows")) return "tauri"
  return undefined
}

export function physicalBrowserBounds(rect: Pick<DOMRect, "x" | "y" | "width" | "height">, scale: number): BrowserTargetBounds {
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
  }
}

export async function registerTauriBrowserTarget(payload: {
  sessionId: string
  registrationId: string
  url: string
  bounds: BrowserTargetBounds
}): Promise<void> {
  await invoke("browser_target_register", { payload })
}

export async function updateTauriBrowserTarget(
  registrationId: string,
  bounds: BrowserTargetBounds | undefined,
  visible = true,
): Promise<void> {
  await invoke("browser_target_update", { payload: { registrationId, bounds, visible } })
}

export async function controlTauriBrowserTarget(registrationId: string, action: "back" | "reload" | "navigate", url?: string): Promise<void> {
  await invoke("browser_target_action", { payload: { registrationId, action, url } })
}

export async function unregisterTauriBrowserTarget(registrationId: string): Promise<void> {
  await invoke("browser_target_unregister", { registrationId })
}

export async function onNativeBrowserOpen(
  callback: (payload: { sessionID: string; url: string; requestID: string }) => void,
): Promise<() => void> {
  const electronUnsubscribe = window.electronAPI?.onBrowserOpenRequest?.(callback)
  if (electronUnsubscribe) return electronUnsubscribe
  if (nativeBrowserHost({ host: window.__CODENOMAD_RUNTIME_HOST__ ?? "web", windowContext: window.__CODENOMAD_WINDOW_CONTEXT__ ?? "remote" }) !== "tauri") {
    return () => {}
  }
  return listen<{ sessionID: string; url: string; requestID: string }>("browser-target:open", (event) => callback(event.payload))
}

export async function claimNativeBrowserOpen(requestID: string): Promise<boolean> {
  if (window.electronAPI?.claimBrowserOpen) return window.electronAPI.claimBrowserOpen(requestID)
  return invoke<boolean>("browser_target_claim_open", { requestId: requestID })
}

export async function releaseNativeBrowserOpen(requestID: string): Promise<boolean> {
  if (window.electronAPI?.releaseBrowserOpen) return window.electronAPI.releaseBrowserOpen(requestID)
  return invoke<boolean>("browser_target_release_open", { requestId: requestID })
}

export function onTauriBrowserNavigation(
  registrationId: string,
  callback: (url: string) => void,
): Promise<() => void> {
  return listen<{ registrationId: string; url: string }>("browser-target:navigated", (event) => {
    if (event.payload.registrationId === registrationId) callback(event.payload.url)
  })
}
