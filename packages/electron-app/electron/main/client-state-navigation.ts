import type { BrowserWindow } from "electron"
import type { ClientStateManager } from "./client-state"
import { flushRendererClientStateBeforeShutdown } from "./renderer-client-state-flush"
import { SerializedLifecycle } from "./serialized-lifecycle"

interface ClientStateNavigationDependencies {
  clientStateManager: Pick<ClientStateManager, "isPrimary">
  isTrustedOrigin(url: string): boolean
  reportFlushError(error: unknown): void
  lifecycle?: SerializedLifecycle
}

export class ClientStateNavigationController {
  private readonly lifecycle: SerializedLifecycle
  private generation = 0

  constructor(
    private readonly window: BrowserWindow,
    private readonly dependencies: ClientStateNavigationDependencies,
  ) {
    this.lifecycle = dependencies.lifecycle ?? new SerializedLifecycle()
  }

  navigate(operation: (window: BrowserWindow, generation: number) => void | Promise<void>): Promise<void> {
    const generation = ++this.generation
    if (this.lifecycle.stopped) return Promise.resolve()
    return this.lifecycle.enqueue(() => this.performNavigation(operation, generation))
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation
  }

  private async performNavigation(
    operation: (window: BrowserWindow, generation: number) => void | Promise<void>,
    generation: number,
  ): Promise<void> {
    const { window } = this
    if (this.lifecycle.stopped || window.isDestroyed() || window.webContents.isDestroyed()) return
    const flush = (phase: "navigation" | "navigation-cancel") => flushRendererClientStateBeforeShutdown(
      window,
      this.dependencies.clientStateManager.isPrimary,
      this.dependencies.isTrustedOrigin,
      undefined,
      phase,
      phase === "navigation-cancel",
    )
    const cancel = async () => { await flush("navigation-cancel").catch(this.dependencies.reportFlushError) }

    try {
      await flush("navigation")
    } catch (error) {
      this.dependencies.reportFlushError(error)
      await cancel()
      return
    }

    if (this.lifecycle.stopped || window.isDestroyed() || window.webContents.isDestroyed()) return cancel()
    try { await operation(window, generation) } catch (error) {
      await cancel()
      throw error
    }
    if (!this.isCurrent(generation)) await cancel()
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
