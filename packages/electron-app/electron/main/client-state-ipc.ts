import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import type { ClientStateManager } from "./client-state"
import { shouldResetRendererAccessTokenForNavigation } from "./client-state-navigation"
import { isAllowedRendererOrigin } from "./renderer-origin"

interface IPCRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
}

function validateSender(event: IpcMainInvokeEvent, mainWindow: BrowserWindow | null, allowedOrigins: string[]) {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error("Client state IPC is only available to the local main window")
  }

  const currentUrl = mainWindow.webContents.getURL()
  if (
    !isAllowedRendererOrigin(currentUrl, allowedOrigins) ||
    !isAllowedRendererOrigin(event.senderFrame.url, allowedOrigins) ||
    new URL(currentUrl).origin !== new URL(event.senderFrame.url).origin
  ) {
    throw new Error("Client state IPC is not available to the current renderer origin")
  }
}

export function setupClientStateIPC(
  ipcMain: IPCRegistrar,
  clientState: ClientStateManager,
  resolveWindow: (sender: IpcMainInvokeEvent["sender"]) => { id: string; window: BrowserWindow; persisted?: boolean } | undefined,
  getAllowedOrigins: (window: BrowserWindow | null) => string[],
) {
  const validate = (event: IpcMainInvokeEvent) => {
    const record = resolveWindow(event.sender)
    const window = record?.window ?? null
    validateSender(event, window, getAllowedOrigins(window))
    return record!
  }
  const handle = (
    channel: string,
    operation: (argument: unknown, token: unknown, windowId: string) => unknown,
  ) => ipcMain.handle(channel, async (event, token: unknown, argument: unknown) => {
    const { id: windowId, persisted } = validate(event)
    if (persisted === false) throw new Error("Client state persistence is unavailable for this window")
    clientState.assertRendererAccessToken(token, windowId)
    return operation(argument, token, windowId)
  })

  ipcMain.handle("client-state:claimAccess", async (event, token: unknown) => {
    const record = validate(event)
    return record.persisted === false ? false : clientState.claimClientStateAccess(token, record.id)
  })
  handle("client-state:load", (_argument, _token, windowId) => clientState.loadClientState(windowId))
  handle("client-state:save", (snapshot, token, windowId) => clientState.saveClientState(snapshot, token, windowId))
  handle("client-state:commitPartitions", (payload, token, windowId) => clientState.commitClientStatePartitions(payload, token, windowId))
  handle("client-state:loadPartition", (key, token, windowId) => clientState.loadClientStatePartition(key, token, windowId))
  handle("client-state:setRestoreEnabled", (enabled, token, windowId) => {
    if (typeof enabled !== "boolean") throw new Error("Restore enabled must be a boolean")
    return clientState.setRestoreEnabled(enabled, token, windowId)
  })
  handle("client-state:clear", (_argument, token, windowId) => clientState.clearClientState(token, windowId))

  return (window: BrowserWindow): void => {
    const webContents = window.webContents
    webContents.on("did-navigate", (_event, url) => {
      const record = resolveWindow(webContents)
      if (record && record.persisted !== false && shouldResetRendererAccessTokenForNavigation(
        url,
        false,
        true,
        (target) => isAllowedRendererOrigin(target, getAllowedOrigins(window)),
      )) {
        clientState.resetRendererAccessToken(record.id)
      }
    })
    const resetDestroyedRenderer = () => {
      const record = resolveWindow(webContents)
      if (record && record.persisted !== false) clientState.resetRendererAccessToken(record.id)
    }
    webContents.on("render-process-gone", resetDestroyedRenderer)
    webContents.on("destroyed", resetDestroyedRenderer)
  }
}
