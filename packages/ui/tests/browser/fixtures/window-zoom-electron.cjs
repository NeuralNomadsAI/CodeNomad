const { app, BrowserWindow, Menu, screen } = require("electron")
const fs = require("node:fs")
fs.mkdirSync(process.env.CODENOMAD_TEST_PROFILE, { recursive: true })
app.setPath("userData", process.env.CODENOMAD_TEST_PROFILE)
const native = require(process.env.CODENOMAD_TEST_ZOOM_MODULE)

app.whenReady().then(async () => {
  const windows = [], trackers = [], saved = []
  const create = (index, state) => {
    const frame = index === 1
    const minimum = native.zoomedWindowMinimum(state?.zoomFactor ?? 1)
    const bounds = state ? native.clampWindowBounds(state.bounds, screen.getAllDisplays().map(display => ({ ...display.workArea, scaleFactor: display.scaleFactor })), minimum) : undefined
    const window = new BrowserWindow({
      width: bounds?.width ?? 390, height: bounds?.height ?? 844,
      minWidth: minimum.width, minHeight: minimum.height,
      useContentSize: true, frame, show: false,
      // Local windows deliberately share defaultSession, just like production.
      webPreferences: { ...(frame ? { partition: "remote-fixture" } : {}), zoomFactor: state?.zoomFactor ?? 1 },
    })
    windows[index] = window
    trackers[index] = new native.WindowStateTracker(window, {
      activeWindowId: `fixture-${index}`, saveWindowState: async state => { saved[index] = state; return true },
      flush: async () => {},
    }, state)
    native.installWindowSizeConstraints(window, () => screen.getDisplayMatching(window.getBounds()).workArea, state?.zoomFactor ?? 1)
    native.restoreWindowState(window, state, bounds)
    native.installWindowZoomInput(window, level => trackers[index].setZoomLevel(level))
    return window
  }
  create(0)
  create(1)
  let target = windows[0]
  native.createApplicationMenu({ getLocalTarget: () => target, getWindowTarget: () => target,
    newWindow() {}, reload() {}, forceReload() {} })
  global.zoomFixture = {
    zoom(index, factor) { native.setWindowZoomLevel(windows[index], Math.log(factor) / Math.log(1.2)) },
    rawZoom(index, factor) { windows[index].webContents.setZoomFactor(factor) },
    fit(index, cssWidth = 390) {
      const window = windows[index], factor = window.webContents.getZoomFactor()
      window.setContentSize(Math.ceil(cssWidth * factor), Math.ceil(600 * factor))
    },
    menu(index, label) {
      target = windows[index]
      const item = Menu.getApplicationMenu().getMenuItemById("menu-view").submenu.items.find(item => item.label === label)
      item.click(item, target, target.webContents)
    },
    async reload(index = 0) { await windows[index].loadURL(process.env.CODENOMAD_TEST_ZOOM_URL) },
    async save(index = 0) { await trackers[index].flush(); return saved[index] },
    async recreate(index = 0) {
      await trackers[index].flush()
      const state = saved[index]
      const closed = new Promise(resolve => windows[index].once("closed", resolve))
      windows[index].close()
      await closed
      const window = create(index, state)
      const beforeLoad = this.snapshot(index)
      await window.loadURL(process.env.CODENOMAD_TEST_ZOOM_URL)
      window.show()
      target = window
      return { beforeLoad, afterLoad: this.snapshot(index) }
    },
    async sibling() {
      const window = create(2)
      await window.loadURL(process.env.CODENOMAD_TEST_ZOOM_URL)
      return { sharedSession: window.webContents.session === windows[0].webContents.session,
        sameOrigin: new URL(window.webContents.getURL()).origin === new URL(windows[0].webContents.getURL()).origin }
    },
    async sharedAuth() {
      const cookie = { url: process.env.CODENOMAD_TEST_ZOOM_URL, name: "fixture-auth", value: "shared-auth" }
      await windows[0].webContents.session.cookies.set(cookie)
      return (await windows[2].webContents.session.cookies.get({ url: cookie.url, name: cookie.name }))[0]?.value
    },
    // sendInputEvent(mouseWheel) does not generate Electron's native zoom request;
    // exercise its documented zoom-changed event against the real shared hosts.
    wheelRequest(index, direction) { windows[index].webContents.emit("zoom-changed", { preventDefault() {} }, direction) },
    async input(index, keyCode) {
      const contents = windows[index].webContents
      const handled = new Promise(resolve => contents.once("before-input-event", () => resolve()))
      contents.sendInputEvent({ type: "keyDown", keyCode, modifiers: [process.platform === "darwin" ? "meta" : "control"] })
      contents.sendInputEvent({ type: "keyUp", keyCode, modifiers: [process.platform === "darwin" ? "meta" : "control"] })
      await handled
    },
    async capture() { return (await windows[0].webContents.capturePage()).toPNG().toString("base64") },
    snapshot(index) {
      const window = windows[index]
      return { minimum: window.getMinimumSize(), content: window.getContentSize(), outer: window.getSize(), zoom: window.webContents.getZoomFactor() }
    },
  }
  await windows[0].loadURL(process.env.CODENOMAD_TEST_ZOOM_URL)
  windows[0].show()
  windows[0].focus()
  await windows[1].loadURL("about:blank")
})
