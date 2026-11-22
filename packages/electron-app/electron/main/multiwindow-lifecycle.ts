import type { App, BrowserWindow } from "electron"
import type { ClientStateManager } from "./client-state"
import type { CliProcessManager } from "./process-manager"
import { flushRendererClientStateBeforeShutdown } from "./renderer-client-state-flush"
import type { SerializedLifecycle } from "./serialized-lifecycle"
import type { WindowStateTracker } from "./window-state"

// Durable snapshot publication can outlast the best-effort release budget.
const CLOSE_CAPTURE_TIMEOUT_MS = 5_000

export interface LifecycleWindow {
  id: string
  persisted?: boolean
  window: BrowserWindow
  tracker: WindowStateTracker | null
}

interface Dependencies {
  app: App
  clientStateManager: ClientStateManager
  cliManager: CliProcessManager
  getLocalWindows(): LifecycleWindow[]
  getAllWindows(): BrowserWindow[]
  isRemoteWindow?(window: BrowserWindow): boolean
  isSupportWindow?(window: BrowserWindow): boolean
  /** Hidden windows a `--connect-server` launch owns: they never keep CodeNomad alive. */
  isLaunchWindow?(window: BrowserWindow): boolean
  flushSupportWindows?(): Promise<void>
  stopSpeech?(): Promise<void>
  removeWindowState(id: string): Promise<boolean>
  getAllowedRendererOrigins(window: BrowserWindow): string[]
  isTrustedRendererOrigin(url: string, allowedOrigins: string[]): boolean
  rendererFlushTimeoutMs?: number
  sessionEndCleanupTimeoutMs?: number
  isWindows?: boolean
  navigationLifecycle?: SerializedLifecycle
  defaultRelaunchOptions?: Electron.RelaunchOptions
}

export class MultiwindowLifecycle {
  private shutdown: Promise<void> | null = null
  private sessionEnd: Promise<void> | null = null
  private sessionEndQueried = false
  private scopeRelaunchGeneration = 0
  private sessionEndPreparation: Promise<void> | null = null
  private sessionEndPreparationPending = false
  private release: Promise<void> | null = null
  private exitAllowed = false
  private relaunchRequested: Electron.RelaunchOptions | true | undefined
  private readonly sessionEndWindows = new WeakSet<BrowserWindow>()
  private readonly pendingWindowCloses = new Set<BrowserWindow>()
  private readonly windowCloseDecisions = new Map<BrowserWindow, Promise<void>>()
  private readonly approvedWindowCloses = new WeakSet<BrowserWindow>()
  private readonly windowReleases = new Map<BrowserWindow, Promise<void>>()

  constructor(private readonly dependencies: Dependencies) {}

  attach(record: LifecycleWindow): void {
    let approved = false
    let closing = false
    record.window.on("closed", () => this.pendingWindowCloses.delete(record.window))
    record.window.on("close", (event) => {
      if (approved || this.exitAllowed) return
      event.preventDefault()
      if (closing || this.shutdown) return
      closing = true
      this.pendingWindowCloses.add(record.window)
      void (async () => {
        // Closing the last window quits CodeNomad, Remote Control included; it
        // resumes at the next launch.
        if (!this.hasOtherApplicationWindow(record.window, record.id)) {
          closing = false
          this.pendingWindowCloses.delete(record.window)
          this.dependencies.app.quit()
          return
        }
        let settle!: () => void
        this.windowCloseDecisions.set(record.window, new Promise<void>(resolve => { settle = resolve }))
        let launch: boolean | undefined
        try {
          // A hidden launch window holds no user state: dispose it even when its renderer never started.
          launch = this.dependencies.isLaunchWindow?.(record.window)
          if (!launch && !this.dependencies.isRemoteWindow?.(record.window)) await this.flushWindow(record, "prepare")
          if (this.shutdown) return
          // The last local window keeps its saved state beside remote windows.
          if (record.persisted !== false && this.hasOtherLocalWindow(record.id)) {
            if (!await this.dependencies.removeWindowState(record.id)) {
              this.resumeCapture(record.window)
              return
            }
            record.tracker?.disarm()
          }
          this.approvedWindowCloses.add(record.window)
        } catch (error) {
          this.resumeCapture(record.window)
          console.warn("[client-state] local window close failed", error)
          return
        } finally {
          if (!this.approvedWindowCloses.has(record.window)) {
            closing = false
            this.pendingWindowCloses.delete(record.window)
          }
          this.windowCloseDecisions.delete(record.window)
          settle()
        }
        if (!launch) await this.releaseWorkspaces(record.window)
        approved = true
        record.window.close()
      })().catch((error) => {
        this.resumeCapture(record.window)
        closing = false
        this.pendingWindowCloses.delete(record.window)
        console.warn("[client-state] local window close failed", error)
      })
    })

    this.attachSessionEnd(record.window)
  }

  attachSupportWindow(window: BrowserWindow): void {
    window.on("close", (event) => {
      if (event.defaultPrevented || this.exitAllowed || this.dependencies.getAllWindows().some((candidate) => candidate !== window
        && !candidate.isDestroyed() && !this.dependencies.isSupportWindow?.(candidate) && !this.dependencies.isLaunchWindow?.(candidate))) return
      event.preventDefault()
      if (!this.shutdown) this.dependencies.app.quit()
    })
    this.attachSessionEnd(window)
  }

  isExitAllowed(): boolean {
    return this.exitAllowed
  }

  isWindowClosing(window: BrowserWindow): boolean {
    return this.pendingWindowCloses.has(window)
  }

  attachSessionEnd(window: BrowserWindow): void {
    if (!(this.dependencies.isWindows ?? process.platform === "win32") || this.sessionEndWindows.has(window)) return
    this.sessionEndWindows.add(window)
    window.on("query-session-end", () => this.prepareSessionEnd())
    window.on("session-end", () => this.startSessionEnd())
    // Electron emits session-end only for a positive WM_ENDSESSION.
    window.hookWindowMessage?.(0x0016, wParam => {
      if (wParam.length >= 4 && wParam.readUInt32LE() === 0 && !this.sessionEnd) this.sessionEndQueried = false
    })
  }

  registerAppEvents(): void {
    this.dependencies.app.on("before-quit", (event) => {
      if (this.exitAllowed) return
      event.preventDefault()
      if (this.sessionEnd) return
      const visibleWindows = this.dependencies.getAllWindows().filter((window) => !window.isDestroyed() && window.isVisible())
      for (const window of visibleWindows) window.hide()
      void this.startShutdown().then(() => {
        if (!this.sessionEnd) this.exit()
      }, (error) => {
        if (this.sessionEnd) return
        this.relaunchRequested = undefined
        for (const window of this.dependencies.getAllWindows()) if (!window.isDestroyed() && !this.approvedWindowCloses.has(window)) {
          if (this.needsShutdownFlush(window) && !this.dependencies.isSupportWindow?.(window)) this.resumeCapture(window)
          if (visibleWindows.includes(window)) window.show()
        }
        console.warn("[client-state] shutdown remains pending", error)
      })
    })
    this.dependencies.app.on("window-all-closed", () => this.dependencies.app.quit())
  }

  relaunchScopeGeneration(): number | undefined {
    if (!this.sessionEndQueried && this.canRelaunch()) return this.scopeRelaunchGeneration
  }

  requestRelaunch(options?: Electron.RelaunchOptions): void {
    if (options ? this.relaunchScopeGeneration() === undefined : !this.canRelaunch()) return
    this.relaunchRequested = options ?? true
    this.dependencies.app.quit()
  }

  private canRelaunch(): boolean {
    return !this.exitAllowed && !this.shutdown && !this.sessionEnd && !this.relaunchRequested
  }

  private hasOtherLocalWindow(localId: string): boolean {
    return this.dependencies.getLocalWindows().some((candidate) => candidate.id !== localId
      && !candidate.window.isDestroyed() && !this.pendingWindowCloses.has(candidate.window)
      && !(this.dependencies.isLaunchWindow?.(candidate.window) ?? false))
  }

  private hasOtherApplicationWindow(window: BrowserWindow, localId: string): boolean {
    const isLaunchWindow = (candidate: BrowserWindow) => this.dependencies.isLaunchWindow?.(candidate) ?? false
    return this.hasOtherLocalWindow(localId)
      || this.dependencies.getAllWindows().some((candidate) => candidate !== window
        && !candidate.isDestroyed() && !this.pendingWindowCloses.has(candidate)
        && !this.dependencies.isSupportWindow?.(candidate) && !isLaunchWindow(candidate))
  }

  private startShutdown(preparedFlush?: Promise<void>): Promise<void> {
    if (this.shutdown) return this.shutdown
    const cleanup = async () => {
      const speech = this.dependencies.stopSpeech?.()
      if (preparedFlush) await preparedFlush
      await this.flushApplicationWindows("prepare")
      await this.run("aggregate state flush", () => this.dependencies.clientStateManager.flush())
      await Promise.all([
        ...this.windowReleases.values(),
        ...[
          ...this.dependencies.getLocalWindows().map(record => record.window),
          ...this.dependencies.getAllWindows().filter(window => this.dependencies.isRemoteWindow?.(window)),
        ].filter(window => this.needsShutdownFlush(window)).map(window => this.releaseWorkspaces(window)),
      ])
      await speech
      await this.dependencies.cliManager.shutdown()
      try {
        await this.releasePrimary()
      } catch (error) {
        await this.run("CLI recovery", () => this.dependencies.cliManager.recoverAfterFailedShutdown({
          dev: process.env.NODE_ENV === "development",
        }))
        throw error
      }
    }
    const shutdown = this.dependencies.navigationLifecycle?.stop(cleanup) ?? cleanup()
    this.shutdown = shutdown
    void shutdown.catch(() => {
      if (this.shutdown === shutdown) this.shutdown = null
    })
    return shutdown
  }

  private async flushApplicationWindows(closing: false | "prepare" = false): Promise<void> {
    await Promise.all(this.windowCloseDecisions.values())
    // A hidden launch window holds no state to preserve, and its pending connection ends with the app.
    await Promise.all([
      ...this.dependencies.getLocalWindows()
        .filter((record) => this.needsShutdownFlush(record.window))
        .map((record) => this.flushWindow(record, closing)),
      ...(closing ? this.dependencies.getAllWindows()
        .filter(window => this.dependencies.isRemoteWindow?.(window) && this.needsShutdownFlush(window))
        .map(window => this.flushWindow({ id: "", window, tracker: null }, closing)) : []),
      this.dependencies.flushSupportWindows?.(),
    ])
  }

  private prepareSessionEnd(): void {
    if (!this.sessionEndQueried) this.scopeRelaunchGeneration++
    this.sessionEndQueried = true
    // Revoke a scoped relaunch even if its cleanup is already in flight.
    if (this.relaunchRequested !== true) this.relaunchRequested = undefined
    if (this.exitAllowed || this.sessionEnd || this.shutdown || this.sessionEndPreparationPending) return
    this.sessionEndPreparationPending = true
    const preparation = this.flushApplicationWindows()
    this.sessionEndPreparation = preparation
    void preparation.finally(() => {
      if (this.sessionEndPreparation === preparation) this.sessionEndPreparationPending = false
    })
  }

  private startSessionEnd(): void {
    if (this.exitAllowed || this.sessionEnd) return
    this.relaunchRequested = undefined
    const timeoutMs = this.dependencies.sessionEndCleanupTimeoutMs ?? 5_000
    const cleanup = this.shutdown ?? this.startShutdown(this.sessionEndPreparation ?? undefined)
    this.sessionEnd = Promise.race([
      cleanup,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]).catch((error) => {
      console.warn("[client-state] OS session-end shutdown failed; exiting at the fail-open boundary", error)
    }).then(() => this.exit())
  }

  private flushRenderer(window: BrowserWindow, closing: false | "cancel" | "prepare" | "release") {
    const remote = this.dependencies.isRemoteWindow?.(window) === true
    return flushRendererClientStateBeforeShutdown(
      window,
      Boolean(closing) || remote || this.dependencies.clientStateManager.isPrimary,
      (url) => this.dependencies.isTrustedRendererOrigin(url, this.dependencies.getAllowedRendererOrigins(window)),
      this.dependencies.rendererFlushTimeoutMs ?? (closing === "prepare" && !remote ? CLOSE_CAPTURE_TIMEOUT_MS : undefined),
      closing,
      remote || !this.dependencies.clientStateManager.isPrimary,
    )
  }

  private async flushWindow(record: LifecycleWindow, closing: false | "prepare"): Promise<void> {
    const flush = () => this.flushRenderer(record.window, closing)
    if (this.dependencies.isRemoteWindow?.(record.window)) await this.run("remote window flush", flush)
    else await flush()
    if (record.tracker) await this.run("native window flush", () => record.tracker!.flush())
  }

  private resumeCapture(window: BrowserWindow): void {
    void this.run("renderer resume", () => this.flushRenderer(window, "cancel"))
  }

  private needsShutdownFlush(window: BrowserWindow): boolean {
    return !this.approvedWindowCloses.has(window) && !this.dependencies.isLaunchWindow?.(window)
  }

  private releaseWorkspaces(window: BrowserWindow): Promise<void> {
    const pending = this.windowReleases.get(window)
    if (pending) return pending
    const release = this.run("workspace release", () => this.flushRenderer(window, "release"))
      .finally(() => this.windowReleases.delete(window))
    this.windowReleases.set(window, release)
    return release
  }

  private releasePrimary(): Promise<void> {
    if (this.release) return this.release
    const release = this.dependencies.clientStateManager.drainAndReleasePrimary()
    this.release = release
    void release.catch(() => {
      if (this.release === release) this.release = null
    })
    return release
  }

  private async run(name: string, operation: () => Promise<unknown>): Promise<void> {
    try { await operation() } catch (error) { console.warn(`[client-state] ${name} failed; continuing`, error) }
  }

  private exit(): void {
    if (this.exitAllowed) return
    this.exitAllowed = true
    const options = this.relaunchRequested === true ? this.dependencies.defaultRelaunchOptions : this.relaunchRequested
    if (options) this.dependencies.app.relaunch(options)
    else if (this.relaunchRequested === true) this.dependencies.app.relaunch()
    this.dependencies.app.exit(0)
  }
}
