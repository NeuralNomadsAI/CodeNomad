const { app, BrowserWindow, Menu } = require("electron")
const path = require("node:path")
require("node:fs").mkdirSync(process.env.CODENOMAD_TEST_PROFILE, { recursive: true })
app.setPath("userData", process.env.CODENOMAD_TEST_PROFILE)
const { createApplicationMenu, setWorkspaceMenuEnabled, clearWorkspaceMenuWindow } = require(process.env.CODENOMAD_TEST_MENU_MODULE)
const { resolveFocusedLocalTarget, resolveWindowTarget } = require(path.join(path.dirname(process.env.CODENOMAD_TEST_MENU_MODULE), "menu-target.cjs"))

app.whenReady().then(() => {
  const windows = [new BrowserWindow({ show: false }), new BrowserWindow({ show: false })]
  let focused = windows[0], mru = windows[0]
  const nonLocal = {}
  const target = () => resolveFocusedLocalTarget(focused, mru, window => windows.includes(window))
  const actions = []
  for (const window of windows) {
    const send = window.webContents.send.bind(window.webContents)
    window.webContents.send = (channel, ...args) => channel === "menu:action"
      ? actions.push([window.webContents.id, channel, ...args]) : send(channel, ...args)
    void window.loadURL("about:blank")
  }
  createApplicationMenu({ getLocalTarget: target, getWindowTarget: () => resolveWindowTarget(focused, mru),
    newWindow() {}, reload() {}, forceReload() {} })
  global.menuFixture = {
    ids: windows.map(window => window.webContents.id),
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
    click(id) { const window = target(); Menu.getApplicationMenu().getMenuItemById(id).click({}, window, window?.webContents) },
    actions,
    menu() { return Menu.getApplicationMenu() },
  }
})
