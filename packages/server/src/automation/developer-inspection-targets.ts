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

  get(sessionId: string, native: { runId: string; windowId: string; endpoint: string }): DeveloperCdpIdentity {
    const target = this.targets.get(sessionId)
    if (!target || target.runId !== native.runId || target.windowId !== native.windowId || target.endpoint !== native.endpoint) {
      this.targets.delete(sessionId)
      throw new Error("Run codenomad.inspect before acting on or restarting this CodeNomad window")
    }
    return target
  }

  forget(sessionId: string): void {
    this.targets.delete(sessionId)
  }
}
