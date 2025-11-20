import { app, BrowserWindow, nativeImage, session } from "electron"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { createApplicationMenu } from "./menu"
import { setupCliIPC } from "./ipc"
import { CliProcessManager } from "./process-manager"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const isMac = process.platform === "darwin"
const cliManager = new CliProcessManager()
let mainWindow: BrowserWindow | null = null

if (isMac) {
  app.commandLine.appendSwitch("disable-spell-checking")
}

function getIconPath() {
  if (app.isPackaged) {
    return join(process.resourcesPath, "icon.png")
  }

  return join(__dirname, "../resources/icon.png")
}

function getLoadingHtmlPath() {
  if (app.isPackaged) {
    return join(process.resourcesPath, "loading.html")
  }

  return join(__dirname, "../resources/loading.html")
}

function createWindow() {
  const prefersDark = true
  const backgroundColor = prefersDark ? "#1a1a1a" : "#ffffff"
  const iconPath = getIconPath()

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: !isMac,
    },
  })

  if (isMac) {
    mainWindow.webContents.session.setSpellCheckerEnabled(false)
  }

  const loadingHtml = getLoadingHtmlPath()
  mainWindow.loadFile(loadingHtml)

  if (process.env.NODE_ENV === "development") {
    mainWindow.webContents.openDevTools({ mode: "detach" })
  }

  createApplicationMenu(mainWindow)
  setupCliIPC(mainWindow, cliManager)

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

async function startCli() {
  try {
    const devMode = process.env.NODE_ENV === "development"
    console.info("[cli] start requested (dev mode:", devMode, ")")
    await cliManager.start({ dev: devMode })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[cli] start failed:", message)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cli:error", { message })
    }
  }
}

cliManager.on("ready", (status) => {
  if (status.url && mainWindow && !mainWindow.isDestroyed()) {
    console.info(`[cli] navigating main window to ${status.url}`)
    mainWindow.loadURL(status.url)
  }
})

if (isMac) {
  app.on("web-contents-created", (_, contents) => {
    contents.session.setSpellCheckerEnabled(false)
  })
}

app.whenReady().then(() => {
  startCli()

  if (isMac) {
    session.defaultSession.setSpellCheckerEnabled(false)
    app.on("browser-window-created", (_, window) => {
      window.webContents.session.setSpellCheckerEnabled(false)
    })

    if (app.dock) {
      const dockIcon = nativeImage.createFromPath(getIconPath())
      if (!dockIcon.isEmpty()) {
        app.dock.setIcon(dockIcon)
      }
    }
  }

  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on("before-quit", async (event) => {
  event.preventDefault()
  await cliManager.stop().catch(() => {})
  app.exit(0)
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
