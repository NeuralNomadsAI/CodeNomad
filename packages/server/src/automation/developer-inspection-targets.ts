import type { DeveloperCdpIdentity } from "../developer-cdp"

/** Pin the inspected native window/run, independently of the selected project
 * or conversation. A new native target requires a fresh inspection. */
export class DeveloperInspectionTargets {
  private readonly targets = new Map<string, DeveloperCdpIdentity>()

  remember(sessionId: string, identity: DeveloperCdpIdentity): void {
    this.targets.delete(sessionId)
    this.targets.set(sessionId, identity)
    if (this.targets.size > 128) this.targets.delete(this.targets.keys().next().value!)
  }

  get(sessionId: string): DeveloperCdpIdentity | undefined {
    return this.targets.get(sessionId)
  }

  forget(sessionId: string): void {
    this.targets.delete(sessionId)
  }
}
