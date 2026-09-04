import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { validateMainFrame } from "./ipc-security"
import { requirePreferencesRequest, type PreferencesRequest } from "./preferences-window"

interface IPCRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void
}

interface PreferencesIPCDependencies {
  resolveLocal(sender: IpcMainInvokeEvent["sender"]): { window: BrowserWindow } | undefined
  resolvePreferences(sender: IpcMainInvokeEvent["sender"]): BrowserWindow | undefined
  getAllowedOrigins(window: BrowserWindow): string[]
  openPreferences(request: PreferencesRequest): Promise<void>
  getRequest(window: BrowserWindow): PreferencesRequest | undefined
  markReady(window: BrowserWindow): void
  acceptRequest(window: BrowserWindow, request: PreferencesRequest): void | Promise<void>
  resolveTransition(window: BrowserWindow, id: number, approved: boolean): void
  approveClose(window: BrowserWindow): void | Promise<void>
}

export function setupPreferencesIPC(ipcMain: IPCRegistrar, dependencies: PreferencesIPCDependencies): void {
  const local = (event: IpcMainInvokeEvent): BrowserWindow => {
    const record = dependencies.resolveLocal(event.sender)
    if (!record) throw new Error("Preferences can only be opened from a local window")
    validateMainFrame(event, record.window, dependencies.getAllowedOrigins(record.window))
    return record.window
  }
  const preferences = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = dependencies.resolvePreferences(event.sender)
    if (!window) throw new Error("Window control is limited to the Preferences window")
    validateMainFrame(event, window, dependencies.getAllowedOrigins(window))
    return window
  }
  const controlled = (event: IpcMainInvokeEvent): BrowserWindow => {
    const record = dependencies.resolveLocal(event.sender)
    const window = record?.window ?? dependencies.resolvePreferences(event.sender)
    if (!window) throw new Error("Window control is limited to local application windows")
    validateMainFrame(event, window, dependencies.getAllowedOrigins(window))
    return window
  }

  ipcMain.handle("preferences:open", async (event, section: unknown, context: unknown) => {
    local(event)
    await dependencies.openPreferences(requirePreferencesRequest(section, context))
    return { ok: true }
  })
  ipcMain.handle("preferences:getSection", (event) => {
    const window = preferences(event)
    return dependencies.getRequest(window) ?? { section: "general" }
  })
  ipcMain.handle("preferences:ready", (event) => {
    dependencies.markReady(preferences(event))
    return { ok: true }
  })
  ipcMain.handle("preferences:acceptRequest", async (event, value: unknown) => {
    const window = preferences(event)
    if (!value || typeof value !== "object") throw new Error("Invalid Preferences request")
    const request = value as Record<string, unknown>
    await dependencies.acceptRequest(window, requirePreferencesRequest(request.section, request))
    return { ok: true }
  })
  ipcMain.handle("preferences:resolveTransition", (event, id: unknown, approved: unknown) => {
    if (!Number.isSafeInteger(id) || typeof approved !== "boolean") throw new Error("Invalid Preferences transition response")
    dependencies.resolveTransition(preferences(event), id as number, approved)
    return { ok: true }
  })
  ipcMain.handle("preferences:minimize", (event) => {
    controlled(event).minimize()
    return { ok: true }
  })
  ipcMain.handle("preferences:toggleMaximize", (event) => {
    const window = controlled(event)
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return { maximized: window.isMaximized() }
  })
  ipcMain.handle("preferences:close", async (event) => {
    const window = controlled(event)
    if (dependencies.resolvePreferences(event.sender)) await dependencies.approveClose(window)
    else window.close()
    return { ok: true }
  })
}
