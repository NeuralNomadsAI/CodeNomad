// No application profile, backend or visible desktop window. The production controller's
// ownership/registration checks still run; visibility is supplied by this fixture explicitly.
const { app, BrowserWindow } = require("electron")
app.setPath("userData", process.env.CODENOMAD_TEST_PROFILE)
// TEMPORARY runner probe (removed before merge): process and GPU timeline from launch.
const launched = Date.now()
const timeline = []
const mark = (what, detail) => timeline.push(`${Date.now() - launched}ms ${what}${detail ? " " + JSON.stringify(detail) : ""}`)
app.on("child-process-gone", (_event, details) => mark("child-process-gone", details))
app.on("render-process-gone", (_event, _contents, details) => mark("render-process-gone", details))
app.on("gpu-info-update", () => mark("gpu-info-update"))
app.on("web-contents-created", (_event, contents) => {
  contents.on("did-finish-load", () => mark(`did-finish-load ${contents.getType()}`))
  contents.on("render-process-gone", (_e, details) => mark(`render-gone ${contents.getType()}`, details))
})
app.whenReady().then(async () => {
  const { BrowserController, BrowserPage, handleNativeBrowserRequest } = require(process.env.CODENOMAD_TEST_AUTOMATION_BUNDLE)
  const window = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  let visible = true, guest
  let loaded
  const guestLoaded = new Promise(resolve => { loaded = resolve })
  const controller = new BrowserController(() => {}, {
    fromId: id => guest && guest.id === id ? guest : null,
    fromWebContents: owner => owner === window.webContents ? {
      isDestroyed: () => window.isDestroyed(), isVisible: () => visible, isMinimized: () => false,
    } : null,
  })
  window.webContents.on("did-attach-webview", (_event, contents) => {
    guest = contents
    guest.on("did-stop-loading", () => {
      if (guest.getURL() === process.env.CODENOMAD_TEST_GUEST_URL && !guest.isLoading()) loaded()
    })
    controller.observeGuest(window.webContents, guest)
    controller.register(window.webContents, { sessionId: "fixture-session", registrationId: "fixture-guest", guestWebContentsId: guest.id })
  })
  const browser = new BrowserPage({ request: (method, params, timeout = 25000) =>
    handleNativeBrowserRequest(controller, method, params, Date.now() + timeout) })
  globalThis.automationPreview = {
    execute: action => browser.execute("fixture-session", action),
    navigate: url => controller.execute("fixture-session", { action: "navigate", url }),
    visible: value => { visible = value },
    ready: async () => { await guestLoaded; return Boolean(guest && !guest.isLoading()) },
    // TEMPORARY runner probe (removed before merge).
    probe: {
      browserKeys: [],
      mark: what => mark(what),
      timeline: async () => ({ timeline, gpu: app.getGPUFeatureStatus().gpu_compositing,
        metrics: app.getAppMetrics().map(metric => `${metric.type}:${metric.pid}`) }),
      sendKey: key => { for (const type of ["keyDown", "char", "keyUp"]) guest.sendInputEvent({ type, keyCode: key }) },
      watch() { guest.on("before-input-event", (_event, input) => this.browserKeys.push(`${input.type}:${input.key}`)) },
      async prepare(variant) {
        if (variant === "focus") guest.focus()
        if (variant === "shift") for (const type of ["keyDown", "keyUp"]) guest.sendInputEvent({ type, keyCode: "Shift" })
        if (variant === "delay") await new Promise(resolve => setTimeout(resolve, 1000))
        if (variant === "mousemove") guest.sendInputEvent({ type: "mouseMove", x: 5, y: 5 })
      },
      async state() {
        const { BrowserWindow: Windows } = require("electron")
        return { guestFocused: guest.isFocused(), windowFocused: window.isFocused(), focusedWindow: Windows.getFocusedWindow()?.id ?? null,
          windowVisible: window.isVisible(), browserKeys: this.browserKeys,
          page: await guest.executeJavaScript(`({ events: window.__probeEvents || [], hasFocus: document.hasFocus(),
            active: document.activeElement && document.activeElement.tagName, result: document.getElementById("result").textContent })`) }
      },
    },
  }
  const html = `<html><body style="margin:0"><webview src="${process.env.CODENOMAD_TEST_GUEST_URL}" style="width:850px;height:650px;display:flex"></webview></body></html>`
  await window.loadURL(`data:text/html,${encodeURIComponent(html)}`)
})
app.on("window-all-closed", () => app.quit())
