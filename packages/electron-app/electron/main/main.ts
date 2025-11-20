import { app, BrowserView, BrowserWindow, nativeImage, session } from "electron"
import { existsSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { createApplicationMenu } from "./menu"
import { setupCliIPC } from "./ipc"
import { CliProcessManager } from "./process-manager"

const mainFilename = fileURLToPath(import.meta.url)
const mainDirname = dirname(mainFilename)

const isMac = process.platform === "darwin"

const cliManager = new CliProcessManager()
let mainWindow: BrowserWindow | null = null
let currentCliUrl: string | null = null
let pendingCliUrl: string | null = null
let showingLoadingScreen = false
let preloadingView: BrowserView | null = null

if (isMac) {
  app.commandLine.appendSwitch("disable-spell-checking")
}

function getIconPath() {
  if (app.isPackaged) {
    return join(process.resourcesPath, "icon.png")
  }

  return join(mainDirname, "../resources/icon.png")
}

function getLoadingHtmlPath() {
  if (app.isPackaged) {
    return join(process.resourcesPath, "loading.html")
  }

  const distResources = join(mainDirname, "../resources/loading.html")
  if (existsSync(distResources)) {
    return distResources
  }

  const devResources = join(mainDirname, "../electron/resources/loading.html")
  if (existsSync(devResources)) {
    return devResources
  }

  return join(process.cwd(), "electron/resources/loading.html")
}

let cachedPreloadPath: string | null = null
function getPreloadPath() {
  if (cachedPreloadPath && existsSync(cachedPreloadPath)) {
    return cachedPreloadPath
  }

  const candidates = [
    join(process.resourcesPath, "preload/index.js"),
    join(mainDirname, "../preload/index.js"),
    join(mainDirname, "../preload/index.cjs"),
    join(mainDirname, "../../preload/index.cjs"),
    join(mainDirname, "../../electron/preload/index.cjs"),
    join(app.getAppPath(), "preload/index.cjs"),
    join(app.getAppPath(), "electron/preload/index.cjs"),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedPreloadPath = candidate
      return candidate
    }
  }

  return join(mainDirname, "../preload/index.js")
}

function destroyPreloadingView(target?: BrowserView | null) {
  const view = target ?? preloadingView
  if (!view) {
    return
  }

  try {
    const contents = view.webContents as any
    contents?.destroy?.()
  } catch (error) {
    console.warn("[cli] failed to destroy preloading view", error)
  }

  if (!target || view === preloadingView) {
    preloadingView = null
  }
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
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: !isMac,
    },
  })

  if (isMac) {
    mainWindow.webContents.session.setSpellCheckerEnabled(false)
  }

  const loadingHtml = getLoadingHtmlPath()
  showingLoadingScreen = true
  currentCliUrl = null
  mainWindow.loadFile(loadingHtml).catch((error) => console.error("[cli] failed to load loading screen:", error))

  if (process.env.NODE_ENV === "development") {
    mainWindow.webContents.openDevTools({ mode: "detach" })
  }

  createApplicationMenu(mainWindow)
  setupCliIPC(mainWindow, cliManager)

  mainWindow.on("closed", () => {
    destroyPreloadingView()
    mainWindow = null
    currentCliUrl = null
    pendingCliUrl = null
    showingLoadingScreen = false
  })

  if (pendingCliUrl) {
    const url = pendingCliUrl
    pendingCliUrl = null
    startCliPreload(url)
  }
}

function showLoadingScreen(force = false) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  if (showingLoadingScreen && !force) {
    return
  }

  destroyPreloadingView()
  showingLoadingScreen = true
  currentCliUrl = null
  pendingCliUrl = null
  const loadingHtml = getLoadingHtmlPath()
  mainWindow.loadFile(loadingHtml).catch((error) => console.error("[cli] failed to load loading screen:", error))
}

function startCliPreload(url: string) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingCliUrl = url
    return
  }

  if (currentCliUrl === url && !showingLoadingScreen) {
    return
  }

  pendingCliUrl = url
  destroyPreloadingView()

  if (!showingLoadingScreen) {
    showLoadingScreen(true)
  }

  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: !isMac,
    },
  })

  preloadingView = view

  view.webContents.once("did-finish-load", () => {
    if (preloadingView !== view) {
      destroyPreloadingView(view)
      return
    }
    finalizeCliSwap(url)
  })

  view.webContents.loadURL(url).catch((error) => {
    console.error("[cli] failed to preload CLI view:", error)
    if (preloadingView === view) {
      destroyPreloadingView(view)
    }
  })
}

function finalizeCliSwap(url: string) {
  destroyPreloadingView()

  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingCliUrl = url
    return
  }

  showingLoadingScreen = false
  currentCliUrl = url
  pendingCliUrl = null
  mainWindow.loadURL(url).catch((error) => console.error("[cli] failed to load CLI view:", error))
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
  if (!status.url) {
    return
  }
  startCliPreload(status.url)
})

cliManager.on("status", (status) => {
  if (status.state !== "ready") {
    showLoadingScreen()
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
