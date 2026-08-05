import { app, Menu, BrowserWindow, MenuItemConstructorOptions } from "electron"

interface ApplicationMenuActions {
  reload(): void
  forceReload(): void
}

let workspaceActionsRequested = false
let applicationMenu: Menu | null = null
let localMainWindow: BrowserWindow | null = null

function updateWorkspaceMenuState() {
  const enabled = workspaceActionsRequested && BrowserWindow.getFocusedWindow() === localMainWindow
  for (const id of ["open-workspace-folder", "open-workspace-terminal", "open-workspace-editor"]) {
    const item = applicationMenu?.getMenuItemById(id)
    if (item) item.enabled = enabled
  }
}

export function setWorkspaceMenuEnabled(enabled: boolean) {
  workspaceActionsRequested = enabled
  updateWorkspaceMenuState()
}

export function createApplicationMenu(mainWindow: BrowserWindow, actions: ApplicationMenuActions) {
  localMainWindow = mainWindow
  const isMac = process.platform === "darwin"
  const sendCommand = (id: string) => () => {
    if (id.startsWith("open-workspace-") && BrowserWindow.getFocusedWindow() !== mainWindow) return
    mainWindow.webContents.send("menu:action", id)
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "CodeNomad",
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Instance",
          accelerator: "CmdOrCtrl+N",
          click: sendCommand("new-instance"),
        },
        { type: "separator" as const },
        { id: "open-workspace-folder", label: "Open Project Folder", click: sendCommand("open-workspace-folder") },
        { id: "open-workspace-terminal", label: "Open Terminal Here", click: sendCommand("open-workspace-terminal") },
        {
          id: "open-workspace-editor",
          label: "Open Project In",
          submenu: [
            { label: "VS Code", click: sendCommand("open-workspace-editor-vscode") },
            { label: "Cursor", click: sendCommand("open-workspace-editor-cursor") },
            { label: "Zed", click: sendCommand("open-workspace-editor-zed") },
            { label: "VSCodium", click: sendCommand("open-workspace-editor-vscodium") },
          ],
        },
        { type: "separator" as const },
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" as const },
        { role: "redo" as const },
        { type: "separator" as const },
        { role: "cut" as const },
        { role: "copy" as const },
        { role: "paste" as const },
        ...(isMac
          ? [{ role: "pasteAndMatchStyle" as const }, { role: "delete" as const }, { role: "selectAll" as const }]
          : [{ role: "delete" as const }, { type: "separator" as const }, { role: "selectAll" as const }]),
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: actions.reload },
        { label: "Force Reload", accelerator: "CmdOrCtrl+Shift+R", click: actions.forceReload },
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
        { type: "separator" as const },
        { role: "togglefullscreen" as const },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" as const },
        { role: "zoom" as const },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const },
              { type: "separator" as const },
              { role: "window" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  applicationMenu = menu
  Menu.setApplicationMenu(menu)
  updateWorkspaceMenuState()
  mainWindow.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return
    workspaceActionsRequested = false
    updateWorkspaceMenuState()
  })
  app.on("browser-window-focus", updateWorkspaceMenuState)
  app.on("browser-window-blur", updateWorkspaceMenuState)
}
