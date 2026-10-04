import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import { sameLocation } from "../opencode/compatibility/location"

export const MAX_MISSION_DESCENDANTS = 32

export type NativeMissionFamilyTree = ReadonlyMap<string, SessionInfo>

/** Bounded native ancestry, not task ancestry. Partial/moved/duplicate inventory
 * is unknown; callers must already authorize the root and fence late results. */
export async function readNativeMissionFamily(client: OpenCodeClient, root: SessionInfo, signal: AbortSignal): Promise<Set<string>> {
  return new Set((await readNativeMissionFamilyTree(client, root, signal)).keys())
}

/** Retains actual native parent data from the same bounded reads as the ID view.
 * Optional checks supply caller-owned currentness/budget, not an admission proof. */
export async function readNativeMissionFamilyTree(client: OpenCodeClient, root: SessionInfo, signal: AbortSignal,
  options: { assertCurrent?: () => void; consumeRead?: () => void } = {}): Promise<NativeMissionFamilyTree> {
  options.assertCurrent?.()
  if (!root.id || root.parentID === root.id) throw new Error("Changed or inconsistent child tree")
  const members = new Map([[root.id, root]])
  const queue = [root.id]
  let reads = 0
  for (let index = 0; index < queue.length; index++) {
    let cursor: string | undefined
    const cursors = new Set<string>()
    do {
      signal.throwIfAborted()
      options.assertCurrent?.()
      // Native 2.0.21 emits next for EVERY nonempty page, not just a full
      // page. Drain until the authoritative empty/end page, never infer it.
      if (++reads > 2 * (MAX_MISSION_DESCENDANTS + 1)) throw new Error("Incomplete child inventory")
      options.consumeRead?.()
      const children = await client.session.list({ parentID: queue[index], limit: MAX_MISSION_DESCENDANTS + 1, ...(cursor ? { cursor } : {}) }, { signal })
      signal.throwIfAborted()
      options.assertCurrent?.()
      if (children.data.length + members.size > MAX_MISSION_DESCENDANTS + 1) throw new Error("Incomplete child inventory")
      for (const child of children.data) {
        if (typeof child.id !== "string" || !child.id.trim() || child.parentID !== queue[index]
          || child.projectID !== root.projectID || !sameLocation(child.location, root.location) || members.has(child.id)) {
          throw new Error("Changed or inconsistent child tree")
        }
        members.set(child.id, child)
        queue.push(child.id)
      }
      cursor = children.cursor.next ?? undefined
      if (cursor) {
        if (!children.data.length || cursors.has(cursor)) throw new Error("Incomplete child inventory")
        cursors.add(cursor)
      }
    } while (cursor)
  }
  options.assertCurrent?.()
  return members
}
