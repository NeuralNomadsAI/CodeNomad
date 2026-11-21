import type { App, BrowserWindow } from "electron"
import type { ClientStateManager } from "./client-state"
import type { CliProcessManager } from "./process-manager"
import { flushRendererClientStateBeforeShutdown } from "./renderer-client-state-flush"
import type { SerializedLifecycle } from "./serialized-lifecycle"
import type { WindowStateTracker } from "./window-state"

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
  removeWindowState(id: string): Promise<boolean>
  getAllowedRendererOrigins(window: BrowserWindow): string[]
  isTrustedRendererOrigin(url: string, allowedOrigins: string[]): boolean
  rendererFlushTimeoutMs?: number
  sessionEndCleanupTimeoutMs?: number
  isWindows?: boolean
  navigationLifecycle?: SerializedLifecycle
}

export class MultiwindowLifecycle {
  private shutdown: Promise<void> | null = null
  private sessionEnd: Promise<void> | null = null
  private sessionEndPreparation: Promise<void> | null = null
  private sessionEndPreparationPending = false
  private release: Promise<void> | null = null
  private exitAllowed = false
  private relaunchRequested = false
  private readonly sessionEndWindows = new WeakSet<BrowserWindow>()
  private readonly pendingWindowCloses = new Set<BrowserWindow>()

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
        // A hidden launch window holds no user state: dispose it even when its renderer never started.
        const launch = this.dependencies.isLaunchWindow?.(record.window)
        const remote = this.dependencies.isRemoteWindow?.(record.window) === true
        if (!launch && !remote) await this.flushWindow(record, "prepare")
        // The last local window keeps its saved state beside remote windows, as when it quits CodeNomad:
        // the next local window (New Window, a later launch or the next start) reopens it.
        if (record.persisted !== false && this.hasOtherLocalWindow(record.id)
          && !await this.dependencies.removeWindowState(record.id)) {
          this.resumeCapture(record.window)
          closing = false
          this.pendingWindowCloses.delete(record.window)
          return
        }
        if (!launch) await this.run("workspace release", () => this.flushRenderer(record.window, remote ? true : "release"))
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

  attachSessionEnd(window: BrowserWindow): void {
    if (!(this.dependencies.isWindows ?? process.platform === "win32") || this.sessionEndWindows.has(window)) return
    this.sessionEndWindows.add(window)
    window.on("query-session-end", () => this.prepareSessionEnd())
    window.on("session-end", () => this.startSessionEnd())
  }

  registerAppEvents(): void {
    this.dependencies.app.on("before-quit", (event) => {
      if (this.exitAllowed) return
      event.preventDefault()
      const visibleWindows = this.dependencies.getAllWindows().filter((window) => !window.isDestroyed() && window.isVisible())
      for (const window of visibleWindows) window.hide()
      void this.startShutdown().then(() => this.exit(), (error) => {
        this.relaunchRequested = false
        this.pendingWindowCloses.clear()
        for (const window of visibleWindows) if (!window.isDestroyed()) {
          if (!this.dependencies.isSupportWindow?.(window)) this.resumeCapture(window)
          window.show()
        }
        console.warn("[client-state] shutdown remains pending", error)
      })
    })
    this.dependencies.app.on("window-all-closed", () => this.dependencies.app.quit())
  }

  requestRelaunch(): void {
    if (this.exitAllowed) return
    this.relaunchRequested = true
    this.dependencies.app.quit()
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
      if (preparedFlush) await preparedFlush
      await this.flushApplicationWindows(true)
      await this.run("aggregate state flush", () => this.dependencies.clientStateManager.flush())
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

  private flushApplicationWindows(closing = false): Promise<void> {
    // A hidden launch window holds no state to preserve, and its pending connection ends with the app.
    return Promise.all([
      ...this.dependencies.getLocalWindows()
        .filter((record) => !this.dependencies.isLaunchWindow?.(record.window))
        .map((record) => this.flushWindow(record, closing)),
      ...(closing ? this.dependencies.getAllWindows()
        .filter(window => this.dependencies.isRemoteWindow?.(window) && !this.dependencies.isLaunchWindow?.(window))
        .map(window => this.flushWindow({ id: "", window, tracker: null }, true)) : []),
      this.dependencies.flushSupportWindows?.(),
    ]).then(() => undefined)
  }

  private prepareSessionEnd(): void {
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
    const timeoutMs = this.dependencies.sessionEndCleanupTimeoutMs ?? 5_000
    const cleanup = this.shutdown ?? this.startShutdown(this.sessionEndPreparation ?? undefined)
    this.sessionEnd = Promise.race([
      cleanup,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]).catch((error) => {
      console.warn("[client-state] OS session-end shutdown failed; exiting at the fail-open boundary", error)
    }).then(() => this.exit())
  }

  private flushRenderer(window: BrowserWindow, closing: boolean | "cancel" | "prepare" | "release") {
    const remote = this.dependencies.isRemoteWindow?.(window) === true
    return flushRendererClientStateBeforeShutdown(
      window,
      Boolean(closing) || remote || this.dependencies.clientStateManager.isPrimary,
      (url) => this.dependencies.isTrustedRendererOrigin(url, this.dependencies.getAllowedRendererOrigins(window)),
      this.dependencies.rendererFlushTimeoutMs,
      closing,
      remote || !this.dependencies.clientStateManager.isPrimary,
    )
  }

  private async flushWindow(record: LifecycleWindow, closing: boolean | "prepare"): Promise<void> {
    const flush = () => this.flushRenderer(record.window, closing)
    if (this.dependencies.isRemoteWindow?.(record.window)) await this.run("remote window flush", flush)
    else await flush()
    if (record.tracker) await this.run("native window flush", () => record.tracker!.flush())
  }

  private resumeCapture(window: BrowserWindow): void {
    void this.run("renderer resume", () => this.flushRenderer(window, "cancel"))
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
    if (this.relaunchRequested) this.dependencies.app.relaunch()
    this.dependencies.app.exit(0)
  }
}
