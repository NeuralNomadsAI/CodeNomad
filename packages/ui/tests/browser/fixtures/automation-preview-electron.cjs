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
  const { BrowserController, BrowserPage, handleNativeBrowserRequest, secureBrowserWebview } = require(process.env.CODENOMAD_TEST_AUTOMATION_BUNDLE)
  const window = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  let visible = true, guest
  let loaded
  const guestLoaded = new Promise(resolve => { loaded = resolve })
  const guests = new Map()
  const openGuests = new Map()
  const settlements = new Map()
  const controller = new BrowserController(() => [window.webContents], {
    fromId: id => guests.get(id),
    fromWebContents: owner => owner === window.webContents ? {
      isDestroyed: () => window.isDestroyed(), isVisible: () => visible, isMinimized: () => false,
    } : null,
  })
  app.on("web-contents-created", (_event, contents) => controller.guestCreated(contents))
  window.webContents.on("will-attach-webview", (event, preferences, params) => {
    if (!secureBrowserWebview(preferences, params, () => controller.permitOpenAttachment(window.webContents, params))) event.preventDefault()
  })
  let pendingOpen
  window.webContents.on("did-attach-webview", (_event, contents) => {
    guests.set(contents.id, contents)
    controller.observeGuest(window.webContents, contents)
    if (pendingOpen) {
      const { requestID, instanceId, sessionID, ownership } = pendingOpen
      pendingOpen = undefined
      contents.once("dom-ready", () => {
        if (controller.permitOpenAttachment(window.webContents, { src: "about:blank", webpreferences: `codenomadPreview=${ownership.revision}` })) {
          controller.releaseOpen(window.webContents, requestID)
          contents.close()
          return
        }
        controller.register(window.webContents, { sessionId: sessionID, registrationId: requestID, instanceId, guestWebContentsId: contents.id })
        contents.fixtureRegistration = requestID
        openGuests.set(sessionID, contents)
        if (!controller.claimOpen(window.webContents, requestID, { kind: "target", instanceId, registrationId: requestID })) contents.close()
      })
      return
    }
    guest = contents
    guest.on("did-stop-loading", () => {
      if (guest.getURL() === process.env.CODENOMAD_TEST_GUEST_URL && !guest.isLoading()) loaded()
    })
    controller.register(window.webContents, { sessionId: "fixture-session", registrationId: "fixture-guest", guestWebContentsId: guest.id })
  })
  const browser = new BrowserPage({ request: (method, params, timeout = 25000) =>
    handleNativeBrowserRequest(controller, method, params, Date.now() + timeout) })
  const send = window.webContents.send.bind(window.webContents)
  window.webContents.send = (channel, payload) => {
    const { requestID, instanceId } = payload
    if (channel === "browser-target:discover") return controller.claimOpen(window.webContents, requestID, { kind: "discover", instanceId: "fixture-tab" })
    if (channel === "browser-target:open") {
      const ownership = controller.changeOwnership(window.webContents, { action: "ready", sessionId: payload.sessionID, instanceId, requestID })
      const existing = openGuests.get(payload.sessionID)
      if (existing && !existing.isDestroyed()) {
        return controller.claimOpen(window.webContents, requestID, {
          kind: "target", instanceId, registrationId: existing.fixtureRegistration,
        })
      }
      pendingOpen = { ...payload, ownership }
      void window.webContents.executeJavaScript(`(() => {
        const preview = document.createElement("webview")
         preview.setAttribute("webpreferences", "codenomadPreview=${ownership.revision}")
        preview.setAttribute("partition", "persist:codenomad-browser-open-fixture")
        preview.src = "about:blank"
        document.body.append(preview)
      })()`)
      return
    }
    if (channel === "browser-target:open-settled") settlements.set(payload.sessionID, payload)
    return send(channel, payload)
  }
  globalThis.automationPreview = {
    execute: async action => browser.execute("fixture-session", action, undefined, (await controller.probe("fixture-session")).target),
    navigate: async url => controller.execute("fixture-session", { action: "navigate", url }, Infinity, (await controller.probe("fixture-session")).target),
    open: (session, url, timeout) => handleNativeBrowserRequest(controller, "browser.execute",
      { sessionID: session, command: { action: "open", url }, workspaceIDs: ["fixture-tab"] }, Date.now() + timeout),
    followOpenLink: async (session, url, successor) => {
      const target = openGuests.get(session)
      await awaitHiddenSurface(target, window, url, performance.now() + PREPARATION_MS)
      if (!target.isLoading()) throw new Error("The first navigation finished before the click")
      const deadline = performance.now() + PREPARATION_MS
      let onLoad
      const loaded = new Promise(resolve => {
        onLoad = () => { if (target.getURL() === successor) resolve() }
        target.on("did-finish-load", onLoad)
      })
      // Automation would wait for the pending open's guest slot; manual guest input does not.
      // Production attaches the guest's debugger at creation for its diagnostics; the fixture shares that attachment.
      const attached = target.debugger.isAttached()
      if (!attached) target.debugger.attach("1.3")
      try {
        const { result: { value: point } } = await target.debugger.sendCommand("Runtime.evaluate", {
          expression: `(() => { const r = document.querySelector('a').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
          returnByValue: true,
        })
        for (const type of ["mousePressed", "mouseReleased"]) {
          await target.debugger.sendCommand("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 })
        }
        await withinBudget(loaded, deadline, "the successor did not load")
        return { url: target.getURL(), sameGuest: openGuests.get(session) === target }
      } finally {
        target.removeListener("did-finish-load", onLoad)
        if (!attached && !target.isDestroyed() && target.debugger.isAttached()) target.debugger.detach()
      }
    },
    openState: session => {
      return { settled: settlements.get(session) }
    },
    visible: value => { visible = value },
    ready: async () => {
      const deadline = performance.now() + PREPARATION_MS
      await withinBudget(guestLoaded, deadline, "the guest did not load")
      const target = guest
      const before = ownerState(window)
      const captures = await awaitHiddenSurface(target, window, process.env.CODENOMAD_TEST_GUEST_URL, deadline)
      if (guest !== target) throw new Error("Preview preparation: the guest was replaced")
      return { loaded: !target.isLoading(), rendered: true, before, after: ownerState(window), captures }
    },
  }
  const html = `<html><body style="margin:0"><webview partition="persist:codenomad-browser-fixture" src="${process.env.CODENOMAD_TEST_GUEST_URL}" style="width:850px;height:650px;display:flex"></webview></body></html>`
  await window.loadURL(`data:text/html,${encodeURIComponent(html)}`)
})
app.on("window-all-closed", () => app.quit())
