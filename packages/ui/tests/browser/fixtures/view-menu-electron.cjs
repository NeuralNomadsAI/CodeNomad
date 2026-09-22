const { app, BrowserWindow, Menu } = require("electron")
require("node:fs").mkdirSync(process.env.CODENOMAD_TEST_PROFILE, { recursive: true })
app.setPath("userData", process.env.CODENOMAD_TEST_PROFILE)
const { createApplicationMenu, setWorkspaceMenuEnabled, clearWorkspaceMenuWindow } = require(process.env.CODENOMAD_TEST_MENU_MODULE)

app.whenReady().then(() => {
  const windows = [new BrowserWindow({ show: false }), new BrowserWindow({ show: false })]
  let target = windows[0]
  const actions = []
  for (const window of windows) {
    const send = window.webContents.send.bind(window.webContents)
    window.webContents.send = (channel, ...args) => channel === "menu:action"
      ? actions.push([window.webContents.id, channel, ...args]) : send(channel, ...args)
    void window.loadURL("about:blank")
  }
  createApplicationMenu({ getLocalTarget: () => target, getWindowTarget: () => target,
    newWindow() {}, reload() {}, forceReload() {} })
  global.menuFixture = {
    ids: windows.map(window => window.webContents.id),
    set(index, state) { setWorkspaceMenuEnabled(windows[index], true, state) },
    focus(index) { target = index === null ? null : windows[index]; app.emit("browser-window-focus", {}, target) },
    clear(index) { clearWorkspaceMenuWindow(windows[index].webContents.id) },
    snapshot() {
      const menu = Menu.getApplicationMenu().getMenuItemById("menu-view").submenu
      return menu.items.filter(item => item.id?.startsWith("view-")).map(item => {
        const index = menu.getIndexOfCommandId(item.commandId)
        return { id: item.id, label: menu.getLabelAt(index), checked: menu.isItemCheckedAt(index), enabled: menu.isEnabledAt(index) }
      })
    },
    click(id) { Menu.getApplicationMenu().getMenuItemById(id).click({}, target, target?.webContents) },
    actions,
    menu() { return Menu.getApplicationMenu() },
  }
})
