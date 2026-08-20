import type { App, BrowserWindow } from "electron"
import type { ClientStateManager } from "./client-state"
import type { CliProcessManager } from "./process-manager"
import { flushRendererClientStateBeforeShutdown } from "./renderer-client-state-flush"
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
  removeWindowState(id: string): Promise<unknown>
  getAllowedRendererOrigins(window: BrowserWindow): string[]
  isTrustedRendererOrigin(url: string, allowedOrigins: string[]): boolean
  rendererFlushTimeoutMs?: number
  sessionEndCleanupTimeoutMs?: number
  isWindows?: boolean
}

export class MultiwindowLifecycle {
  private shutdown: Promise<void> | null = null
  private sessionEnd: Promise<void> | null = null
  private sessionEndPreparation: Promise<void> | null = null
  private sessionEndPreparationPending = false
  private release: Promise<void> | null = null
  private exitAllowed = false
  private readonly sessionEndWindows = new WeakSet<BrowserWindow>()

  constructor(private readonly dependencies: Dependencies) {}

  attach(record: LifecycleWindow): void {
    let approved = false
    let closing = false
    record.window.on("close", (event) => {
      if (approved || this.exitAllowed) return
      event.preventDefault()
      if (closing || this.shutdown) return
      const otherLocal = this.dependencies.getLocalWindows().some((candidate) => candidate.id !== record.id && !candidate.window.isDestroyed())
      const otherWindow = this.dependencies.getAllWindows().some((candidate) => candidate !== record.window && !candidate.isDestroyed())
      if (!otherLocal && !otherWindow) {
        record.window.hide()
        this.dependencies.app.quit()
        return
      }
      closing = true
      void this.flushWindow(record).then(async () => {
        if (record.persisted !== false) await this.run("remove closed window state", () => this.dependencies.removeWindowState(record.id))
        approved = true
        record.window.close()
      }).catch((error) => {
        closing = false
        console.warn("[client-state] local window close failed", error)
      })
    })

    this.attachSessionEnd(record.window)
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
      for (const window of this.dependencies.getAllWindows()) if (!window.isDestroyed()) window.hide()
      void this.startShutdown().then(() => this.exit(), (error) => console.warn("[client-state] shutdown remains pending", error))
    })
    this.dependencies.app.on("window-all-closed", () => this.dependencies.app.quit())
  }

  private startShutdown(preparedFlush?: Promise<void>): Promise<void> {
    if (this.shutdown) return this.shutdown
    this.shutdown = (async () => {
      await (preparedFlush ?? this.flushLocalWindows())
      await this.run("aggregate state flush", () => this.dependencies.clientStateManager.flush())
      await this.dependencies.cliManager.shutdown()
      await this.releasePrimary()
    })()
    return this.shutdown
  }

  private flushLocalWindows(): Promise<void> {
    return Promise.all(this.dependencies.getLocalWindows().map((record) => this.flushWindow(record))).then(() => undefined)
  }

  private prepareSessionEnd(): void {
    if (this.exitAllowed || this.sessionEnd || this.shutdown || this.sessionEndPreparationPending) return
    this.sessionEndPreparationPending = true
    const preparation = this.flushLocalWindows()
    this.sessionEndPreparation = preparation
    void preparation.finally(() => {
      if (this.sessionEndPreparation === preparation) this.sessionEndPreparationPending = false
    })
  }

  private startSessionEnd(): void {
    if (this.exitAllowed || this.sessionEnd) return
    const timeoutMs = this.dependencies.sessionEndCleanupTimeoutMs ?? 5_000
    const cleanup = this.shutdown ?? this.startShutdown(this.sessionEndPreparation ?? this.flushLocalWindows())
    this.sessionEnd = Promise.race([
      cleanup,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]).catch((error) => {
      console.warn("[client-state] OS session-end shutdown failed; exiting at the fail-open boundary", error)
    }).then(() => this.exit())
  }

  private async flushWindow(record: LifecycleWindow): Promise<void> {
    await this.run("renderer window flush", async () => {
      await flushRendererClientStateBeforeShutdown(
        record.window,
        this.dependencies.clientStateManager.isPrimary,
        (url) => this.dependencies.isTrustedRendererOrigin(url, this.dependencies.getAllowedRendererOrigins(record.window)),
        this.dependencies.rendererFlushTimeoutMs,
      )
    })
    if (record.tracker) await this.run("native window flush", () => record.tracker!.flush())
  }

  private releasePrimary(): Promise<void> {
    this.release ??= this.run("primary release", () => this.dependencies.clientStateManager.drainAndReleasePrimary())
    return this.release
  }

  private async run(name: string, operation: () => Promise<unknown>): Promise<void> {
    try { await operation() } catch (error) { console.warn(`[client-state] ${name} failed; continuing`, error) }
  }

  private exit(): void {
    if (this.exitAllowed) return
    this.exitAllowed = true
    this.dependencies.app.exit(0)
  }
}
