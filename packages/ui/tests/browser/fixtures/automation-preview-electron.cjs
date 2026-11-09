// No application profile, backend or visible desktop window. The production controller's
// ownership/registration checks still run; visibility is supplied by this fixture explicitly.
// Production drives visible previews; this hidden fixture prepares its guest's rendered surface first.
const { app, BrowserWindow } = require("electron")
app.setPath("userData", process.env.CODENOMAD_TEST_PROFILE)

const PREPARATION_MS = 10_000
const PROBE_INTERVAL_MS = 50
const PENDING_SURFACE = new Set(["Current display surface not available for capture", "UnknownVizError", "VizSentEmptyBitmap"])

function withinBudget(promise, deadline, failure) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Preview preparation: ${failure} within ${PREPARATION_MS} ms`)), Math.max(0, deadline - performance.now()))
    }),
  ]).finally(() => clearTimeout(timer))
}

function assertPrepared(target, owner, expectedUrl, deadline) {
  if (target.isDestroyed()) throw new Error("Preview preparation: the guest was destroyed")
  if (target.getURL() !== expectedUrl) throw new Error(`Preview preparation: the guest left ${expectedUrl}`)
  const state = ownerState(owner)
  if (state.visible || state.focused || state.focusedWindow) throw new Error("Preview preparation: the window became visible or focused")
  if (performance.now() >= deadline) throw new Error(`Preview preparation: no rendered guest surface within ${PREPARATION_MS} ms`)
}

async function awaitHiddenSurface(target, owner, expectedUrl, deadline) {
  for (let captures = 1; ; captures++) {
    assertPrepared(target, owner, expectedUrl, deadline)
    const outcome = await withinBudget(target.capturePage({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: true })
      .then(image => ({ image }), error => ({ error })), deadline, "a guest capture did not settle")
    assertPrepared(target, owner, expectedUrl, deadline)
    if (outcome.image && !outcome.image.isEmpty()) return captures
    if (outcome.error && !PENDING_SURFACE.has(outcome.error.message)) throw outcome.error
    await new Promise(resolve => setTimeout(resolve, Math.min(PROBE_INTERVAL_MS, Math.max(0, deadline - performance.now()))))
  }
}

function ownerState(owner) {
  return { visible: owner.isVisible(), focused: owner.isFocused(), focusedWindow: BrowserWindow.getFocusedWindow() !== null }
}
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
    ready: async () => {
      const deadline = performance.now() + PREPARATION_MS
      await withinBudget(guestLoaded, deadline, "the guest did not load")
      const before = ownerState(window)
      const captures = await awaitHiddenSurface(guest, window, process.env.CODENOMAD_TEST_GUEST_URL, deadline)
      return { loaded: !guest.isLoading(), rendered: true, before, after: ownerState(window), captures }
    },
  }
  const html = `<html><body style="margin:0"><webview src="${process.env.CODENOMAD_TEST_GUEST_URL}" style="width:850px;height:650px;display:flex"></webview></body></html>`
  await window.loadURL(`data:text/html,${encodeURIComponent(html)}`)
})
app.on("window-all-closed", () => app.quit())
