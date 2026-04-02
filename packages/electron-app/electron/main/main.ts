import { app, BrowserView, BrowserWindow, nativeImage, session, shell } from "electron"
import http from "node:http"
import https from "node:https"
import { existsSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { createApplicationMenu } from "./menu"
import { setupCliIPC } from "./ipc"
import { configureMediaPermissionHandlers } from "./permissions"
import { CliProcessManager } from "./process-manager"

const mainFilename = fileURLToPath(import.meta.url)
const mainDirname = dirname(mainFilename)

const isMac = process.platform === "darwin"

const cliManager = new CliProcessManager()
let mainWindow: BrowserWindow | null = null
let currentCliUrl: string | null = null
let pendingCliUrl: string | null = null
let pendingBootstrapToken: string | null = null
let showingLoadingScreen = false
let preloadingView: BrowserView | null = null
const remoteWindowOrigins = new Map<number, Set<string>>()
const insecureWindowOrigins = new Map<number, Set<string>>()

if (isMac) {
  app.commandLine.appendSwitch("disable-spell-checking")
}

function getIconPath() {
  if (app.isPackaged) {
    return join(process.resourcesPath, "icon.png")
  }

  return join(mainDirname, "../resources/icon.png")
}

type LoadingTarget =
  | { type: "url"; source: string }
  | { type: "file"; source: string }

function resolveDevLoadingUrl(): string | null {
  if (app.isPackaged) {
    return null
  }
  const devBase = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL
  if (!devBase) {
    return null
  }

  try {
    const normalized = devBase.endsWith("/") ? devBase : `${devBase}/`
    return new URL("loading.html", normalized).toString()
  } catch (error) {
    console.warn("[cli] failed to construct dev loading URL", devBase, error)
    return null
  }
}

function resolveLoadingTarget(): LoadingTarget {
  const devUrl = resolveDevLoadingUrl()
  if (devUrl) {
    return { type: "url", source: devUrl }
  }
  const filePath = resolveLoadingFilePath()
  return { type: "file", source: filePath }
}

function resolveLoadingFilePath() {
  const candidates = [
    join(app.getAppPath(), "dist/renderer/loading.html"),
    join(process.resourcesPath, "dist/renderer/loading.html"),
    join(mainDirname, "../dist/renderer/loading.html"),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return join(app.getAppPath(), "dist/renderer/loading.html")
}

function loadLoadingScreen(window: BrowserWindow) {
  const target = resolveLoadingTarget()
  const loader =
    target.type === "url"
      ? window.loadURL(target.source)
      : window.loadFile(target.source)

  loader.catch((error) => {
    console.error("[cli] failed to load loading screen:", error)
  })
}

function getAllowedRendererOrigins(window?: BrowserWindow | null): string[] {
  const origins = new Set<string>()
  if (window) {
    for (const origin of remoteWindowOrigins.get(window.id) ?? []) {
      origins.add(origin)
    }
  }
  const rendererCandidates = [currentCliUrl, process.env.VITE_DEV_SERVER_URL, process.env.ELECTRON_RENDERER_URL]
  for (const candidate of rendererCandidates) {
    if (!candidate) {
      continue
    }
    try {
      origins.add(new URL(candidate).origin)
    } catch (error) {
      console.warn("[cli] failed to parse origin for", candidate, error)
    }
  }
  return Array.from(origins)
}

function shouldOpenExternally(url: string, window?: BrowserWindow | null): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return true
    }
    const allowedOrigins = getAllowedRendererOrigins(window)
    return !allowedOrigins.includes(parsed.origin)
  } catch {
    return false
  }
}

function setupNavigationGuards(window: BrowserWindow) {
  const handleExternal = (url: string) => {
    shell.openExternal(url).catch((error) => console.error("[cli] failed to open external URL", url, error))
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternally(url, window)) {
      handleExternal(url)
      return { action: "deny" }
    }
    return { action: "allow" }
  })

  window.webContents.on("will-navigate", (event, url) => {
    if (shouldOpenExternally(url, window)) {
      event.preventDefault()
      handleExternal(url)
    }
  })
}

function setWindowAllowedOrigin(window: BrowserWindow, url: string) {
  try {
    const origin = new URL(url).origin
    remoteWindowOrigins.set(window.id, new Set([origin]))
  } catch (error) {
    console.warn("[cli] failed to store allowed origin", url, error)
  }
}

function clearWindowAllowedOrigin(window: BrowserWindow) {
  remoteWindowOrigins.delete(window.id)
}

function addWindowInsecureOrigin(window: BrowserWindow, url: string) {
  try {
    const origin = new URL(url).origin
    insecureWindowOrigins.set(window.id, new Set([origin]))
  } catch (error) {
    console.warn("[cli] failed to store insecure origin", url, error)
  }
}

function clearWindowInsecureOrigin(window: BrowserWindow) {
  insecureWindowOrigins.delete(window.id)
}

function isInsecureOriginAllowed(url: string) {
  try {
    const targetOrigin = new URL(url).origin
    for (const origins of insecureWindowOrigins.values()) {
      if (origins.has(targetOrigin)) {
        return true
      }
    }
  } catch {
    return false
  }

  return false
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

  const window = mainWindow

  setupNavigationGuards(window)

  if (isMac) {
    window.webContents.session.setSpellCheckerEnabled(false)
  }

  showingLoadingScreen = true
  currentCliUrl = null
  clearWindowAllowedOrigin(window)
  loadLoadingScreen(window)

  if (process.env.NODE_ENV === "development") {
    window.webContents.openDevTools({ mode: "detach" })
  }

  createApplicationMenu(window)
  setupCliIPC(window, cliManager)

  window.on("closed", () => {
    destroyPreloadingView()
    clearWindowAllowedOrigin(window)
    clearWindowInsecureOrigin(window)
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
  loadLoadingScreen(mainWindow)
}

function isBootstrapTokenUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.pathname === "/auth/token" && parsed.hash.length > 1
  } catch {
    return false
  }
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

  // Important: /auth/token#... is one-time. Preloading + swapping would load it twice,
  // consuming the token in the hidden view and then failing in the main window.
  if (isBootstrapTokenUrl(url)) {
    finalizeCliSwap(url)
    return
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

  const window = mainWindow
  showingLoadingScreen = false
  currentCliUrl = url
  setWindowAllowedOrigin(window, url)
  pendingCliUrl = null
  window.loadURL(url).catch((error) => console.error("[cli] failed to load CLI view:", error))
}

function buildRemoteWindowTitle(name: string, baseUrl: string) {
  try {
    const parsed = new URL(baseUrl)
    return `${name} - ${parsed.host}`
  } catch {
    return `${name} - ${baseUrl}`
  }
}

function buildRemoteErrorHtml(name: string, baseUrl: string, message: string) {
  const escapedName = name.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] ?? char))
  const escapedUrl = baseUrl.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] ?? char))
  const escapedMessage = message.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] ?? char))
  return `<!doctype html><html><head><meta charset="utf-8" /><title>${escapedName}</title><style>body{margin:0;background:#111827;color:#f9fafb;font-family:Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}main{max-width:560px;width:100%;background:rgba(17,24,39,.88);border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:28px;box-shadow:0 25px 60px rgba(0,0,0,.45)}h1{margin:0 0 10px;font-size:1.5rem}p{margin:0 0 10px;color:#cbd5e1;line-height:1.5}code{display:block;margin-top:16px;padding:12px 14px;border-radius:12px;background:#0f172a;color:#bfdbfe;overflow:auto}</style></head><body><main><h1>${escapedName}</h1><p>Could not connect to the remote server.</p><p>${escapedMessage}</p><code>${escapedUrl}</code></main></body></html>`
}

async function openRemoteWindow(payload: { id: string; name: string; baseUrl: string; skipTlsVerify: boolean }) {
  const targetUrl = new URL(payload.baseUrl)
  const title = buildRemoteWindowTitle(payload.name, payload.baseUrl)
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#1a1a1a",
    icon: getIconPath(),
    title,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: !isMac,
    },
  })

  setWindowAllowedOrigin(window, targetUrl.toString())
  if (payload.skipTlsVerify) {
    addWindowInsecureOrigin(window, targetUrl.toString())
  }

  setupNavigationGuards(window)
  window.on("closed", () => {
    clearWindowAllowedOrigin(window)
    clearWindowInsecureOrigin(window)
  })

  try {
    await window.loadURL(targetUrl.toString())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildRemoteErrorHtml(payload.name, payload.baseUrl, message))}`)
  }
}

let bootstrapExchangeInFlight = false

function extractCookieValue(setCookieHeader: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader
  if (!raw) return null

  const first = raw.split(";")[0] ?? ""
  const index = first.indexOf("=")
  if (index < 0) return null

  const key = first.slice(0, index).trim()
  const value = first.slice(index + 1).trim()
  if (key !== name || !value) return null

  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function exchangeBootstrapToken(baseUrl: string, token: string): Promise<boolean> {
  const sessionCookieName = cliManager.getAuthCookieName()
  const target = new URL("/api/auth/token", baseUrl)
  const body = JSON.stringify({ token })

  const transport = target.protocol === "https:" ? https : http

  const result = await new Promise<{ statusCode: number; setCookie: string | string[] | undefined }>((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume()
        resolve({ statusCode: res.statusCode ?? 0, setCookie: res.headers["set-cookie"] })
      },
    )

    req.on("error", reject)
    req.write(body)
    req.end()
  })

  if (result.statusCode !== 200) {
    return false
  }

  const sessionId = extractCookieValue(result.setCookie, sessionCookieName)
  if (!sessionId) {
    return false
  }

  await session.defaultSession.cookies.set({
    url: baseUrl,
    name: sessionCookieName,
    value: sessionId,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
  })

  return true
}

async function startCli() {
  try {
    // In desktop dev workflows we always want the CLI to run in dev mode so it:
    // - uses plain HTTP
    // - proxies UI requests to the renderer dev server
    // Monaco's AMD assets are served from that dev server.
    const devMode = !app.isPackaged
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

async function maybeExchangeAndNavigate(baseUrl: string) {
  if (bootstrapExchangeInFlight) {
    return
  }

  const token = pendingBootstrapToken
  if (!token) {
    startCliPreload(baseUrl)
    return
  }

  bootstrapExchangeInFlight = true

  try {
    const ok = await exchangeBootstrapToken(baseUrl, token)
    pendingBootstrapToken = null

    if (!ok) {
      startCliPreload(`${baseUrl}/login`)
      return
    }

    startCliPreload(baseUrl)
  } catch (error) {
    console.error("[cli] bootstrap token exchange failed:", error)
    pendingBootstrapToken = null
    startCliPreload(`${baseUrl}/login`)
  } finally {
    bootstrapExchangeInFlight = false
  }
}

cliManager.on("bootstrapToken", (token) => {
  pendingBootstrapToken = token

  const status = cliManager.getStatus()
  if (status.url) {
    void maybeExchangeAndNavigate(status.url)
  }
})

cliManager.on("ready", (status) => {
  if (!status.url) {
    return
  }

  void maybeExchangeAndNavigate(status.url)
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
  // Required for Windows notifications / taskbar grouping.
  // Keep in sync with desktop app identifier.
  try {
    app.setAppUserModelId("ai.neuralnomads.codenomad.client")
  } catch {
    // ignore
  }

  startCli()

  if (isMac) {
    session.defaultSession.setSpellCheckerEnabled(false)
    configureMediaPermissionHandlers(getAllowedRendererOrigins)
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
  ;(mainWindow as BrowserWindow & { __codenomadOpenRemoteWindow?: typeof openRemoteWindow }).__codenomadOpenRemoteWindow = openRemoteWindow

  app.on("certificate-error", (event, _webContents, url, error, _certificate, callback) => {
    if (isInsecureOriginAllowed(url)) {
      event.preventDefault()
      console.warn("[cli] allowing insecure remote certificate for", url, error)
      callback(true)
      return
    }
    callback(false)
  })

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
  // CodeNomad supports a single window; closing it should quit the app on all platforms.
  app.quit()
})
