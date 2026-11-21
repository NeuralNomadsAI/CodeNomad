import type { DeveloperCdpIdentity } from "../developer-cdp"
import { randomUUID } from "node:crypto"

/** Pin the inspected native window/run, independently of the selected project
 * or conversation. A new native target requires a fresh inspection. */
export class DeveloperInspectionTargets {
  private readonly targets = new Map<string, { identity?: DeveloperCdpIdentity; pending?: symbol }>()
  private readonly issued = new Map<string, { sessionId: string; identity: DeveloperCdpIdentity }>()

  begin(sessionId: string): (identity: DeveloperCdpIdentity) => string | undefined {
    const entry = { ...this.targets.get(sessionId), pending: Symbol() }
    this.targets.delete(sessionId)
    this.targets.set(sessionId, entry)
    if (this.targets.size > 128) this.targets.delete(this.targets.keys().next().value!)
    return identity => {
      if (this.targets.get(sessionId) !== entry) return undefined
      const pin = randomUUID()
      this.targets.set(sessionId, { identity })
      this.issued.set(pin, { sessionId, identity })
      if (this.issued.size > 128) this.issued.delete(this.issued.keys().next().value!)
      return pin
    }
  }

  get(sessionId: string, pin?: unknown): DeveloperCdpIdentity | undefined {
    if (pin === undefined) return this.targets.get(sessionId)?.identity
    const entry = typeof pin === "string" ? this.issued.get(pin) : undefined
    return entry?.sessionId === sessionId ? entry.identity : undefined
  }

  forget(sessionId: string): void {
    this.targets.delete(sessionId)
    for (const [pin, entry] of this.issued) if (entry.sessionId === sessionId) this.issued.delete(pin)
  }
}
