import { randomUUID } from "node:crypto"
import { z } from "zod"
import { OpenCodeServerIdSchema } from "../config/schema"
import type { NativeParent } from "../native-parent"
import type { WorkspaceManager } from "./manager"

const desktopSchema = z.object({
  receipt: z.string().uuid(), status: z.literal("unknown"), retainedStatus: z.enum(["complete", "unknown"]),
  owners: z.array(z.object({ ownerId: z.string().uuid(), live: z.boolean(), retained: z.boolean() }).strict()).max(32),
  refs: z.array(z.object({ ownerId: z.string().uuid(), tabId: z.string().uuid(), source: z.literal("retained"),
    serverId: OpenCodeServerIdSchema, directory: z.string().min(1).max(4096).refine(value => !value.includes("\0")),
  }).strict()).max(512),
}).strict()

/** Backend-owned snapshot, kept internal until a consumer has qualified every participant. */
export async function readServerAttachments(manager: WorkspaceManager, parent: Pick<NativeParent, "available" | "request">, serverId: string) {
  OpenCodeServerIdSchema.parse(serverId)
  // Capture owners before the first defer: a formerly empty reader cannot adopt new reservations.
  const connections = manager.getServerConnections()
  const workspaces = manager.attachmentReservations(serverId), leases = connections.attachmentReservations(serverId)
  const participants = manager.projectParticipants.snapshot(serverId)
  const receipt = randomUUID()
  const backendCurrent = () => manager.attachmentReceiptCurrent(workspaces.receipt) && connections.attachmentReceiptCurrent(leases.receipt)
    && manager.projectParticipants.isCurrent(participants.receipt)
  let desktop: z.infer<typeof desktopSchema> | undefined
  if (parent.available) {
    try {
      const value = await parent.request<unknown>("projects.attachments.read", {}, 5_000)
      if (Buffer.byteLength(JSON.stringify(value), "utf8") > 8 * 1024 * 1024) throw new Error("attachment_inventory_unavailable")
      const parsed = desktopSchema.parse(value)
      const owners = new Set(parsed.owners.map(owner => owner.ownerId))
      if (owners.size !== parsed.owners.length || new Set(parsed.refs.map(ref => ref.tabId)).size !== parsed.refs.length
        || parsed.refs.some(ref => !owners.has(ref.ownerId))) throw new Error("attachment_inventory_unavailable")
      desktop = parsed
    } catch { /* Missing, unreadable or retired native metadata preserves unknown coverage. */ }
  }
  const current = async () => {
    if (!backendCurrent() || !desktop) return false
    try {
      const valid = await parent.request<unknown>("projects.attachments.current", { receipt: desktop.receipt }, 5_000)
      return valid === true && backendCurrent()
    } catch { return false }
  }
  const valid = await current()
  const bounded = (desktop?.owners.length ?? 0) + participants.owners.length <= 32
    && (desktop?.refs.length ?? 0) + participants.referenceCount <= 512
  return {
    receipt, serverId, status: "unknown" as const,
    coverage: { retained: valid && bounded ? desktop!.retainedStatus : "unknown", live: "unknown", participants: "unknown" },
    observationOverflow: !bounded,
    owners: valid && bounded ? desktop!.owners : [],
    refs: valid && bounded ? desktop!.refs.filter(ref => ref.serverId === serverId) : [],
    // These independent owner views overlap; they are never added as tab counts.
    backend: backendCurrent() ? { workspaces, leases } : undefined,
    participants: backendCurrent() && bounded ? participants : undefined,
    isCurrent: current,
  }
}
