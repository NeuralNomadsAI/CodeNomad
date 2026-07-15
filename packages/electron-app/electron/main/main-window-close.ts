export interface MainWindowCloseHooks {
  flushRenderer(): Promise<void>
  flushNative(): Promise<void>
  closeWindow(): void
  reportError(stage: "renderer" | "native" | "close", error: unknown): void
}

export interface MainWindowCloseDecision {
  allow: boolean
  completion?: Promise<void>
}

export class MainWindowCloseController {
  private closeApproved = false
  private closeInProgress = false
  private completion: Promise<void> | undefined

  constructor(private readonly hooks: MainWindowCloseHooks) {}

  handleClose(): MainWindowCloseDecision {
    if (this.closeApproved) {
      return { allow: true }
    }
    if (!this.closeInProgress) {
      this.closeInProgress = true
      this.completion = this.flushAndClose()
    }
    return { allow: false, completion: this.completion }
  }

  private async flushAndClose(): Promise<void> {
    try {
      await this.hooks.flushRenderer()
    } catch (error) {
      this.hooks.reportError("renderer", error)
    }

    try {
      await this.hooks.flushNative()
    } catch (error) {
      this.hooks.reportError("native", error)
    }

    this.closeApproved = true
    try {
      this.hooks.closeWindow()
    } catch (error) {
      this.closeApproved = false
      this.closeInProgress = false
      this.completion = undefined
      this.hooks.reportError("close", error)
    }
  }
}
