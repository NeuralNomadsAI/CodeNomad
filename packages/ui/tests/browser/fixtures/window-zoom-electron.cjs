const { app, BrowserWindow, Menu, screen } = require("electron")
const fs = require("node:fs")
fs.mkdirSync(process.env.CODENOMAD_TEST_PROFILE, { recursive: true })
app.setPath("userData", process.env.CODENOMAD_TEST_PROFILE)
const native = require(process.env.CODENOMAD_TEST_ZOOM_MODULE)

app.whenReady().then(async () => {
  const windows = [false, true].map(frame => new BrowserWindow({
    width: 390, height: 844, minWidth: 390, minHeight: 600,
    useContentSize: true, frame, show: false,
    webPreferences: { partition: frame ? "remote-fixture" : "local-fixture" },
  }))
  let target = windows[0]
  const saved = []
  const tracker = new native.WindowStateTracker(target, {
    activeWindowId: "fixture", saveWindowState: async state => { saved.push(state); return true },
    flush: async () => {},
  })
  windows.forEach((window, index) => {
    native.installWindowSizeConstraints(window, () => screen.getDisplayMatching(window.getBounds()).workArea)
    native.installWindowZoomInput(window, level => index ? native.setWindowZoomLevel(window, level) : tracker.setZoomLevel(level))
  })
  native.createApplicationMenu({ getLocalTarget: () => target, getWindowTarget: () => target,
    newWindow() {}, reload() {}, forceReload() {} })
  global.zoomFixture = {
    zoom(index, factor) { native.setWindowZoomLevel(windows[index], Math.log(factor) / Math.log(1.2)) },
    fit(index, cssWidth = 390) {
      const window = windows[index], factor = window.webContents.getZoomFactor()
      window.setContentSize(Math.ceil(cssWidth * factor), Math.ceil(600 * factor))
    },
    menu(index, label) {
      target = windows[index]
      const item = Menu.getApplicationMenu().getMenuItemById("menu-view").submenu.items.find(item => item.label === label)
      item.click(item, target, target.webContents)
    },
    async reload() { await windows[0].loadURL(process.env.CODENOMAD_TEST_ZOOM_URL) },
    async save() { await tracker.flush(); return saved.at(-1) },
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
