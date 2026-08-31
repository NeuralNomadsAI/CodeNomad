import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron"
import { NEW_WINDOW_ACCELERATOR } from "./menu-target"

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

function target(local: boolean): BrowserWindow | null {
  const window = (local ? actions?.getLocalTarget() : actions?.getWindowTarget()) ?? null
  return window && !window.isDestroyed() ? window : null
}

function updateWorkspaceMenuState() {
  const window = target(true)
  const enabled = Boolean(window && workspaceEnabled.get(window.webContents.id))
  for (const id of ["open-workspace-folder", "open-workspace-terminal", "open-workspace-editor"]) {
    const item = applicationMenu?.getMenuItemById(id)
    if (item) item.enabled = enabled
  }
}

export function setWorkspaceMenuEnabled(window: BrowserWindow, enabled: boolean) {
  workspaceEnabled.set(window.webContents.id, enabled)
  updateWorkspaceMenuState()
}

export function clearWorkspaceMenuWindow(webContentsId: number) {
  workspaceEnabled.delete(webContentsId)
  updateWorkspaceMenuState()
}

export function createApplicationMenu(menuActions: ApplicationMenuActions) {
  actions = menuActions
  if (menuInstalled) return
  menuInstalled = true
  const isMac = process.platform === "darwin"
  const sendCommand = (id: string) => () => target(true)?.webContents.send("menu:action", id)
  const withTarget = (operation: (window: BrowserWindow) => void) => () => {
    const window = target(false)
    if (window) operation(window)
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ label: "CodeNomad", submenu: [
      { role: "about" as const }, { type: "separator" as const }, { role: "hide" as const },
      { role: "hideOthers" as const }, { role: "unhide" as const }, { type: "separator" as const }, { role: "quit" as const },
    ] }] : []),
    {
      label: "File",
      submenu: [
        { id: "open-workspace-folder", label: "Open Project Folder", click: sendCommand("open-workspace-folder") },
        { id: "open-workspace-terminal", label: "Open Terminal Here", click: sendCommand("open-workspace-terminal") },
        { id: "open-workspace-editor", label: "Open Project In", submenu: [
          { label: "VS Code", click: sendCommand("open-workspace-editor-vscode") },
          { label: "Cursor", click: sendCommand("open-workspace-editor-cursor") },
          { label: "Zed", click: sendCommand("open-workspace-editor-zed") },
          { label: "VSCodium", click: sendCommand("open-workspace-editor-vscodium") },
        ] },
        { type: "separator" }, isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" },
      ...(isMac ? [{ role: "pasteAndMatchStyle" as const }, { role: "delete" as const }, { role: "selectAll" as const }]
        : [{ role: "delete" as const }, { type: "separator" as const }, { role: "selectAll" as const }]),
    ] },
    { label: "View", submenu: [
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: withTarget((window) => actions?.reload(window)) },
      { label: "Force Reload", accelerator: "CmdOrCtrl+Shift+R", click: withTarget((window) => actions?.forceReload(window)) },
      { label: "Toggle Developer Tools", accelerator: isMac ? "Alt+Command+I" : "Ctrl+Shift+I", click: withTarget((window) => window.webContents.toggleDevTools()) },
      { type: "separator" },
      { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: withTarget((window) => window.webContents.setZoomLevel(0)) },
      { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: withTarget((window) => window.webContents.setZoomLevel(window.webContents.getZoomLevel() + 0.5)) },
      { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: withTarget((window) => window.webContents.setZoomLevel(window.webContents.getZoomLevel() - 0.5)) },
      { type: "separator" },
      { label: "Toggle Full Screen", accelerator: isMac ? "Ctrl+Command+F" : "F11", click: withTarget((window) => window.setFullScreen(!window.isFullScreen())) },
    ] },
    { label: "Window", submenu: [
      { label: "New Window", accelerator: NEW_WINDOW_ACCELERATOR, click: () => actions?.newWindow() },
      { label: "New Instance", accelerator: "CmdOrCtrl+N", click: sendCommand("new-instance") },
      { label: "Command Palette", accelerator: "CmdOrCtrl+Shift+P", click: sendCommand("open-command-palette") },
      { type: "separator" },
      { label: "Minimize", accelerator: "CmdOrCtrl+M", click: withTarget((window) => window.minimize()) },
      ...(isMac ? [{ role: "front" as const }] : [{ label: "Close", accelerator: "CmdOrCtrl+W", click: withTarget((window) => window.close()) }]),
    ] },
  ]

  applicationMenu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(applicationMenu)
  updateWorkspaceMenuState()
  app.on("browser-window-focus", updateWorkspaceMenuState)
  app.on("browser-window-blur", updateWorkspaceMenuState)
}
