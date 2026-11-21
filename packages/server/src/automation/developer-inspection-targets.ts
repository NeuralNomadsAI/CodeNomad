import type { DeveloperCdpIdentity } from "../developer-cdp"
import { randomUUID } from "node:crypto"

/** Pin the inspected native window/run, independently of the selected project
 * or conversation. A new native target requires a fresh inspection. */
export class DeveloperInspectionTargets {
  private readonly targets = new Map<string, { identity?: DeveloperCdpIdentity; pin?: string; pending?: symbol }>()

  begin(sessionId: string): (identity: DeveloperCdpIdentity) => string | undefined {
    const entry = { ...this.targets.get(sessionId), pending: Symbol() }
    this.targets.delete(sessionId)
    this.targets.set(sessionId, entry)
    if (this.targets.size > 128) this.targets.delete(this.targets.keys().next().value!)
    return identity => {
      if (this.targets.get(sessionId) !== entry) return undefined
      const pin = randomUUID()
      this.targets.set(sessionId, { identity, pin })
      return pin
    }
  }

  get(sessionId: string, pin?: unknown): DeveloperCdpIdentity | undefined {
    const entry = this.targets.get(sessionId)
    return pin === undefined || pin === entry?.pin ? entry?.identity : undefined
  }

  forget(sessionId: string): void {
    this.targets.delete(sessionId)
  }
}
