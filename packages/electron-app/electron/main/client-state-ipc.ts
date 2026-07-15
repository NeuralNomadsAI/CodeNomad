import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron"
import type { ClientStateManager } from "./client-state"
import {
  createClientStateIPCHandlers,
  createRendererAccessNavigationCommitHandler,
} from "./client-state-ipc-handlers"
import { isAllowedRendererOrigin } from "./permissions"

function validateSender(event: IpcMainInvokeEvent, mainWindow: BrowserWindow, getAllowedOrigins: () => string[]) {
  if (
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error("Client state IPC is only available to the local main window")
  }

  const allowedOrigins = getAllowedOrigins()
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
  mainWindow: BrowserWindow,
  clientState: ClientStateManager,
  getAllowedOrigins: () => string[],
) {
  const handlers = createClientStateIPCHandlers(clientState)
  const handleNavigationCommit = createRendererAccessNavigationCommitHandler(
    clientState,
    (url) => isAllowedRendererOrigin(url, getAllowedOrigins()),
  )

  ipcMain.handle("client-state:claimAccess", async (event, token: unknown) => {
    validateSender(event, mainWindow, getAllowedOrigins)
    return handlers.claimAccess(token)
  })

  ipcMain.handle("client-state:load", async (event, token: unknown) => {
    validateSender(event, mainWindow, getAllowedOrigins)
    return handlers.load(token)
  })

  ipcMain.handle("client-state:save", async (event, token: unknown, snapshot: unknown) => {
    validateSender(event, mainWindow, getAllowedOrigins)
    return handlers.save(token, snapshot)
  })

  ipcMain.handle("client-state:setRestoreEnabled", async (event, token: unknown, enabled: unknown) => {
    validateSender(event, mainWindow, getAllowedOrigins)
    return handlers.setRestoreEnabled(token, enabled)
  })

  ipcMain.handle("client-state:clear", async (event, token: unknown) => {
    validateSender(event, mainWindow, getAllowedOrigins)
    return handlers.clear(token)
  })

  mainWindow.webContents.on("did-navigate", (_event, url) => {
    handleNavigationCommit(url, false, true)
  })
}
