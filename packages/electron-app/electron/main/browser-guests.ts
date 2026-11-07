import { BrowserWindow, clipboard, dialog, Menu, type WebContents } from "electron"
import { isBrowserDownloadUrlAllowed, isBrowserSiteUrlAllowed, isBrowserUrlAllowed } from "./browser-webview-security"
import { nativeMenuLabels } from "./view-menu"
import { isBrowserDialog } from "./browser-dialog"
import { installBrowserPrompt } from "./browser-prompt"

const windows = new WeakSet<BrowserWindow>()
const guests = new Map<number, BrowserWindow>()
export const isBrowserAuxiliaryWindow = (window: BrowserWindow) => windows.has(window) || isBrowserDialog(window)
export const browserGuestOwner = (contents: WebContents | null) => contents ? guests.get(contents.id) : undefined
let promptConfigured = false
export function configureBrowserGuests(): void {
  if (promptConfigured) return
  promptConfigured = true
  installBrowserPrompt(contents => guests.get(contents.id))
}

export function focusedBrowserGuest(window: BrowserWindow, focused: WebContents | null): WebContents | undefined {
  return focused && guests.get(focused.id) === window && !focused.isDestroyed() ? focused : undefined
}

/** Called before a popup's first navigation, and on each attached preview root. */
export function protectBrowserGuest(owner: BrowserWindow, guest: WebContents, inheritedOrigin = ""): void {
  guests.set(guest.id, owner)
  let origin = isBrowserUrlAllowed(guest.getURL()) ? guest.getURL() : inheritedOrigin
  const children = new Set<BrowserWindow>()
  const closeChildren = () => { for (const child of children) if (!child.isDestroyed()) child.destroy() }
  guest.once("destroyed", () => { guests.delete(guest.id); closeChildren() })
  guest.on("did-navigate", (_event, url) => { if (isBrowserUrlAllowed(url)) origin = url })
  const guard = (event: Electron.Event, url: string) => {
    if (!isBrowserSiteUrlAllowed(url, origin)) event.preventDefault()
  }
  guest.on("will-navigate", guard)
  guest.on("will-redirect", guard)
  guest.on("will-prevent-unload", event => {
    if (owner.isDestroyed()) return
    const l = nativeMenuLabels(owner)
    const response = dialog.showMessageBoxSync(BrowserWindow.fromWebContents(guest) ?? owner, {
      type: "question", title: origin,
      message: l.browserPermission.replace("{permission}", "navigation").replace("{origin}", origin),
      buttons: [l.browserDeny, l.browserAllow], defaultId: 0, cancelId: 0, noLink: true,
    })
    if (response === 1) event.preventDefault()
  })
  guest.setWindowOpenHandler(({ url }) => {
    if (!isBrowserSiteUrlAllowed(url, origin) || owner.isDestroyed()) return { action: "deny" }
    return { action: "allow", outlivesOpener: false, createWindow: options => {
      const popup = new BrowserWindow({ ...options, parent: owner, width: 520, height: 680,
        frame: true, titleBarStyle: "default", autoHideMenuBar: true,
        webPreferences: { ...options.webPreferences, preload: undefined, session: guest.session, nodeIntegration: false, nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webviewTag: false,
          webSecurity: true, allowRunningInsecureContent: false, disableDialogs: false } })
      windows.add(popup)
      children.add(popup)
      popup.setMenu(null)
      popup.once("closed", () => children.delete(popup))
      protectBrowserGuest(owner, popup.webContents, origin)
      return popup.webContents
    } }
  })
  guest.on("context-menu", (_event, params) => {
    if (owner.isDestroyed()) return
    const l = nativeMenuLabels(owner)
    const items: Electron.MenuItemConstructorOptions[] = []
    if (params.isEditable) items.push({ role: "undo", label: l.undo }, { role: "redo", label: l.redo },
      { role: "cut", label: l.cut }, { role: "copy", label: l.copy }, { role: "paste", label: l.paste },
      { role: "selectAll", label: l.selectAll })
    else if (params.selectionText) items.push({ label: l.copy, click: () => guest.copy() })
    if (params.linkURL) items.push({ label: l.browserCopyLink, click: () => clipboard.writeText(params.linkURL) })
    if (isBrowserSiteUrlAllowed(params.linkURL, origin)) items.push(
      { label: l.browserOpenLink, click: () => {
        const frame = params.frame
        if (!guest.isDestroyed() && frame && !frame.detached) void frame.executeJavaScript(`window.open(${JSON.stringify(params.linkURL)},'_blank')`, true)
          .catch(error => console.warn("[browser-popup] expired frame", error))
      } })
    if (params.mediaType === "image" && isBrowserDownloadUrlAllowed(params.srcURL, origin))
      items.push({ label: l.browserSaveImage, click: () => guest.downloadURL(params.srcURL) })
    items.push({ label: l.browserInspect, click: () => guest.inspectElement(params.x, params.y) })
    Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(guest) ?? owner })
  })
}
