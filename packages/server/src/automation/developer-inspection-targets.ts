import type { DeveloperCdpIdentity } from "../developer-cdp"
import { randomUUID } from "node:crypto"

/** Pin the inspected native window/run, independently of the selected project
 * or conversation. A new native target requires a fresh inspection. */
export class DeveloperInspectionTargets {
  private readonly targets = new Map<string, { identity?: DeveloperCdpIdentity; issued: Map<string, DeveloperCdpIdentity> }>()

  begin(sessionId: string): (identity: DeveloperCdpIdentity) => string | undefined {
    const previous = this.targets.get(sessionId)
    const entry = { identity: previous?.identity, issued: previous?.issued ?? new Map<string, DeveloperCdpIdentity>() }
    this.targets.delete(sessionId)
    this.targets.set(sessionId, entry)
    if (this.targets.size > 128) this.targets.delete(this.targets.keys().next().value!)
    return identity => {
      if (this.targets.get(sessionId) !== entry) return undefined
      const pin = randomUUID()
      entry.identity = identity
      entry.issued.set(pin, identity)
      if (entry.issued.size > 8) entry.issued.delete(entry.issued.keys().next().value!)
      return pin
    }
  }

  get(sessionId: string, pin?: unknown): DeveloperCdpIdentity | undefined {
    const entry = this.targets.get(sessionId)
    return pin === undefined ? entry?.identity : typeof pin === "string" ? entry?.issued.get(pin) : undefined
  }

  forget(sessionId: string): void {
    this.targets.delete(sessionId)
  }
}
