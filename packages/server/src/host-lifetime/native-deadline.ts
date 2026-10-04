import { HostError } from "./protocol"

/** An operation owns one absolute budget. Timers bound unattended waits, but
 * admission always checks the clock too: delayed callbacks grant no extension.
 * Inherited expiry never grows across lookup, transport or native verification. */
export class NativeDeadline {
  readonly expires: number
  constructor(budgetMs: number, inherited?: number, private readonly expired?: () => void) {
    const now = Date.now()
    if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || (inherited !== undefined && !Number.isSafeInteger(inherited)))
      throw new HostError("native-runtime-timeout")
    this.expires = Math.min(now + budgetMs, inherited ?? Infinity)
    this.check()
  }
  check(): void {
    if (Date.now() < this.expires) return
    this.expired?.()
    throw new HostError("native-runtime-timeout")
  }
  async observe<T>(work: () => Promise<T>): Promise<T> {
    this.check()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.expired?.(); reject(new HostError("native-runtime-timeout"))
      }, this.expires - Date.now())
    })
    try {
      const value = await Promise.race([work(), timeout])
      this.check()
      return value
    } finally { clearTimeout(timer) }
  }
}
