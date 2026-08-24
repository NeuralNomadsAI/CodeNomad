import type { App, BrowserWindow } from "electron"
import type { ClientStateManager } from "./client-state"
import type { CliProcessManager } from "./process-manager"
import { flushRendererClientStateBeforeShutdown } from "./renderer-client-state-flush"
import type { WindowStateTracker } from "./window-state"

interface ClientStateLifecycleDependencies {
  app: App
  clientStateManager: ClientStateManager
  cliManager: CliProcessManager
  getMainWindow(): BrowserWindow | null
  getAllWindows(): BrowserWindow[]
  getAllowedRendererOrigins(window?: BrowserWindow | null): string[]
  isTrustedRendererOrigin(url: string, allowedOrigins: string[]): boolean
  rendererFlushTimeoutMs?: number
  sessionEndCleanupTimeoutMs?: number
  sessionEndReleaseTimeoutMs?: number
  isWindows?: boolean
}

export class ClientStateLifecycle {
  private shutdown: Promise<void> | null = null
  private sessionEnd: Promise<void> | null = null
  private exitAllowed = false
  private trackedMainWindow: BrowserWindow | null = null
  private windowStateTracker: WindowStateTracker | null = null
  private windowsHiddenForShutdown = false
  private primaryRelease: Promise<void> | null = null

  constructor(private readonly dependencies: ClientStateLifecycleDependencies) {}

  attachMainWindow(window: BrowserWindow, tracker: WindowStateTracker | null): void {
    this.trackedMainWindow = window
    this.windowStateTracker = tracker
    let closeApproved = false
    let closeInProgress = false

    window.on("close", (event) => {
      if (this.exitAllowed || closeApproved) return
      event.preventDefault()
      if (this.shutdown) return

      const hasOtherWindow = this.dependencies
        .getAllWindows()
        .some((candidate) => candidate !== window && !candidate.isDestroyed())
      if (!hasOtherWindow) {
        window.hide()
        this.dependencies.app.quit()
      } else if (!closeInProgress) {
        closeInProgress = true
        void this.flushForClose(window).finally(() => {
          closeApproved = true
          try {
            window.close()
          } catch (error) {
            closeApproved = false
            closeInProgress = false
            console.warn("[client-state] main-window close failed", error)
          }
        })
      }
    })

    if (this.dependencies.isWindows ?? process.platform === "win32") {
      window.on("query-session-end", (event) => {
        if (this.exitAllowed) return
        event.preventDefault()
        this.promoteToSessionEnd(window)
      })
      window.on("session-end", () => this.promoteToSessionEnd(window))
    }
  }

  detachMainWindow(window: BrowserWindow): void {
    if (this.trackedMainWindow !== window) return
    this.trackedMainWindow = null
    this.windowStateTracker = null
  }

  registerAppEvents(): void {
    const { app } = this.dependencies
    app.on("before-quit", (event) => {
      if (this.exitAllowed) return
      event.preventDefault()
      this.hideWindows()
      void this.startShutdown(this.dependencies.getMainWindow()).then(() => this.exit(), (error) => {
        if (!this.sessionEnd) this.restoreWindowAfterRejectedShutdown(this.dependencies.getMainWindow())
        console.warn("[client-state] desktop shutdown remains pending because cleanup was not contained", error)
      })
    })
    app.on("window-all-closed", () => app.quit())
  }

  private async flushForClose(window: BrowserWindow): Promise<void> {
    await this.runStage("renderer main-window close flush", () => this.flushRenderer(window))
    await this.runStage("native main-window close flush", () => this.flushNative())
  }

  private startShutdown(window: BrowserWindow | null): Promise<void> {
    if (this.shutdown) return this.shutdown
    const stages = (async () => {
      await this.runStage("renderer shutdown flush", () => this.flushRenderer(window))
      await this.runStage("native shutdown flush", () => this.flushNative())
      await this.dependencies.cliManager.shutdown()
      await this.releasePrimary()
    })()
    this.shutdown = stages.catch((error) => {
      this.shutdown = null
      throw error
    })
    return this.shutdown
  }

  private hideWindows(): void {
    for (const window of this.dependencies.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.hide()
        this.windowsHiddenForShutdown = true
      }
    }
  }

  private restoreWindowAfterRejectedShutdown(preferred: BrowserWindow | null): void {
    if (!this.windowsHiddenForShutdown) return
    this.windowsHiddenForShutdown = false
    const window = preferred && !preferred.isDestroyed()
      ? preferred
      : this.dependencies.getAllWindows().find((candidate) => !candidate.isDestroyed())
    if (window) window.show()
  }

  private promoteToSessionEnd(window: BrowserWindow): void {
    if (this.exitAllowed || this.sessionEnd) return
    const cleanup = this.startShutdown(window)
    this.sessionEnd = new Promise<void>((resolve) => {
      const timeoutMs = this.dependencies.sessionEndCleanupTimeoutMs ?? 5_000
      const releaseTimeoutMs = Math.min(timeoutMs, this.dependencies.sessionEndReleaseTimeoutMs ?? 250)
      const releaseTimer = setTimeout(() => {
        void this.releasePrimary()
      }, Math.max(0, timeoutMs - releaseTimeoutMs))
      const exitTimer = setTimeout(() => {
        console.warn(`[client-state] OS session-end cleanup exceeded ${timeoutMs}ms; exiting without containment`)
        resolve()
      }, timeoutMs)
      void cleanup.then(() => {
        clearTimeout(releaseTimer)
        clearTimeout(exitTimer)
        resolve()
      }, (error) => {
        console.warn("[client-state] OS session-end cleanup was not contained; waiting for forced exit", error)
      })
    }).then(() => this.exit())
  }

  private releasePrimary(): Promise<void> {
    if (!this.primaryRelease) {
      this.primaryRelease = this.runStage("primary release", () => this.dependencies.clientStateManager.drainAndReleasePrimary())
    }
    return this.primaryRelease
  }

  private async flushRenderer(window: BrowserWindow | null): Promise<void> {
    const result = await flushRendererClientStateBeforeShutdown(
      window,
      this.dependencies.clientStateManager.isPrimary,
      (url) => this.dependencies.isTrustedRendererOrigin(url, this.dependencies.getAllowedRendererOrigins(window)),
      this.dependencies.rendererFlushTimeoutMs,
    )
    if (result === "untrusted-origin") {
      console.warn("[client-state] skipped renderer flush for an untrusted origin")
    }
  }

  private async flushNative(): Promise<void> {
    if (this.windowStateTracker) await this.windowStateTracker.flush()
    else await this.dependencies.clientStateManager.flush()
  }

  private async runStage(name: string, operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation()
    } catch (error) {
      console.warn(`[client-state] ${name} failed; continuing`, error)
    }
  }

  private exit(): void {
    if (this.exitAllowed) return
    this.exitAllowed = true
    this.dependencies.app.exit(0)
  }
}
