import { app, BrowserWindow, Menu, shell, dialog, type MenuItemConstructorOptions } from "electron"
import { NEW_WINDOW_ACCELERATOR } from "./menu-target"
import { setWindowZoomLevel } from "./window-state"
import { nativeMenuLabels, setViewMenuState, updateViewMenu, viewMenuItems } from "./view-menu"
import { HELP_BASE_URL } from "../../../ui/src/lib/help-url"
import { openExternalWithFeedback } from "./open-external"

interface ApplicationMenuActions {
  getLocalTarget(): BrowserWindow | null
  getWindowTarget(): BrowserWindow | null
  newWindow(): void
  reload(window: BrowserWindow): void
  forceReload(window: BrowserWindow): void
}

const workspaceEnabled = new Map<number, boolean>()
let applicationMenu: Menu | null = null
let menuInstalled = false
let actions: ApplicationMenuActions | null = null
let builtLabels: string | undefined

export type TitlebarMenu = "file" | "edit" | "view" | "window" | "help"

function target(local: boolean): BrowserWindow | null {
  const window = (local ? actions?.getLocalTarget() : actions?.getWindowTarget()) ?? null
  return window && !window.isDestroyed() ? window : null
}

function updateWorkspaceMenuState() {
  const window = target(true)
  if (updateViewMenu(applicationMenu, window, builtLabels)) {
    buildApplicationMenu()
    return
  }
  const enabled = Boolean(window && workspaceEnabled.get(window.webContents.id))
  for (const id of ["open-workspace-folder", "open-workspace-terminal", "open-workspace-editor"]) {
    const item = applicationMenu?.getMenuItemById(id)
    if (item) item.enabled = enabled
  }
}

export function setWorkspaceMenuEnabled(window: BrowserWindow, enabled: boolean, viewState?: unknown) {
  setViewMenuState(window.webContents.id, viewState)
  workspaceEnabled.set(window.webContents.id, enabled)
  updateWorkspaceMenuState()
}

export function clearWorkspaceMenuWindow(webContentsId: number) {
  setViewMenuState(webContentsId, undefined)
  workspaceEnabled.delete(webContentsId)
  updateWorkspaceMenuState()
}

export function popupTitlebarMenu(window: BrowserWindow, menu: TitlebarMenu, x: number, y: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Invalid titlebar menu position")
  updateWorkspaceMenuState()
  const submenu = applicationMenu?.getMenuItemById(`menu-${menu}`)?.submenu
  if (!submenu) throw new Error(`Unknown titlebar menu: ${menu}`)
  submenu.popup({ window, x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) })
}

export function createApplicationMenu(menuActions: ApplicationMenuActions) {
  actions = menuActions
  if (menuInstalled) return
  menuInstalled = true
  buildApplicationMenu()
  app.on("browser-window-focus", updateWorkspaceMenuState)
  app.on("browser-window-blur", updateWorkspaceMenuState)
}

function buildApplicationMenu() {
  const isMac = process.platform === "darwin"
  // Labels follow the target window's UI locale; English until a renderer reports one.
  const l = nativeMenuLabels(target(true))
  builtLabels = JSON.stringify(l)
  const sendCommand = (id: string) => () => {
    const window = target(true)
    if (!window) return false
    const url = window.webContents.getURL()
    if (!url) return false
    const path = new URL(url).pathname
    if (path.endsWith("/loading.html") || ["/login", "/remote-pair"].includes(path) || path.startsWith("/auth/")) return false
    window.webContents.send("menu:action", id)
    return true
  }
  // About opens Settings → Info → About in the application; documents without
  // a menu listener (loading, sign-in, pairing) keep the native panel.
  const showAbout = () => { if (!sendCommand("open-about")()) app.showAboutPanel() }
  const withTarget = (operation: (window: BrowserWindow) => void) => () => {
    const window = target(false)
    if (window) operation(window)
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ label: "CodeNomad", submenu: [
      { label: l.about, click: showAbout }, { type: "separator" as const }, { role: "hide" as const, label: l.hide },
      { role: "hideOthers" as const, label: l.hideOthers }, { role: "unhide" as const, label: l.showAll },
      { type: "separator" as const }, { role: "quit" as const, label: l.quit },
    ] }] : []),
    {
      id: "menu-file",
      label: l.file,
      submenu: [
        { id: "open-workspace-folder", label: l.openFolder, click: sendCommand("open-workspace-folder") },
        { id: "open-workspace-terminal", label: l.openTerminal, click: sendCommand("open-workspace-terminal") },
        { id: "open-workspace-editor", label: l.openIn, submenu: [
          { label: "VS Code", click: sendCommand("open-workspace-editor-vscode") },
          { label: "Cursor", click: sendCommand("open-workspace-editor-cursor") },
          { label: "Zed", click: sendCommand("open-workspace-editor-zed") },
          { label: "VSCodium", click: sendCommand("open-workspace-editor-vscodium") },
        ] },
        { type: "separator" }, isMac ? { role: "close", label: l.closeWindow } : { role: "quit", label: l.quit },
      ],
    },
    { id: "menu-edit", label: l.edit, submenu: [
      { role: "undo", label: l.undo }, { role: "redo", label: l.redo }, { type: "separator" },
      { role: "cut", label: l.cut }, { role: "copy", label: l.copy }, { role: "paste", label: l.paste },
      ...(isMac ? [{ role: "pasteAndMatchStyle" as const, label: l.pasteAndMatchStyle }, { role: "delete" as const, label: l.delete }, { role: "selectAll" as const, label: l.selectAll }]
        : [{ role: "delete" as const, label: l.delete }, { type: "separator" as const }, { role: "selectAll" as const, label: l.selectAll }]),
    ] },
    { id: "menu-view", label: l.view, submenu: [
      ...viewMenuItems(sendCommand, target(true)),
      { type: "separator" },
      { label: l.reload, accelerator: "CmdOrCtrl+R", click: withTarget((window) => actions?.reload(window)) },
      { label: l.forceReload, accelerator: "CmdOrCtrl+Shift+R", click: withTarget((window) => actions?.forceReload(window)) },
      { label: l.devTools, accelerator: isMac ? "Alt+Command+I" : "Ctrl+Shift+I", click: withTarget((window) => window.webContents.toggleDevTools()) },
      { type: "separator" },
      { label: l.actualSize, accelerator: "CmdOrCtrl+0", click: withTarget((window) => setWindowZoomLevel(window, 0)) },
      { label: l.zoomIn, accelerator: "CmdOrCtrl+Plus", click: withTarget((window) => setWindowZoomLevel(window, window.webContents.getZoomLevel() + 0.5)) },
      { label: l.zoomOut, accelerator: "CmdOrCtrl+-", click: withTarget((window) => setWindowZoomLevel(window, window.webContents.getZoomLevel() - 0.5)) },
      { type: "separator" },
      { label: l.fullScreen, accelerator: isMac ? "Ctrl+Command+F" : "F11", click: withTarget((window) => window.setFullScreen(!window.isFullScreen())) },
    ] },
    { id: "menu-window", label: l.window, submenu: [
      { label: l.newWindow, accelerator: NEW_WINDOW_ACCELERATOR, click: () => actions?.newWindow() },
      { label: l.newInstance, accelerator: "CmdOrCtrl+N", click: sendCommand("new-instance") },
      { label: l.commandPalette, accelerator: "CmdOrCtrl+Shift+P", click: sendCommand("open-command-palette") },
      { type: "separator" },
      { label: l.minimize, accelerator: "CmdOrCtrl+M", click: withTarget((window) => window.minimize()) },
      ...(isMac ? [{ role: "front" as const, label: l.bringAllToFront }] : [{ label: l.closeWindow, accelerator: "CmdOrCtrl+W", click: withTarget((window) => window.close()) }]),
    ] },
    { id: "menu-help", label: l.help, submenu: [
      { id: "open-help", label: l.codenomadHelp, click: () => {
        if (!sendCommand("open-help")()) void openExternalWithFeedback(HELP_BASE_URL)
      } },
      { label: l.getUpdates, click: () => { void shell.openExternal("https://github.com/NeuralNomadsAI/CodeNomad/releases").catch(() => {}) } },
      { type: "separator" },
      { label: l.about, click: showAbout },
    ] },
  ]

  applicationMenu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(applicationMenu)
  updateWorkspaceMenuState()
}
