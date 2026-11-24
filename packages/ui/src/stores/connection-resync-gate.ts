import type { InstanceStreamStatus } from "../../../server/src/api-types"

export class ConnectionResyncGate {
  private readonly pending = new Set<string>()

  observe(instanceId: string, status: InstanceStreamStatus, reason?: string): boolean {
    if (status === "error" || (status === "disconnected" && reason !== "workspace stopped")) {
      this.pending.add(instanceId)
      return false
    }
    if (status !== "connected") return false
    return this.pending.delete(instanceId)
  }

  clear(instanceId: string): void {
    this.pending.delete(instanceId)
  }
}
