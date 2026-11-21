import { BrowserWindow, clipboard, dialog, Menu, type WebContents } from "electron"
import { isBrowserDownloadUrlAllowed, isBrowserSiteUrlAllowed, isBrowserUrlAllowed } from "./browser-webview-security"
import { nativeMenuLabels } from "./view-menu"
import { isBrowserDialog } from "./browser-dialog"
import { installBrowserPrompt } from "./browser-prompt"
import { browserGuestLifetime } from "./browser-guest-lifetime"
import { browserPresentationTitle, isPrivatePreviewUrl, restrictedBrowserGuest } from "./browser-presentation"

const windows = new WeakSet<BrowserWindow>()
const observedOwners = new WeakSet<BrowserWindow>()
export const isBrowserAuxiliaryWindow = (window: BrowserWindow) => windows.has(window) || isBrowserDialog(window)
export const browserGuestOwner = (contents: WebContents | null) => browserGuestLifetime.owner(contents)
let promptConfigured = false
export function configureBrowserGuests(): void {
  if (promptConfigured) return
  promptConfigured = true
  installBrowserPrompt(browserGuestOwner)
}

export function focusedBrowserGuest(window: BrowserWindow, focused: WebContents | null): WebContents | undefined {
  return focused && browserGuestOwner(focused) === window ? focused : undefined
}

/** Called before a popup's first navigation, and on each attached preview root. */
export function protectBrowserGuest(owner: BrowserWindow, guest: WebContents, inheritedOrigin = "", parent?: WebContents, popup?: BrowserWindow): void {
  browserGuestLifetime.register(owner, guest, parent, popup)
  if (!observedOwners.has(owner)) {
    observedOwners.add(owner)
    const cleanup = () => browserGuestLifetime.removeOwner(owner)
    owner.on("close", event => { if (!event.defaultPrevented) cleanup() })
    owner.once("closed", cleanup)
    owner.webContents.once("destroyed", cleanup)
    owner.webContents.on("did-navigate", cleanup)
    owner.webContents.on("render-process-gone", cleanup)
  }
  const live = () => browserGuestLifetime.live(guest)
  let origin = isBrowserUrlAllowed(guest.getURL()) ? guest.getURL() : inheritedOrigin
  guest.once("destroyed", () => browserGuestLifetime.remove(guest))
  guest.on("render-process-gone", () => browserGuestLifetime.replaceDocument(guest))
  guest.on("did-fail-load", (_event, code, _description, url, main) => {
    if (main && code !== -3 && live() && isPrivatePreviewUrl(url)) void guest.loadURL("about:blank").catch(() => {})
  })
  guest.on("did-navigate", (_event, url) => {
    browserGuestLifetime.replaceDocument(guest)
    if (live() && isBrowserUrlAllowed(url)) origin = url
  })
  guest.on("did-frame-navigate", (_event, _url, _code, _status, main) => {
    if (!main) browserGuestLifetime.invalidateCallbacks(guest)
  })
  const guard = (event: Electron.Event, url: string) => {
    if (!live() || !isBrowserSiteUrlAllowed(url, origin)) event.preventDefault()
  }
  guest.on("will-navigate", guard)
  guest.on("will-redirect", guard)
  guest.on("will-prevent-unload", event => {
    if (!live()) { event.preventDefault(); return }
    const l = nativeMenuLabels(owner)
    const title = browserPresentationTitle(guest, origin)
    const response = dialog.showMessageBoxSync(BrowserWindow.fromWebContents(guest) ?? owner, {
      type: "question", title,
      message: l.browserPermission.replace("{permission}", "navigation").replace("{origin}", title),
      buttons: [l.browserDeny, l.browserAllow], defaultId: 0, cancelId: 0, noLink: true,
    })
    if (response === 1) event.preventDefault()
  })
  guest.setWindowOpenHandler(({ url }) => {
    if (!live() || restrictedBrowserGuest(guest) || isPrivatePreviewUrl(url) || !isBrowserSiteUrlAllowed(url, origin)) return { action: "deny" }
    const document = browserGuestLifetime.revision(guest)
    return { action: "allow", outlivesOpener: false, createWindow: options => {
      if (!live() || browserGuestLifetime.revision(guest) !== document) throw new Error("Expired preview opener")
      const popup = new BrowserWindow({ ...options, parent: owner, width: 520, height: 680,
        frame: true, titleBarStyle: "default", autoHideMenuBar: true,
        webPreferences: { ...options.webPreferences, preload: undefined, session: guest.session, nodeIntegration: false, nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: true, contextIsolation: true, sandbox: true, webviewTag: false,
          webSecurity: true, allowRunningInsecureContent: false, disableDialogs: false } })
      windows.add(popup)
      popup.setMenu(null)
      protectBrowserGuest(owner, popup.webContents, origin, guest, popup)
      return popup.webContents
    } }
  })
  guest.on("context-menu", (_event, params) => {
    if (!live() || restrictedBrowserGuest(guest) || isPrivatePreviewUrl(params.linkURL) || isPrivatePreviewUrl(params.srcURL)) return
    const document = browserGuestLifetime.revision(guest)
    const current = () => live() && browserGuestLifetime.revision(guest) === document
    const l = nativeMenuLabels(owner)
    const items: Electron.MenuItemConstructorOptions[] = []
    if (params.isEditable) items.push({ role: "undo", label: l.undo }, { role: "redo", label: l.redo },
      { role: "cut", label: l.cut }, { role: "copy", label: l.copy }, { role: "paste", label: l.paste },
      { role: "selectAll", label: l.selectAll })
    else if (params.selectionText) items.push({ label: l.copy, click: () => guest.copy() })
    if (params.linkURL) items.push({ label: l.browserCopyLink, click: () => { if (current()) clipboard.writeText(params.linkURL) } })
    if (isBrowserSiteUrlAllowed(params.linkURL, origin)) items.push(
      { label: l.browserOpenLink, click: () => {
        const frame = params.frame
        if (current() && frame && !frame.detached) void frame.executeJavaScript(`window.open(${JSON.stringify(params.linkURL)},'_blank')`, true)
          .catch(error => console.warn("[browser-popup] expired frame", error))
      } })
    if (params.mediaType === "image" && isBrowserDownloadUrlAllowed(params.srcURL, origin))
      items.push({ label: l.browserSaveImage, click: () => { if (current()) guest.downloadURL(params.srcURL) } })
    items.push({ label: l.browserInspect, click: () => { if (current()) guest.inspectElement(params.x, params.y) } })
    Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(guest) ?? owner })
  })
  guest.on("before-input-event", (event, input) => {
    if (restrictedBrowserGuest(guest) && (input.control || input.meta) && ["p", "c", "x"].includes(input.key?.toLowerCase() ?? "")) event.preventDefault()
  })
}
