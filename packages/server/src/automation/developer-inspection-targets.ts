import type { DeveloperCdpIdentity } from "../developer-cdp"
import { randomUUID } from "node:crypto"

/** Pin the inspected native window/run, independently of the selected project
 * or conversation. A new native target requires a fresh inspection. */
export class DeveloperInspectionTargets {
  private readonly targets = new Map<string, {
    current?: DeveloperCdpIdentity
    issued: Map<string, DeveloperCdpIdentity>
    order?: { source: string; sequence: number }
    restartId?: string
  }>()
  private evicted = false
  private retirement = 0
  private readonly retiredRuns = new Map<string, number>()

  canReconnect(sessionId: string, restartId: string): boolean {
    const entry = this.targets.get(sessionId)
    return entry ? entry.restartId === restartId : !this.evicted
  }

  begin(sessionId: string, order?: { source: string; sequence: number }, restartId?: string): ((identity: DeveloperCdpIdentity) => string | undefined) | undefined {
    const previous = this.targets.get(sessionId)
    if (restartId && !this.canReconnect(sessionId, restartId)) return undefined
    if (order && previous?.order?.source === order.source && previous.order.sequence > order.sequence) return undefined
    const retirement = this.retirement
    const entry = { current: undefined as DeveloperCdpIdentity | undefined, issued: previous?.issued ?? new Map<string, DeveloperCdpIdentity>(),
      order: order ?? previous?.order, restartId }
    this.targets.delete(sessionId)
    this.targets.set(sessionId, entry)
    if (this.targets.size > 128) {
      this.targets.delete(this.targets.keys().next().value!)
      // An absent record could be a newer selection that was evicted.
      this.evicted = true
    }
    return identity => {
      if (this.targets.get(sessionId) !== entry || (this.retiredRuns.get(identity.runId) ?? 0) > retirement) return undefined
      const pin = randomUUID()
      entry.current = identity
      entry.issued.set(pin, identity)
      if (entry.issued.size > 8) entry.issued.delete(entry.issued.keys().next().value!)
      return pin
    }
  }

  get(sessionId: string, pin: unknown): DeveloperCdpIdentity | undefined {
    return typeof pin === "string" ? this.targets.get(sessionId)?.issued.get(pin) : undefined
  }

  isCurrent(sessionId: string, identity: DeveloperCdpIdentity): boolean {
    return this.targets.get(sessionId)?.current === identity
  }

  forgetRun(sessionId: string, runId: string): void {
    const entry = this.targets.get(sessionId)
    if (!entry) return
    if (entry.current?.runId === runId) entry.current = undefined
    for (const [pin, identity] of entry.issued) if (identity.runId === runId) entry.issued.delete(pin)
  }

  retireRun(runId: string): void {
    this.retiredRuns.set(runId, ++this.retirement)
    for (const sessionId of this.targets.keys()) this.forgetRun(sessionId, runId)
  }
}
