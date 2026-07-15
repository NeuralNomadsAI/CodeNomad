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
  getMainWindow: () => BrowserWindow | null,
  getAllowedOrigins: (window: BrowserWindow | null) => string[],
) {
  const validate = (event: IpcMainInvokeEvent) => {
    const window = getMainWindow()
    validateSender(event, window, getAllowedOrigins(window))
  }
  const handle = (
    channel: string,
    operation: (argument: unknown) => unknown,
  ) => ipcMain.handle(channel, async (event, token: unknown, argument: unknown) => {
    validate(event)
    clientState.assertRendererAccessToken(token)
    return operation(argument)
  })

  ipcMain.handle("client-state:claimAccess", async (event, token: unknown) => {
    validate(event)
    return clientState.claimClientStateAccess(token)
  })
  handle("client-state:load", () => clientState.loadClientState())
  handle("client-state:save", (snapshot) => clientState.saveClientState(snapshot))
  handle("client-state:setRestoreEnabled", (enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Restore enabled must be a boolean")
    return clientState.setRestoreEnabled(enabled)
  })
  handle("client-state:clear", () => clientState.clearClientState())

  return (window: BrowserWindow): void => {
    window.webContents.on("did-navigate", (_event, url) => {
      if (getMainWindow() === window && shouldResetRendererAccessTokenForNavigation(
        url,
        false,
        true,
        (target) => isAllowedRendererOrigin(target, getAllowedOrigins(window)),
      )) {
        clientState.resetRendererAccessToken()
      }
    })
    const resetDestroyedRenderer = () => {
      if (getMainWindow() === window) clientState.resetRendererAccessToken()
    }
    window.webContents.on("render-process-gone", resetDestroyedRenderer)
    window.webContents.on("destroyed", resetDestroyedRenderer)
  }
}
