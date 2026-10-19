// No application profile, backend or visible desktop window. The production controller's
// ownership/registration checks still run; visibility is supplied by this fixture explicitly.
const { app, BrowserWindow } = require("electron")
app.setPath("userData", process.env.CODENOMAD_TEST_PROFILE)
app.whenReady().then(async () => {
  const { BrowserController, BrowserPage, handleNativeBrowserRequest } = require(process.env.CODENOMAD_TEST_AUTOMATION_BUNDLE)
  const window = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  let visible = true, guest
  const controller = new BrowserController(() => {}, {
    fromId: id => guest && guest.id === id ? guest : null,
    fromWebContents: owner => owner === window.webContents ? {
      isDestroyed: () => window.isDestroyed(), isVisible: () => visible, isMinimized: () => false,
    } : null,
  })
  window.webContents.on("did-attach-webview", (_event, contents) => {
    guest = contents
    controller.observeGuest(window.webContents, guest)
    controller.register(window.webContents, { sessionId: "fixture-session", registrationId: "fixture-guest", guestWebContentsId: guest.id })
  })
  const browser = new BrowserPage({ request: (method, params, timeout = 25000) =>
    handleNativeBrowserRequest(controller, method, params, Date.now() + timeout) })
  globalThis.automationPreview = {
    execute: action => browser.execute("fixture-session", action),
    navigate: url => controller.execute("fixture-session", { action: "navigate", url }),
    visible: value => { visible = value },
    ready: () => Boolean(guest && !guest.isLoading()),
  }
  const html = `<html><body style="margin:0"><webview src="${process.env.CODENOMAD_TEST_GUEST_URL}" style="width:850px;height:650px;display:flex"></webview></body></html>`
  await window.loadURL(`data:text/html,${encodeURIComponent(html)}`)
})
app.on("window-all-closed", () => app.quit())
