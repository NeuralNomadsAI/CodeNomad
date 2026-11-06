// No application profile, backend or visible desktop window. The production controller's
// ownership/registration checks still run; visibility is supplied by this fixture explicitly.
const { app, BrowserWindow } = require("electron")
app.setPath("userData", process.env.CODENOMAD_TEST_PROFILE)
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
    // Failure evidence: what the guest document and its widgets report.
    diagnose: async () => ({
      guestFocused: guest?.isFocused(), ownerFocused: window.webContents.isFocused(), windowFocused: window.isFocused(),
      page: await guest?.executeJavaScript(`({ result: document.getElementById("result")?.textContent, hasFocus: document.hasFocus(),
        active: document.activeElement?.outerHTML?.slice(0, 120), visibility: document.visibilityState })`).catch(error => String(error)),
      gpu: app.getGPUFeatureStatus(),
    }),
    focusGuest: () => guest?.focus(),
    // Failure evidence: which input path reaches the guest document, tried in order.
    probeKeys: async () => {
      const result = () => guest.executeJavaScript(`document.getElementById("result").textContent`)
      const settle = () => new Promise(resolve => setTimeout(resolve, 300))
      const sendKey = keyCode => { for (const type of ["keyDown", "char", "keyUp"]) guest.sendInputEvent({ type, keyCode }) }
      const report = {
        animationFrame: await guest.executeJavaScript(`new Promise(resolve => { const timer = setTimeout(() => resolve(false), 500);
          requestAnimationFrame(() => { clearTimeout(timer); resolve(true) }) })`),
        windowVisible: window.isVisible(),
      }
      sendKey("b"); await settle(); report.sendInputEvent = await result()
      const attached = guest.debugger.isAttached()
      if (!attached) guest.debugger.attach("1.3")
      for (const type of ["keyDown", "keyUp"]) {
        await guest.debugger.sendCommand("Input.dispatchKeyEvent", { type, key: "c", code: "KeyC", windowsVirtualKeyCode: 67, ...(type === "keyDown" ? { text: "c" } : {}) })
      }
      if (!attached) guest.debugger.detach()
      await settle(); report.cdpKey = await result()
      window.webContents.invalidate(); guest.invalidate(); await settle()
      sendKey("d"); await settle(); report.invalidateThenKey = await result()
      const point = await guest.executeJavaScript(`(() => { const box = document.querySelector("input").getBoundingClientRect(); return { x: Math.round(box.x + 5), y: Math.round(box.y + 5) } })()`)
      for (const type of ["mouseDown", "mouseUp"]) guest.sendInputEvent({ type, ...point, button: "left", clickCount: 1 })
      await settle(); sendKey("e"); await settle(); report.clickThenKey = await result()
      window.showInactive(); await settle()
      sendKey("f"); await settle(); report.shownThenKey = await result()
      window.hide()
      return report
    },
  }
  const html = `<html><body style="margin:0"><webview src="${process.env.CODENOMAD_TEST_GUEST_URL}" style="width:850px;height:650px;display:flex"></webview></body></html>`
  await window.loadURL(`data:text/html,${encodeURIComponent(html)}`)
})
app.on("window-all-closed", () => app.quit())
