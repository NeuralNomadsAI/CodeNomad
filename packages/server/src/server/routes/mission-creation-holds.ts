import { createHash } from "node:crypto"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

export interface MissionCreationOperation {
  key: string
  workspaceID: string
  projectID: string
  missionID: string
  sessionID: string
  requestDigest: string
}
interface Binding extends MissionCreationOperation {
  connection: ServiceConnection
  locations: readonly { directory: string; identity: string }[]
}
interface HeldCreation { binding: Binding; state: "preparing" | "dispatched" | "uncertain"; releasePermit(): void }
const CAPACITY = 128
// Backend/fence-scoped, bounded retention, not an authority store or dispatcher.
// Unknown writes have NO expiry, negative-GET release, new-generation adoption or
// retry runner. This presence-backed native API has no terminal mutation receipt.
const held = new WeakMap<WorktreeDeletionFence, Map<string, HeldCreation>>()

export class MissionCreationHoldError extends Error {
  constructor(readonly code: "creation-uncertain" | "creation-conflict" | "creation-capacity") {
    super(code === "creation-uncertain" ? "Mission creation settlement is unknown; deletion remains blocked"
      : code === "creation-conflict" ? "Mission creation retry differs from its held scope"
      : "Mission creation admission capacity is exhausted")
  }
}

export function missionCreationDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

/** Register BEFORE dispatch, using the original exact physical permit. A repeat
 * cannot enter a replacement permit, send again, or consume an unknown hold. */
export function holdMissionCreation(fence: WorktreeDeletionFence, binding: Binding, enter: () => (() => void) | undefined) {
  let registry = held.get(fence)
  if (!registry) { registry = new Map(); held.set(fence, registry) }
  const previous = registry.get(binding.key)
  if (previous) {
    const { connection, ...scope } = binding, { connection: oldConnection, ...oldScope } = previous.binding
    throw new MissionCreationHoldError(connection === oldConnection && missionCreationDigest(scope) === missionCreationDigest(oldScope)
      ? "creation-uncertain" : "creation-conflict")
  }
  if (registry.size >= CAPACITY) throw new MissionCreationHoldError("creation-capacity")
  const release = enter()
  if (!release) return undefined
  const record: HeldCreation = { binding: { ...binding, locations: binding.locations.map(item => ({ ...item })) }, state: "preparing", releasePermit: release }
  registry.set(binding.key, record)
  let finished = false, proven = false
  return {
    dispatched() {
      if (finished || record.state !== "preparing") throw new MissionCreationHoldError("creation-uncertain")
      binding.connection.assertCurrent()
      record.state = "dispatched"
    },
    // Only the original awaited, validated response (success or exact certified
    // no-effect create rejection) is evidence. Later GETs and ordinary errors aren't.
    settled() { if (record.state === "dispatched" && !finished) proven = true },
    release() {
      if (finished) return
      finished = true
      if (record.state === "dispatched" && !proven) { record.state = "uncertain"; return }
      registry.delete(binding.key)
      release()
    },
    get uncertain() { return record.state !== "preparing" && !proven },
  }
}

/** Only recurrence's exact durable readback may settle its lost transport ACK;
 * ordinary one-shot creation retains its existing hold semantics. */
export function reconcileRecurrenceCreation(fence: WorktreeDeletionFence, key: string, digest: string): void {
  const registry = held.get(fence), record = registry?.get(key)
  if (!record) return
  if (!key.startsWith("recurrence:") || record.binding.requestDigest !== digest || record.state !== "uncertain") {
    throw new MissionCreationHoldError("creation-conflict")
  }
  registry!.delete(key)
  record.releasePermit()
}
