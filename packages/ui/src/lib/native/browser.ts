import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import type { RuntimeEnvironment } from "../runtime-env"
import type { BrowserEmulationPreset } from "./browser-emulation"
import { historyUrl, type NativeBrowserHistory } from "../browser-history"

export interface BrowserTargetBounds {
  x: number
  y: number
  width: number
  height: number
}
export interface BrowserPresentation {
  css: boolean
  viewport?: { width: number; height: number }
}

export function selectBrowserOpenOwner<T extends { id: string }>(owners: readonly T[], activeInstanceId?: string): T | undefined {
  return owners.find(owner => owner.id === activeInstanceId) ?? (owners.length === 1 ? owners[0] : undefined)
}

export interface BrowserHostCapabilities {
  embedding: boolean
  history: boolean
  emulation: boolean
  automation: boolean
  ownership?: boolean
  reason?: "webkit" | "unsupported-platform"
}

export function browserHostCapabilities(environment: Pick<RuntimeEnvironment, "host" | "windowContext">): BrowserHostCapabilities {
  if (environment.windowContext !== "local") return { embedding: false, history: false, emulation: false, automation: false }
  if (environment.host === "electron") return { embedding: true, history: true, emulation: true, automation: true }
  return (environment.host === "tauri" && typeof window !== "undefined" && window.__CODENOMAD_BROWSER_CAPABILITIES__)
    || { embedding: false, history: false, emulation: false, automation: false, reason: "unsupported-platform" }
}

export function localOverlayOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'))
}

export function nativeBrowserHost(
  environment: Pick<RuntimeEnvironment, "host" | "windowContext">,
): "electron" | "tauri" | undefined {
  if (environment.windowContext !== "local") return undefined
  if (environment.host === "electron") return "electron"
  if (environment.host === "tauri" && browserHostCapabilities(environment).embedding) return "tauri"
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
  openRequestId?: string
  instanceId?: string
  registrationId: string
  url: string
  bounds: BrowserTargetBounds
  presentation?: BrowserPresentation
  logicalAddress?: string
}): Promise<void> {
  await invoke("browser_target_register", { payload: { ...payload, visible: false } })
}

export async function updateTauriBrowserTarget(
  registrationId: string,
  bounds: BrowserTargetBounds | undefined,
  visible = true,
  presentation?: BrowserPresentation,
  instanceId?: string,
): Promise<void> {
  await invoke("browser_target_update", { payload: { registrationId, bounds, visible, presentation, instanceId } })
}

export async function controlTauriBrowserTarget(registrationId: string, action: "back" | "reload" | "navigate", url?: string, logicalAddress?: string): Promise<void> {
  await invoke("browser_target_action", { payload: { registrationId, action, url, ...(logicalAddress ? { logicalAddress } : {}) } })
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

export async function emulateBrowserTarget(registrationId: string, preset: BrowserEmulationPreset, viewport?: { width: number; height: number }): Promise<void> {
  if (window.electronAPI?.emulateBrowserTarget) return window.electronAPI.emulateBrowserTarget(registrationId, preset)
  await invoke("browser_target_action", { payload: { registrationId, action: "emulate", preset, ...(viewport ? { viewport } : {}) } })
}

export type BrowserPreviewOwnership = { sessionId: string; revision: number; owner: { instanceId: string; sameWindow: boolean } | null }
export type BrowserPreviewOwnershipAction =
  | { action: "request" | "focus" | "used"; sessionId: string; instanceId: string; revision?: number }
  | { action: "ready"; sessionId: string; instanceId: string; requestID: string }
  | { action: "release"; instanceId: string }

export function hasNativePreviewOwnership() {
  return typeof window !== "undefined" && (Boolean(window.electronAPI?.browserPreviewOwnership) ||
    (window.__CODENOMAD_RUNTIME_HOST__ === "tauri" && window.__CODENOMAD_WINDOW_CONTEXT__ === "local"
      && window.__CODENOMAD_BROWSER_CAPABILITIES__?.ownership === true))
}

export function changeBrowserPreviewOwnership(input: BrowserPreviewOwnershipAction): Promise<BrowserPreviewOwnership | undefined> | undefined {
  if (!hasNativePreviewOwnership()) return
  if (window.electronAPI?.browserPreviewOwnership) return window.electronAPI.browserPreviewOwnership(input)
  return invoke("browser_target_ownership", { input })
}

export async function onBrowserPreviewOwnership(
  change: (payload: BrowserPreviewOwnership) => void,
  focus: (payload: { sessionId: string; instanceId: string }) => void,
) {
  if (window.electronAPI?.onBrowserPreviewOwnership) {
    const stop = window.electronAPI.onBrowserPreviewOwnership(change)
    const stopFocus = window.electronAPI.onBrowserPreviewFocus?.(focus)
    return () => { stop(); stopFocus?.() }
  }
  if (window.__CODENOMAD_RUNTIME_HOST__ !== "tauri" || window.__CODENOMAD_WINDOW_CONTEXT__ !== "local") return () => {}
  const view = getCurrentWebview()
  const stop = await view.listen<BrowserPreviewOwnership>("browser-target:ownership", e => change(e.payload))
  try {
    const stopFocus = await view.listen<Parameters<typeof focus>[0]>("browser-target:focus-owner", e => focus(e.payload))
    return () => { stop(); stopFocus() }
  } catch (error) { stop(); throw error }
}

export type BrowserOpenDiscovery = { requestID: string; workspaceIDs: string[]; sessionID: string }
export type BrowserOpenRequest = { sessionID: string; requestID: string; url: string; instanceId: string }
export type BrowserOpenSettled = Omit<BrowserOpenRequest, "url"> & { committedUrl?: string | null; keepGuest?: boolean; successorUrl?: string | null }
export type BrowserOpenResponse =
  | { kind: "discover"; instanceId: string | null }
  | { kind: "target"; instanceId: string; registrationId: string }

export async function onNativeBrowserOpen(
  discover: (payload: BrowserOpenDiscovery) => void,
  open: (payload: BrowserOpenRequest) => void,
  settled: (payload: BrowserOpenSettled) => void,
): Promise<() => void> {
  const environment = { host: window.__CODENOMAD_RUNTIME_HOST__ ?? "web", windowContext: window.__CODENOMAD_WINDOW_CONTEXT__ ?? "remote" }
  const host = nativeBrowserHost(environment)
  if (host === "electron") {
    const cleanupDiscovery = window.electronAPI?.onBrowserOpenDiscovery?.(discover)
    const cleanupOpen = window.electronAPI?.onBrowserOpenRequest?.(open)
    const cleanupSettled = window.electronAPI?.onBrowserOpenSettled?.(settled)
    return () => { cleanupDiscovery?.(); cleanupOpen?.(); cleanupSettled?.() }
  }
  if (host !== "tauri") return () => {}
  const webview = getCurrentWebview()
  const cleanups: Array<() => void> = []
  const cleanup = () => cleanups.forEach(stop => stop())
  try {
    cleanups.push(await webview.listen<BrowserOpenSettled>("browser-target:open-settled", event => settled(event.payload)))
    cleanups.push(await webview.listen<BrowserOpenRequest>("browser-target:open", event => open(event.payload)))
    cleanups.push(await webview.listen<BrowserOpenDiscovery>("browser-target:discover", event => discover(event.payload)))
    return cleanup
  } catch (error) { cleanup(); throw error }
}

export async function claimNativeBrowserOpen(requestID: string, response: BrowserOpenResponse): Promise<boolean> {
  if (window.electronAPI?.claimBrowserOpen) return window.electronAPI.claimBrowserOpen(requestID, response)
  return invoke<boolean>("browser_target_claim_open", { requestId: requestID, response })
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
