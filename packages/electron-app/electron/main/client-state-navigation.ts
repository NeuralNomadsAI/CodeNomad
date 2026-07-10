import type { BrowserWindow } from "electron"
import type { ClientStateManager } from "./client-state"
import { flushRendererClientStateBeforeShutdown } from "./renderer-client-state-flush"

interface ClientStateNavigationDependencies {
  clientStateManager: Pick<ClientStateManager, "isPrimary">
  getWindow(): BrowserWindow | null
  isTrustedOrigin(url: string): boolean
  reportFlushError(error: unknown): void
}

export class ClientStateNavigationController {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly dependencies: ClientStateNavigationDependencies) {}

  navigate(operation: (window: BrowserWindow) => void | Promise<void>): Promise<void> {
    const request = this.queue.catch(() => {}).then(() => this.performNavigation(operation))
    this.queue = request
    return request
  }

  private async performNavigation(operation: (window: BrowserWindow) => void | Promise<void>): Promise<void> {
    const window = this.dependencies.getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return

    try {
      await flushRendererClientStateBeforeShutdown(
        window,
        this.dependencies.clientStateManager.isPrimary,
        this.dependencies.isTrustedOrigin,
      )
    } catch (error) {
      this.dependencies.reportFlushError(error)
    }

    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    await operation(window)
  }
}
