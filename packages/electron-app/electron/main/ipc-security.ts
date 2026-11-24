import type { BrowserWindow, IpcMainInvokeEvent } from "electron"

export function validateMainFrame(event: IpcMainInvokeEvent, window: BrowserWindow, allowedOrigins: string[]): void {
  if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error("Native IPC requires a registered main frame")
  }
  const current = new URL(window.webContents.getURL())
  const sender = new URL(event.senderFrame.url)
  if (current.origin !== sender.origin || !allowedOrigins.includes(sender.origin)) {
    throw new Error("Native IPC requires an allowed renderer origin")
  }
}
