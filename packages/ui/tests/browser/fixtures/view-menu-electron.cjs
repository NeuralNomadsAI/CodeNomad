const { app, BrowserWindow, Menu, shell, dialog } = require("electron")
const path = require("node:path")
require("node:fs").mkdirSync(process.env.CODENOMAD_TEST_PROFILE, { recursive: true })
app.setPath("userData", process.env.CODENOMAD_TEST_PROFILE)
const { createApplicationMenu, setWorkspaceMenuEnabled, clearWorkspaceMenuWindow, popupTitlebarMenu } = require(process.env.CODENOMAD_TEST_MENU_MODULE)
const { resolveFocusedLocalTarget, resolveWindowTarget } = require(path.join(path.dirname(process.env.CODENOMAD_TEST_MENU_MODULE), "menu-target.cjs"))

app.whenReady().then(() => {
  const windows = [new BrowserWindow({ show: false }), new BrowserWindow({ show: false })]
  let focused = windows[0], mru = windows[0]
  const nonLocal = {}
  const target = () => resolveFocusedLocalTarget(focused, mru, window => windows.includes(window))
  const actions = []
  const externalUrls = []
  const failures = []
  let failOpen = false
  shell.openExternal = async url => { if (failOpen) throw new Error('opener failed'); externalUrls.push(url) }
  dialog.showErrorBox = (title, message) => failures.push({ title, message })
  for (const window of windows) {
    const send = window.webContents.send.bind(window.webContents)
    window.webContents.send = (channel, ...args) => channel === "menu:action"
      ? actions.push([window.webContents.id, channel, ...args]) : send(channel, ...args)
    void window.loadURL("about:blank")
  }
  createApplicationMenu({ getLocalTarget: target, getWindowTarget: () => resolveWindowTarget(focused, mru),
    newWindow() {}, reload() {}, forceReload() {} })
  global.menuFixture = {
    async rejectExternal() {
      const { openExternalWithFeedback } = require(path.join(path.dirname(process.env.CODENOMAD_TEST_MENU_MODULE), "open-external.cjs"))
      let reject, attempts = 0
      shell.openExternal = () => { attempts++; return new Promise((_, fail) => { reject = fail }) }
      const opening = openExternalWithFeedback("https://neuralnomadsai.github.io/CodeNomad/fr/")
      const before = failures.length
      reject(new Error("asynchronous opener rejection"))
      await opening
      return { before, after: failures.length, attempts }
    },
    ids: windows.map(window => window.webContents.id),
    document(index, pathname) { windows[index].webContents.getURL = () => `http://127.0.0.1:9898${pathname}` },
    failOpen() { failOpen = true },
    failures,
    set(index, state) { setWorkspaceMenuEnabled(windows[index], true, state) },
    focus(index) { focused = index === null ? nonLocal : windows[index]; if (index !== null) mru = focused; app.emit("browser-window-focus", {}, focused) },
    blur() { focused = null; app.emit("browser-window-blur", {}, mru) },
    clear(index) { clearWorkspaceMenuWindow(windows[index].webContents.id) },
    snapshot() {
      const menu = Menu.getApplicationMenu().getMenuItemById("menu-view").submenu
      return menu.items.filter(item => item.id?.startsWith("view-")).map(item => {
        const index = menu.getIndexOfCommandId(item.commandId)
        return { id: item.id, label: menu.getLabelAt(index), checked: menu.isItemCheckedAt(index), enabled: menu.isEnabledAt(index) }
      })
    },
    workspaceEnabled() {
      const menu = Menu.getApplicationMenu().getMenuItemById("menu-file").submenu
      return ["open-workspace-folder", "open-workspace-terminal", "open-workspace-editor"].map(id =>
        menu.isEnabledAt(menu.getIndexOfCommandId(menu.getMenuItemById(id).commandId)))
    },
    helpLabels() { return Menu.getApplicationMenu().getMenuItemById("menu-help").submenu.items.map(item => item.label) },
    titlebarHelp() {
      const submenu = Menu.getApplicationMenu().getMenuItemById("menu-help").submenu
      const popup = submenu.popup
      const targets = []
      submenu.popup = options => targets.push({ id: options.window.webContents.id, x: options.x, y: options.y })
      try { popupTitlebarMenu(windows[0], "help", 5, 10) } finally { submenu.popup = popup }
      return targets
    },
    click(id) { const window = target(); Menu.getApplicationMenu().getMenuItemById(id).click({}, window, window?.webContents) },
    actions,
    externalUrls,
    menu() { return Menu.getApplicationMenu() },
  }
})
