import { app, BrowserWindow, ipcMain, nativeImage, screen, session, shell } from "electron"
import http from "node:http"
import https from "node:https"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ClientStateManager } from "./client-state"
import { setupClientStateIPC } from "./client-state-ipc"
import { ClientStateNavigationController } from "./client-state-navigation"
import { setupCliIPC } from "./ipc"
import { LocalWindowRegistry, type LocalWindowRecord } from "./local-window-registry"
import { clearWorkspaceMenuWindow, createApplicationMenu, setWorkspaceMenuEnabled } from "./menu"
import { resolveFocusedLocalTarget, resolveWindowTarget } from "./menu-target"
import { MultiwindowLifecycle } from "./multiwindow-lifecycle"
import { decideNavigation, requireHttpUrl } from "./navigation-security"
import { configureMediaPermissionHandlers, isAllowedRendererOrigin } from "./permissions"
import { CliProcessManager } from "./process-manager"
import { navigateRemoteWindow, RemoteWindowRegistry } from "./remote-window-registry"
import { resolveConfiguredRendererOrigins } from "./renderer-origin"
import { allocateLocalWindowIdentity, BackendBootstrapCoordinator, createLaunchIntentQueue, isRemoteCertificateAllowed, parseLaunchIntent, resolveRemoteSessionPartition, resolveStorageScope, startPrimaryInstance, type LaunchIntent } from "./startup"
import { clampWindowBounds, DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH, installWindowZoomInput, restoreWindowState, WindowStateTracker } from "./window-state"

const mainDirname = dirname(fileURLToPath(import.meta.url))
const isMac = process.platform === "darwin"

function configureStoragePaths() {
  const baseUserDataPath = app.isPackaged ? app.getPath("userData") : join(app.getPath("appData"), "CodeNomad")
  if (!app.isPackaged) app.setName("CodeNomad")
  const scope = resolveStorageScope({
    appVersion: app.getVersion(), environmentChannel: process.env.CODENOMAD_UPDATE_CHANNEL,
    cliConfig: process.env.CLI_CONFIG, cwd: process.cwd(), baseUserDataPath, packaged: app.isPackaged,
  })
  mkdirSync(scope.userDataPath, { recursive: true })
  mkdirSync(scope.sessionDataPath, { recursive: true })
  app.setPath("userData", scope.userDataPath)
  app.setPath("sessionData", scope.sessionDataPath)
  return scope
}

function cleanupPackagedChromiumStorage() {
  if (!app.isPackaged) return
  for (const root of [app.getPath("sessionData"), app.getPath("userData"), join(app.getPath("userData"), "session-data")]) {
    for (const name of ["Service Worker", "QuotaManager", "QuotaManager-journal"]) {
      const candidate = join(root, name)
      if (!existsSync(candidate)) continue
      try { rmSync(candidate, { recursive: true, force: true }) } catch (error) { console.warn("[electron-startup] failed to remove stale Chromium storage", candidate, error) }
    }
  }
}

function argvForLaunch(argv: string[]): string[] {
  return argv.slice(app.isPackaged ? 1 : 2)
}

const storageScope = configureStoragePaths()
const initialIntent = parseLaunchIntent(argvForLaunch(process.argv), process.cwd())
startPrimaryInstance(() => app.requestSingleInstanceLock(), () => app.quit(), () => runPrimary(initialIntent))

function runPrimary(firstIntent: LaunchIntent) {
  cleanupPackagedChromiumStorage()
  const clientState = new ClientStateManager(app.getPath("userData"), undefined, storageScope.clientStateElectionDirectory
    ? { crossHostElectionDirectory: storageScope.clientStateElectionDirectory }
    : undefined)
  const cli = new CliProcessManager()
  const registry = new LocalWindowRegistry(async (id) => { await clientState.setActiveWindow(id) })
  const remoteOrigins = new Map<number, Set<string>>()
  const insecureOrigins = new Map<number, Set<string>>()
  let backendUrl: string | null = null
  let backendTargetUrl: string | null = null
  const remoteWindows = new RemoteWindowRegistry((sessionId) => {
    if (!backendUrl) return
    const target = new URL(`/api/remote-proxy/sessions/${encodeURIComponent(sessionId)}`, backendUrl)
    const request = (target.protocol === "https:" ? https : http).request(target, { method: "DELETE" }, (response) => response.resume())
    request.on("error", (error) => console.warn("[electron] failed to clean up remote proxy session", sessionId, error))
    request.end()
  })

  const getAllowedOrigins = (window?: BrowserWindow | null): string[] => {
    const origins = new Set(remoteOrigins.get(window?.id ?? -1) ?? [])
    for (const origin of resolveConfiguredRendererOrigins(backendUrl, app.isPackaged, [process.env.VITE_DEV_SERVER_URL, process.env.ELECTRON_RENDERER_URL])) origins.add(origin)
    return [...origins]
  }
  const lifecycle = new MultiwindowLifecycle({
    app, clientStateManager: clientState, cliManager: cli,
    getLocalWindows: () => registry.all(), getAllWindows: () => BrowserWindow.getAllWindows(),
    removeWindowState: (id) => clientState.removeWindow(id), getAllowedRendererOrigins: getAllowedOrigins,
    isTrustedRendererOrigin: isAllowedRendererOrigin,
  })
  const bindClientState = setupClientStateIPC(ipcMain, clientState, (sender) => registry.resolve(sender), getAllowedOrigins)

  const loadingTarget = (): { url?: string; file?: string } => {
    if (!app.isPackaged) {
      const base = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL
      if (base) return { url: new URL("loading.html", base.endsWith("/") ? base : `${base}/`).toString() }
    }
    const candidates = [join(app.getAppPath(), "dist/renderer/loading.html"), join(process.resourcesPath, "dist/renderer/loading.html"), join(mainDirname, "../dist/renderer/loading.html")]
    return { file: candidates.find(existsSync) ?? candidates[0] }
  }
  const getLoadingUrl = () => {
    const target = loadingTarget()
    return target.url ?? pathToFileURL(target.file!).toString()
  }
  const loadLoading = async (record: LocalWindowRecord, force = false) => {
    if (record.window.isDestroyed() || (record.loading && !force)) return
    record.loading = true
    const target = loadingTarget()
    await record.navigation.navigate(async (window, generation) => {
      if (!record.navigation.isCurrent(generation)) return
      await (target.url ? window.loadURL(target.url) : window.loadFile(target.file!))
      if (!record.navigation.isCurrent(generation)) return
      record.backendUrl = null
      remoteOrigins.delete(record.window.id)
    }).catch((error) => {
      if (!isIgnorableNavigationError(error)) console.error("[cli] failed to load loading screen", error)
    })
  }
  const navigateBackend = async (record: LocalWindowRecord, url: string) => {
    if (record.window.isDestroyed() || (!record.loading && record.backendUrl === url)) return
    let origin: string
    try { origin = new URL(url).origin } catch { return }
    await record.navigation.navigate(async (window, generation) => {
      if (!record.navigation.isCurrent(generation)) return
      const previous = remoteOrigins.get(record.window.id)
      remoteOrigins.set(record.window.id, new Set([...(previous ?? []), origin]))
      try { await window.loadURL(url) } catch (error) {
        if (record.navigation.isCurrent(generation)) {
          if (previous) remoteOrigins.set(record.window.id, previous); else remoteOrigins.delete(record.window.id)
        }
        throw error
      }
      if (!record.navigation.isCurrent(generation)) return
      record.loading = false
      record.backendUrl = url
      remoteOrigins.set(record.window.id, new Set([origin]))
    }).catch((error) => {
      if (!isIgnorableNavigationError(error)) console.error("[cli] failed to load backend", error)
    })
  }
  const bootstrap = new BackendBootstrapCoordinator(
    (url, token) => exchangeBootstrapToken(url, token, cli),
    (url) => {
      backendTargetUrl = url
      for (const record of registry.all()) void navigateBackend(record, url)
    },
    (error) => console.error("[cli] bootstrap token exchange failed", error),
  )

  const createWindow = (windowId: string, persisted = true): LocalWindowRecord => {
    const saved = persisted ? clientState.getWindowState(windowId) : undefined
    const bounds = saved ? clampWindowBounds(saved.bounds, screen.getAllDisplays().map((display) => ({ ...display.workArea, scaleFactor: display.scaleFactor }))) : undefined
    const window = new BrowserWindow({
      width: bounds?.width ?? DEFAULT_WINDOW_WIDTH, height: bounds?.height ?? DEFAULT_WINDOW_HEIGHT,
      ...(bounds ? { x: bounds.x, y: bounds.y } : {}), useContentSize: true, minWidth: 800, minHeight: 600,
      backgroundColor: "#1a1a1a", icon: getIconPath(),
      webPreferences: {
        preload: getPreloadPath(), contextIsolation: true, nodeIntegration: false, spellcheck: !isMac,
        ...(saved ? { zoomFactor: saved.zoomFactor } : {}),
        additionalArguments: ["--codenomad-window-context=local", `--codenomad-window-id=${windowId}`],
      },
    })
    const navigation = new ClientStateNavigationController(window, {
      clientStateManager: persisted ? clientState : { isPrimary: false },
      isTrustedOrigin: (url) => isAllowedRendererOrigin(url, getAllowedOrigins(window)),
      reportFlushError: (error) => console.warn("[client-state] renderer pre-navigation flush failed", error),
    })
    const tracker = persisted && clientState.isPrimary ? new WindowStateTracker(window, clientState, saved, windowId) : null
    if (persisted && clientState.isPrimary) restoreWindowState(window, saved, bounds)
    const record: LocalWindowRecord = { id: windowId, persisted, window, navigation, tracker, loading: false, backendUrl: null, pendingFolders: [] }
    registry.add(record)
    bindClientState(window)
    lifecycle.attach(record)
    installWindowZoomInput(window, (level) => tracker ? tracker.setZoomLevel(level) : window.webContents.setZoomLevel(level))
    setupNavigationGuards(window, navigation, getAllowedOrigins, getLoadingUrl)
    window.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) setWorkspaceMenuEnabled(window, false)
    })
    window.on("focus", () => registry.markFocused(windowId))
    window.on("closed", () => {
      registry.remove(windowId)
      clearWorkspaceMenuWindow(window)
      remoteOrigins.delete(window.id)
      insecureOrigins.delete(window.webContents.id)
    })
    if (isMac) window.webContents.session.setSpellCheckerEnabled(false)
    if (process.env.NODE_ENV === "development") window.webContents.openDevTools({ mode: "detach" })
    void (backendTargetUrl ? navigateBackend(record, backendTargetUrl) : loadLoading(record))
    return record
  }

  const ensureLocalWindow = () => {
    const existing = registry.mruRecord()
    if (existing) return existing
    const persistedId = clientState.windowIds.find((id) => !registry.get(id))
    return persistedId ? createWindow(persistedId) : undefined
  }
  const createNewWindow = async () => {
    const identity = await allocateLocalWindowIdentity(
      clientState.windowIds,
      (id) => Boolean(registry.get(id)),
      () => clientState.addWindow(),
      (error) => console.warn("[client-state] failed to persist a new window; using an ephemeral window", error),
    )
    return createWindow(identity.id, identity.persisted)
  }
  const handleIntent = async (intent: LaunchIntent) => {
    const record = intent.newWindow ? await createNewWindow() : registry.focusMru() ?? ensureLocalWindow() ?? await createNewWindow()
    for (const folder of intent.folders) registry.queueFolder(record.id, folder)
    registry.focus(record.id)
  }
  const intentQueue = createLaunchIntentQueue(handleIntent, (error) => console.error("[electron-startup] launch intent failed", error))
  const firstLaunch = intentQueue.enqueue(firstIntent)
  void firstLaunch.catch(() => {})

  setupCliIPC(cli, {
    resolveLocal: (sender) => registry.resolve(sender), getAllowedOrigins,
    openRemoteWindow, newWindow: () => intentQueue.enqueue({ newWindow: true, folders: [] }),
    nextFolder: (id) => registry.nextFolder(id), acknowledgeFolder: (id, folder, opened) => registry.acknowledgeFolder(id, folder, opened),
  })
  lifecycle.registerAppEvents()
  app.on("second-instance", (_event, argv, workingDirectory) => {
    void intentQueue.enqueue(parseLaunchIntent(argvForLaunch(argv), workingDirectory || process.cwd())).catch(() => {})
  })
  app.on("open-file", (event, path) => {
    event.preventDefault()
    const intent = parseLaunchIntent([path], process.cwd())
    if (intent.folders.length) void intentQueue.enqueue(intent).catch(() => {})
  })
  app.on("certificate-error", (event, contents, url, error, _certificate, callback) => {
    if (contents && isRemoteCertificateAllowed(contents.id, url, insecureOrigins)) {
      event.preventDefault(); console.warn("[cli] allowing insecure remote certificate", url, error); callback(true)
    } else callback(false)
  })

  cli.on("bootstrapToken", (token) => bootstrap.setToken(token))
  cli.on("ready", (status) => {
    if (!status.url) return
    backendUrl = status.url
    bootstrap.setReady(status.url)
    registry.fanout("cli:ready", status)
  })
  cli.on("status", (status) => {
    registry.fanout("cli:status", status)
    if (status.state !== "ready") {
      bootstrap.reset()
      backendUrl = null
      backendTargetUrl = null
      for (const record of registry.all()) void loadLoading(record, true)
    }
  })
  cli.on("error", (error) => registry.fanout("cli:error", { message: error.message }))

  app.whenReady().then(async () => {
    try { app.setAppUserModelId("ai.neuralnomads.codenomad.client") } catch {}
    if (isMac) {
      session.defaultSession.setSpellCheckerEnabled(false)
      configureMediaPermissionHandlers(getAllowedOrigins)
      if (app.dock) { const icon = nativeImage.createFromPath(getIconPath()); if (!icon.isEmpty()) app.dock.setIcon(icon) }
    }
    createApplicationMenu({
      getLocalTarget: () => {
        const focused = BrowserWindow.getFocusedWindow()
        const mru = registry.mruRecord()?.window ?? null
        return resolveFocusedLocalTarget(focused, mru, (window) => Boolean(registry.resolve(window.webContents)))
      },
      getWindowTarget: () => resolveWindowTarget(BrowserWindow.getFocusedWindow(), registry.mruRecord()?.window ?? null),
      newWindow: () => { void intentQueue.enqueue({ newWindow: true, folders: [] }).catch(() => {}) },
      reload: (window) => { const record = registry.resolve(window.webContents); if (record) void record.navigation.navigate((target) => target.webContents.reload()); else window.webContents.reload() },
      forceReload: (window) => { const record = registry.resolve(window.webContents); if (record) void record.navigation.navigate((target) => target.webContents.reloadIgnoringCache()); else window.webContents.reloadIgnoringCache() },
    })
    for (const id of clientState.windowIds) createWindow(id)
    registry.focus(clientState.activeWindowId)
    intentQueue.start()
    await firstLaunch.catch(() => {})
    void cli.start({ dev: !app.isPackaged }).catch((error) => registry.fanout("cli:error", { message: error instanceof Error ? error.message : String(error) }))
    app.on("activate", () => { if (registry.all().length === 0) void intentQueue.enqueue({ newWindow: false, folders: [] }).catch(() => {}) })
  })

  function getIconPath() {
    return app.isPackaged ? join(process.resourcesPath, "icon.png") : join(mainDirname, "../resources/icon.png")
  }
  function getPreloadPath() {
    const candidates = [join(process.resourcesPath, "preload/index.js"), join(mainDirname, "../preload/index.js"), join(mainDirname, "../preload/index.cjs"), join(mainDirname, "../../electron/preload/index.cjs"), join(app.getAppPath(), "electron/preload/index.cjs")]
    return candidates.find(existsSync) ?? candidates[0]
  }
  async function openRemoteWindow(payload: { id: string; name: string; baseUrl: string; entryUrl?: string; proxySessionId?: string; skipTlsVerify: boolean }) {
    const base = requireHttpUrl(payload.baseUrl, "baseUrl")
    const target = requireHttpUrl(payload.entryUrl ?? payload.baseUrl, "entryUrl")
    const title = `${payload.name} - ${payload.baseUrl}`
    const existing = remoteWindows.reuse(payload.id, payload.proxySessionId)
    if (existing) {
      const allowedOrigins = new Set([base.origin, target.origin])
      existing.setTitle(title)
      await navigateRemoteWindow(existing, target, allowedOrigins, remoteOrigins, insecureOrigins, payload.skipTlsVerify)
      return
    }
    const remoteSession = session.fromPartition(resolveRemoteSessionPartition(payload.id, payload.proxySessionId))
    const window = new BrowserWindow({
      width: 1400, height: 900, minWidth: 800, minHeight: 600, backgroundColor: "#1a1a1a", icon: getIconPath(), title,
      webPreferences: { session: remoteSession, preload: getPreloadPath(), contextIsolation: true, nodeIntegration: false, spellcheck: !isMac, additionalArguments: ["--codenomad-window-context=remote"] },
    })
    const allowedOrigins = new Set([base.origin, target.origin])
    remoteWindows.register(payload.id, window, payload.proxySessionId)
    if (isMac) configureMediaPermissionHandlers(() => BrowserWindow.getAllWindows()
      .filter((candidate) => candidate.webContents.session === remoteSession)
      .flatMap((candidate) => [...(remoteOrigins.get(candidate.id) ?? [])]), remoteSession)
    window.setTitle(title)
    window.webContents.on("page-title-updated", (event) => { event.preventDefault(); window.setTitle(title) })
    setupNavigationGuards(window, undefined, getAllowedOrigins, getLoadingUrl)
    lifecycle.attachRemote(window)
    window.on("closed", () => { remoteOrigins.delete(window.id); insecureOrigins.delete(window.webContents.id) })
    try { await navigateRemoteWindow(window, target, allowedOrigins, remoteOrigins, insecureOrigins, payload.skipTlsVerify) } catch (error) {
      console.warn("[electron] failed to load remote window; showing loading screen", error)
      const loading = loadingTarget()
      await (loading.url ? window.loadURL(loading.url) : window.loadFile(loading.file!))
    }
  }
}

function setupNavigationGuards(
  window: BrowserWindow,
  navigation: ClientStateNavigationController | undefined,
  allowedOrigins: (window: BrowserWindow) => string[],
  loadingUrl: () => string,
) {
  const external = (url: string) => shell.openExternal(url).catch((error) => console.error("[cli] failed to open external URL", url, error))
  const decide = (url: string) => decideNavigation(url, allowedOrigins(window), loadingUrl())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (decide(url) === "external") void external(url)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, url) => {
    const decision = decide(url)
    if (decision !== "allow") { event.preventDefault(); if (decision === "external") void external(url) }
    else if (navigation) { event.preventDefault(); void navigation.navigate((target) => target.loadURL(url)) }
  })
  window.webContents.on("will-redirect", (event, url) => {
    const decision = decide(url)
    if (decision !== "allow") { event.preventDefault(); if (decision === "external") void external(url) }
  })
}

function isIgnorableNavigationError(error: unknown): boolean {
  const text = error instanceof Error ? `${(error as Error & { code?: string }).code ?? ""} ${error.message}` : String(error)
  return text.includes("ERR_ABORTED") || text.includes("ERR_FAILED")
}

async function exchangeBootstrapToken(baseUrl: string, token: string, cli: CliProcessManager): Promise<boolean> {
  const target = new URL("/api/auth/token", baseUrl)
  const body = JSON.stringify({ token })
  const transport = target.protocol === "https:" ? https : http
  const result = await new Promise<{ status: number; cookie?: string }>((resolve, reject) => {
    const request = transport.request(target, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (response) => {
      response.resume()
      resolve({ status: response.statusCode ?? 0, cookie: response.headers["set-cookie"]?.[0] })
    })
    request.on("error", reject); request.end(body)
  })
  if (result.status !== 200 || !result.cookie) return false
  const first = result.cookie.split(";", 1)[0] ?? ""
  const separator = first.indexOf("=")
  if (first.slice(0, separator).trim() !== cli.getAuthCookieName()) return false
  await session.defaultSession.cookies.set({ url: baseUrl, name: cli.getAuthCookieName(), value: decodeURIComponent(first.slice(separator + 1).trim()), httpOnly: true, path: "/", sameSite: "lax" })
  return true
}

if (isMac) app.commandLine.appendSwitch("disable-spell-checking")
