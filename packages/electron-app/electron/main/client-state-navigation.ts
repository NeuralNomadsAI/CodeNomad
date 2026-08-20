import type { BrowserWindow } from "electron"
import type { ClientStateManager } from "./client-state"
import { flushRendererClientStateBeforeShutdown } from "./renderer-client-state-flush"

interface ClientStateNavigationDependencies {
  clientStateManager: Pick<ClientStateManager, "isPrimary">
  isTrustedOrigin(url: string): boolean
  reportFlushError(error: unknown): void
}

export class ClientStateNavigationController {
  private queue: Promise<void> = Promise.resolve()
  private generation = 0

  constructor(
    private readonly window: BrowserWindow,
    private readonly dependencies: ClientStateNavigationDependencies,
  ) {}

  navigate(operation: (window: BrowserWindow, generation: number) => void | Promise<void>): Promise<void> {
    const generation = ++this.generation
    const request = this.queue.catch(() => {}).then(() => this.performNavigation(operation, generation))
    this.queue = request
    return request
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation
  }

  private async performNavigation(
    operation: (window: BrowserWindow, generation: number) => void | Promise<void>,
    generation: number,
  ): Promise<void> {
    const { window } = this
    if (window.isDestroyed() || window.webContents.isDestroyed()) return

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
    await operation(window, generation)
  }
}

export function shouldResetRendererAccessTokenForNavigation(
  url: string,
  isInPlace: boolean,
  isMainFrame: boolean,
  isTrustedOrigin: (url: string) => boolean,
): boolean {
  return isMainFrame && !isInPlace && isTrustedOrigin(url)
}
