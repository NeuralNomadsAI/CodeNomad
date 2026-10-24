import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type { RuntimeEnvironment } from "../runtime-env"
import type { BrowserEmulationPreset } from "./browser-emulation"
import { historyUrl, type NativeBrowserHistory } from "../browser-history"

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

export async function readBrowserHistory(registrationId: string, guestWebContentsId?: number): Promise<NativeBrowserHistory> {
  const value = window.electronAPI?.browserTargetHistory
    ? await window.electronAPI.browserTargetHistory(guestWebContentsId!)
    : await invoke<NativeBrowserHistory>("browser_target_action", { payload: { registrationId, action: "history" } })
  if (!value || !Array.isArray(value.entries) || value.entries.length > 32 || !Number.isInteger(value.index)
    || value.index < -1 || value.index >= value.entries.length
    || value.entries.some(entry => !entry || !Number.isSafeInteger(entry.id) || !historyUrl(entry.url))) throw new Error("Native browser history is unavailable")
  return value
}

export async function goToBrowserHistoryEntry(registrationId: string, entryId: number, guestWebContentsId?: number): Promise<void> {
  if (window.electronAPI?.browserTargetHistory) { await window.electronAPI.browserTargetHistory(guestWebContentsId!, entryId); return }
  await invoke("browser_target_action", { payload: { registrationId, action: "history-go", entryId } })
}

export async function unregisterTauriBrowserTarget(registrationId: string): Promise<void> {
  await invoke("browser_target_unregister", { registrationId })
}

export async function emulateBrowserTarget(registrationId: string, preset: BrowserEmulationPreset): Promise<void> {
  if (window.electronAPI?.emulateBrowserTarget) return window.electronAPI.emulateBrowserTarget(registrationId, preset)
  await invoke("browser_target_action", { payload: { registrationId, action: "emulate", preset } })
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
