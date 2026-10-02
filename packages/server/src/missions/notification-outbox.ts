import type { MissionNotificationRetryResult } from "./control"

const cursorRegistryKey = Symbol.for("codenomad.missions.notification-cursors.v1")
const host = globalThis as typeof globalThis & { [cursorRegistryKey]?: Map<string, string> }
const cursors = host[cursorRegistryKey] ??= new Map<string, string>()
const MAX_CURSOR_SCOPES = 128

function rememberCursor(scope: string, cursor: string): void {
  cursors.delete(scope)
  cursors.set(scope, cursor)
  while (cursors.size > MAX_CURSOR_SCOPES) cursors.delete(cursors.keys().next().value!)
}

const DEFAULT_RETRY_DELAY_MS = 5_000
const MAX_RETRY_DELAY_MS = 30_000

export class MissionNotificationOutbox {
  private active = true
  private running = false
  private timer?: ReturnType<typeof setTimeout>
  private consecutiveFailures = 0

  constructor(
    private readonly scope: string,
    private readonly retry: (isActive: () => boolean, after?: string) => Promise<MissionNotificationRetryResult>,
    private readonly retryDelay = DEFAULT_RETRY_DELAY_MS,
    private readonly maxRetryDelay = MAX_RETRY_DELAY_MS,
  ) {}

  start(): void {
    if (this.active) void this.run()
  }

  dispose(): void {
    this.active = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private async run(): Promise<void> {
    if (!this.active || this.running) return
    this.running = true
    let delay = this.retryDelay
    try {
      const result = await this.retry(() => this.active, cursors.get(this.scope))
      if (result.cursor) rememberCursor(this.scope, result.cursor)
      if (result.failed > 0) {
        this.consecutiveFailures = Math.min(this.consecutiveFailures + 1, 16)
        delay = Math.min(this.retryDelay * 2 ** (this.consecutiveFailures - 1), this.maxRetryDelay)
      } else {
        this.consecutiveFailures = 0
      }
    } catch {
      this.consecutiveFailures = Math.min(this.consecutiveFailures + 1, 16)
      delay = Math.min(this.retryDelay * 2 ** (this.consecutiveFailures - 1), this.maxRetryDelay)
    } finally {
      this.running = false
      if (this.active) this.schedule(delay)
    }
  }

  private schedule(delay: number): void {
    if (!this.active || this.running || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run()
    }, delay)
    this.timer.unref?.()
  }
}
