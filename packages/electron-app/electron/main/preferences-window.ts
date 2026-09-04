import type { BrowserWindow, WebContents } from "electron"
import { requireHttpUrl } from "./navigation-security"

export const PREFERENCES_SECTIONS = [
  "general", "chat", "notifications", "speech", "remote", "opencode",
  "providers", "sidecars", "config-files", "advanced", "info",
] as const

export type PreferencesSection = typeof PREFERENCES_SECTIONS[number]

export interface PreferencesRequest {
  section: PreferencesSection
  instanceId?: string
  location?: { directory: string; workspaceID?: string }
}

export function requirePreferencesSection(value: unknown): PreferencesSection {
  if (typeof value !== "string" || !(PREFERENCES_SECTIONS as readonly string[]).includes(value)) {
    throw new Error("Invalid preferences section")
  }
  return value as PreferencesSection
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`Invalid Preferences ${name}`)
  return value
}

export function requirePreferencesRequest(section: unknown, context: unknown): PreferencesRequest {
  const request: PreferencesRequest = { section: requirePreferencesSection(section) }
  if (context === undefined || context === null) return request
  if (typeof context !== "object") throw new Error("Invalid Preferences context")
  const candidate = context as Record<string, unknown>
  request.instanceId = optionalString(candidate.instanceId, "instance ID", 512)
  if (candidate.location !== undefined && candidate.location !== null) {
    if (typeof candidate.location !== "object") throw new Error("Invalid Preferences location")
    const location = candidate.location as Record<string, unknown>
    const directory = optionalString(location.directory, "directory", 32768)
    if (!directory) throw new Error("Invalid Preferences directory")
    request.location = {
      directory,
      ...(optionalString(location.workspaceID, "workspace ID", 512) ? { workspaceID: location.workspaceID as string } : {}),
    }
  }
  return request
}

export function createPreferencesUrl(baseUrl: string, section: PreferencesSection): URL {
  const target = requireHttpUrl(baseUrl, "backendUrl")
  target.searchParams.set("preferences", section)
  return target
}

export class PreferencesWindowRegistry {
  private record: { window: BrowserWindow; request: PreferencesRequest; loaded: boolean; guarded: boolean; navigationPending: boolean; closeApproved: boolean } | undefined

  register(window: BrowserWindow, request: PreferencesRequest): void {
    if (this.current()) throw new Error("Preferences window is already registered")
    const record = { window, request, loaded: false, guarded: false, navigationPending: false, closeApproved: false }
    this.record = record
    window.webContents.on("did-finish-load", () => {
      if (this.record !== record) return
      record.loaded = true
      record.navigationPending = false
      window.webContents.send("preferences:section", record.request)
    })
    window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (this.record !== record || isInPlace || !isMainFrame) return
      record.loaded = false
      record.guarded = false
      record.navigationPending = false
    })
    window.on("close", (event) => {
      if (this.record !== record || !record.guarded || record.closeApproved) return
      event.preventDefault()
      window.webContents.send("preferences:close-requested")
    })
    window.on("closed", () => {
      if (this.record === record) this.record = undefined
    })
  }

  reuse(request: PreferencesRequest): BrowserWindow | undefined {
    const window = this.current()
    if (!window) return undefined
    if (!this.record!.guarded || this.record!.navigationPending) this.record!.request = request
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    if (this.record!.loaded && !window.webContents.isDestroyed()) {
      window.webContents.send("preferences:section", request)
    }
    return window
  }

  current(): BrowserWindow | undefined {
    if (!this.record || this.record.window.isDestroyed()) {
      this.record = undefined
      return undefined
    }
    return this.record.window
  }

  resolve(sender: WebContents): BrowserWindow | undefined {
    const window = this.current()
    return window?.webContents === sender ? window : undefined
  }

  request(window: BrowserWindow): PreferencesRequest | undefined {
    return this.current() === window ? this.record?.request : undefined
  }

  markReady(window: BrowserWindow): void {
    if (this.current() === window) this.record!.guarded = true
  }

  isReady(window: BrowserWindow): boolean {
    return this.current() === window && Boolean(this.record?.guarded)
  }

  prepareNavigation(window: BrowserWindow): void {
    if (this.current() === window) this.record!.navigationPending = true
  }

  cancelNavigation(window: BrowserWindow): void {
    if (this.current() === window) this.record!.navigationPending = false
  }

  acceptRequest(window: BrowserWindow, request: PreferencesRequest): void {
    if (this.current() === window) this.record!.request = request
  }

  suspendGuard(window: BrowserWindow): void {
    if (this.current() === window) this.record!.guarded = false
  }

  approveClose(window: BrowserWindow): void {
    if (this.current() !== window) return
    this.record!.closeApproved = true
    window.close()
  }
}
