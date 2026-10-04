import path from "node:path"
import { z } from "zod"
import type { OpenCodeClient } from "@opencode/client"
import { authorityDigest } from "../authority-protocol"
import { assertSynchronousAuthorityGuard } from "../authority-synchronous"
import { deny } from "./model"

const id = z.string().min(1).max(240), digest = z.string().regex(/^[a-f0-9]{64}$/)
const registration = z.object({ id, incarnationID: id, artifactDigest: digest,
  kind: z.enum(["legacy", "managed", "unknown"]), state: z.enum(["active", "disposed", "unknown"]) }).strict()
export const quiescenceSchema = z.object({ actionID: id, discoveryRoot: z.string().min(1).max(4096), configDigest: digest,
  inventoryDigest: digest, excludedWriterIDs: z.array(id).max(1000), remainingLegacyWriterIDs: z.array(id).max(0),
  policy: z.literal("explicit-human-quiescence-v1"),
  before: z.array(registration).max(1000), after: z.array(registration).max(1000),
  disposals: z.array(z.object({ registrationID: id, incarnationID: id, receiptID: id }).strict()).max(1000),
}).strict()
export type ExplicitQuiescenceEvidence = z.infer<typeof quiescenceSchema>

/** Structural cross-check ONLY, after private native proof verification.
 * Registration absence, presence expiry, PID death and config editing alone are
 * never disposal proof. Unknown inventories fail closed, never activate anything. */
export function assertExplicitQuiescence(value: ExplicitQuiescenceEvidence, writer: { registrationID: string; incarnationID: string; artifactDigest: string }): void {
  if (value.remainingLegacyWriterIDs.length || value.discoveryRoot.includes("\0")
    || !(path.win32.isAbsolute(value.discoveryRoot) || path.posix.isAbsolute(value.discoveryRoot))) deny("old-writer-unexcluded")
  const ids = (entries: readonly { id: string }[]) => entries.map(entry => entry.id)
  if (new Set(ids(value.before)).size !== value.before.length || new Set(ids(value.after)).size !== value.after.length
    || new Set(value.disposals.map(receipt => receipt.registrationID)).size !== value.disposals.length) deny("writer-inventory-invalid")
  if (value.before.some(entry => entry.kind === "unknown" || entry.state === "unknown")
    || value.after.some(entry => entry.kind === "unknown" || entry.state === "unknown" || entry.kind === "legacy" && entry.state === "active")) deny("old-writer-unexcluded")
  const active = value.after.filter(entry => entry.state === "active")
  if (active.length !== 1 || active[0].kind !== "managed" || active[0].id !== writer.registrationID
    || active[0].incarnationID !== writer.incarnationID || active[0].artifactDigest !== writer.artifactDigest) deny("managed-writer-unproven")
  const removed = value.before.filter(entry => entry.state === "active"
    && !value.after.some(after => after.id === entry.id && after.incarnationID === entry.incarnationID
      && after.kind === entry.kind && after.artifactDigest === entry.artifactDigest && after.state === "active"))
  for (const entry of removed) {
    if (value.after.some(after => after.id === entry.id && after.incarnationID === entry.incarnationID && after.state === "active")) deny("writer-incarnation-reused")
    if (!value.disposals.some(receipt => receipt.registrationID === entry.id && receipt.incarnationID === entry.incarnationID)) deny("native-disposal-unproven")
  }
  if (authorityDigest([...value.excludedWriterIDs].sort()) !== authorityDigest(removed.map(entry => entry.id).sort())
    || value.inventoryDigest !== authorityDigest({ before: value.before, after: value.after, disposals: value.disposals })) deny("writer-inventory-mismatch")
}

/** Read-only connected-daemon discovery. No environment/CLI roots, plugin
 * activation, file writing, location.reload, upgrade, timers or service actions.
 * Native transport must bind its quiescence proof to this exact config digest. */
export async function readNativeDiscoveryBoundary(client: Pick<OpenCodeClient, "config">, assertConnectionCurrent: () => true, signal: AbortSignal) {
  const check = () => { signal.throwIfAborted(); assertSynchronousAuthorityGuard(assertConnectionCurrent, "policy-unqualified") }
  check()
  const first = await client.config.get(undefined, { signal })
  check()
  const second = await client.config.get(undefined, { signal })
  check()
  const configDigest = authorityDigest(first)
  if (configDigest !== authorityDigest(second)) deny("native-config-changed")
  const globalDirectory = first.find(entry => entry.type === "directory")?.path
  if (!globalDirectory || globalDirectory.includes("\0") || !(path.win32.isAbsolute(globalDirectory) || path.posix.isAbsolute(globalDirectory))) deny("native-discovery-unavailable")
  return Object.freeze({ globalDirectory, configDigest })
}
