import type { App, BrowserWindow, Event } from "electron"
import type { ClientStateManager } from "./client-state"
import { MainWindowCloseController } from "./main-window-close"
import type { CliProcessManager } from "./process-manager"
import { flushRendererClientStateBeforeShutdown } from "./renderer-client-state-flush"
import type { WindowStateTracker } from "./window-state"

const WINDOWS_SESSION_END_FLUSH_TIMEOUT_MS = 1_500

interface ClientStateLifecycleDependencies {
  app: App
  clientStateManager: ClientStateManager
  cliManager: CliProcessManager
  getMainWindow(): BrowserWindow | null
  getAllWindows(): BrowserWindow[]
  getAllowedRendererOrigins(window?: BrowserWindow | null): string[]
  isTrustedRendererOrigin(url: string, allowedOrigins: string[]): boolean
  windowsSessionEndFlushTimeoutMs?: number
  rendererFlushTimeoutMs?: number
  isWindows?: boolean
}

export class ClientStateLifecycle {
  private shutdownStarted = false
  private shutdownExitAllowed = false
  private trackedMainWindow: BrowserWindow | null = null
  private windowStateTracker: WindowStateTracker | null = null
  private windowsSessionEndFlush: Promise<void> | null = null
  private windowsSessionEndExitAllowed = false

  constructor(private readonly dependencies: ClientStateLifecycleDependencies) {}

  attachMainWindow(window: BrowserWindow, windowStateTracker: WindowStateTracker | null): void {
    this.trackedMainWindow = window
    this.windowStateTracker = windowStateTracker

    const closeController = new MainWindowCloseController({
      flushRenderer: () => this.flushRenderer(window, "main-window close"),
      flushNative: () => this.flushNative(),
      closeWindow: () => window.close(),
      reportError: (stage, error) => {
        console.warn(`[client-state] ${stage} main-window close flush failed; continuing close`, error)
      },
    })

    window.on("close", (event) => {
      if (this.shutdownExitAllowed) return
      if (this.shutdownStarted) {
        event.preventDefault()
        return
      }

      const hasOtherWindow = this.dependencies
        .getAllWindows()
        .some((candidate) => candidate !== window && !candidate.isDestroyed())
      if (hasOtherWindow) {
        const decision = closeController.handleClose()
        if (!decision.allow) {
          event.preventDefault()
        }
        return
      }

      event.preventDefault()
      this.dependencies.app.quit()
    })

    if (this.dependencies.isWindows ?? process.platform === "win32") {
      window.on("query-session-end", (event: Event) => {
        if (this.windowsSessionEndExitAllowed) return
        event.preventDefault()
        this.startWindowsSessionEnd(window)
      })
      window.on("session-end", () => this.startWindowsSessionEnd(window))
    }
  }

  detachMainWindow(window: BrowserWindow): void {
    if (this.trackedMainWindow !== window) return
    this.trackedMainWindow = null
    this.windowStateTracker = null
  }

  registerAppEvents(): void {
    const { app } = this.dependencies
    app.on("before-quit", (event) => this.handleBeforeQuit(event))
    app.on("window-all-closed", () => {
      // Closing the final remaining window should quit the app on all platforms.
      app.quit()
    })
  }

  private async handleBeforeQuit(event: { preventDefault(): void }): Promise<void> {
    event.preventDefault()
    if (this.shutdownStarted) return
    this.shutdownStarted = true

    try {
      await this.flushRenderer(this.dependencies.getMainWindow(), "shutdown")
    } catch (error) {
      console.warn("[client-state] renderer shutdown flush failed; continuing shutdown", error)
    }

    try {
      await this.flushNative()
    } catch (error) {
      console.warn("[client-state] failed to flush state during shutdown", error)
    }

    try {
      await this.dependencies.clientStateManager.drainAndReleasePrimary()
    } catch (error) {
      console.warn("[client-state] failed to drain state before releasing primary ownership", error)
    }

    await this.dependencies.cliManager.stop().catch(() => {})
    this.shutdownExitAllowed = true
    this.dependencies.app.exit(0)
  }

  private async flushRenderer(window: BrowserWindow | null, context: "main-window close" | "shutdown"): Promise<void> {
    const result = await flushRendererClientStateBeforeShutdown(
      window,
      this.dependencies.clientStateManager.isPrimary,
      (url) =>
        this.dependencies.isTrustedRendererOrigin(url, this.dependencies.getAllowedRendererOrigins(window)),
      this.dependencies.rendererFlushTimeoutMs,
    )
    if (result === "untrusted-origin") {
      console.warn(`[client-state] skipped renderer ${context} flush for an untrusted origin`)
    }
  }

  private async flushNative(): Promise<void> {
    if (this.windowStateTracker) {
      await this.windowStateTracker.flush()
    } else {
      await this.dependencies.clientStateManager.flush()
    }
  }

  private flushForWindowsSessionEnd(window: BrowserWindow): Promise<void> {
    if (this.windowsSessionEndFlush) return this.windowsSessionEndFlush

    const flush = async () => {
      try {
        await this.flushRenderer(window, "shutdown")
      } catch (error) {
        console.warn("[client-state] Windows session-end renderer flush failed", error)
      }
      try {
        await this.flushNative()
      } catch (error) {
        console.warn("[client-state] Windows session-end native flush failed", error)
      }
      try {
        await this.dependencies.clientStateManager.drainAndReleasePrimary()
      } catch (error) {
        console.warn("[client-state] Windows session-end primary release failed", error)
      }
      try {
        await this.dependencies.cliManager.stop()
      } catch (error) {
        console.warn("[client-state] Windows session-end CLI stop failed", error)
      }
    }
    this.windowsSessionEndFlush = Promise.race([
      flush(),
      new Promise<void>((resolve) => setTimeout(
        resolve,
        this.dependencies.windowsSessionEndFlushTimeoutMs ?? WINDOWS_SESSION_END_FLUSH_TIMEOUT_MS,
      )),
    ])
    return this.windowsSessionEndFlush
  }

  private startWindowsSessionEnd(window: BrowserWindow): void {
    if (this.windowsSessionEndFlush) return
    void this.flushForWindowsSessionEnd(window).finally(() => {
      this.windowsSessionEndExitAllowed = true
      this.dependencies.app.exit(0)
    })
  }
}
