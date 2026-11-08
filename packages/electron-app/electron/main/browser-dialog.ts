import { BrowserWindow, type WebContents } from "electron"
import { randomUUID } from "node:crypto"
import { nativeMenuLabels } from "./view-menu"

const escape = (text: string) => text.replace(/[&<>"']/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value]!)
const dialogs = new WeakSet<BrowserWindow>()
export const isBrowserDialog = (window: BrowserWindow) => dialogs.has(window)

/** Trusted, preload-free app form. Only its own cancelled navigation returns data. */
export async function showBrowserDialog(owner: BrowserWindow, origin: string, message: string,
  input: { text: string } | { choices: readonly string[] }, source?: WebContents,
  current: () => boolean = () => !owner.isDestroyed() && !source?.isDestroyed()): Promise<string | null> {
  const [{ default: windowCss }, { default: dialogCss }] = await Promise.all([
    import("../../../ui/src/styles/components/window.css?raw"),
    import("../../../ui/src/styles/components/browser-native-dialog.css?raw"),
  ])
  if (!current()) return null
  const l = nativeMenuLabels(owner)
  const target = `https://codenomad.invalid/${randomUUID()}`
  const field = "text" in input
    ? `<input id="value" name="value" value="${escape(input.text)}" autofocus>`
    : `<select id="value" name="value" size="10" required autofocus><option value="" disabled selected></option>${input.choices.map((choice, index) => `<option value="${index}">${escape(choice)}</option>`).join("")}</select>`
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action https://codenomad.invalid"><style>${windowCss}\n${dialogCss}</style><body class="browser-native-dialog"><form action="${target}"><main class="window-body"><label for="value">${escape(message)}</label>${field}</main><footer class="window-footer"><button class="button-primary" name="action" value="accept">${escape(l.browserPromptAccept)}</button><button class="button-secondary" name="action" value="cancel" formnovalidate>${escape(l.browserPromptCancel)}</button></footer></form>`
  const dialog = new BrowserWindow({ parent: owner, modal: true, show: false, width: 520, height: "text" in input ? 240 : 440,
    title: origin, autoHideMenuBar: true,
    webPreferences: { partition: `browser-dialog-${randomUUID()}`, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false, disableDialogs: true } })
  dialogs.add(dialog)
  dialog.webContents.session.setPermissionCheckHandler(() => false)
  dialog.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  dialog.setMenu(null)
  dialog.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  return new Promise(resolve => {
    let settled = false
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      owner.removeListener("closed", cancel)
      source?.removeListener("destroyed", cancel)
      source?.removeListener("did-navigate", cancel)
      source?.removeListener("did-frame-navigate", cancel)
      source?.removeListener("render-process-gone", cancel)
      resolve(current() ? value : null)
      if (!dialog.isDestroyed()) dialog.destroy()
    }
    const cancel = () => finish(null)
    owner.once("closed", cancel)
    source?.once("destroyed", cancel)
    source?.once("did-navigate", cancel)
    source?.once("did-frame-navigate", cancel)
    source?.once("render-process-gone", cancel)
    dialog.once("closed", cancel)
    dialog.webContents.on("will-navigate", (event, url) => {
      event.preventDefault()
      try {
        const result = new URL(url)
        if (`${result.origin}${result.pathname}` !== target) return
        finish(result.searchParams.get("action") === "accept" ? result.searchParams.get("value") ?? "" : null)
      } catch { finish(null) }
    })
    dialog.webContents.on("before-input-event", (_event, key) => { if (key.type === "keyDown" && key.key === "Escape") cancel() })
    dialog.once("ready-to-show", () => { if (!dialog.isDestroyed()) dialog.show() })
    void dialog.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(cancel)
  })
}
