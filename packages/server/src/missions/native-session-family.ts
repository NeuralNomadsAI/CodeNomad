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

/** Lifecycle control needs the whole native family, not the display cap. */
export const MAX_CONTROL_FAMILY_SESSIONS = 4096
const CONTROL_PAGE_SIZE = 200

export interface NativeControlFamily {
  /** Root first, then breadth-first members with their native depth. */
  members: Map<string, { session: SessionInfo; depth: number }>
  /** False when the budget ran out, a page failed or an inconsistent child was skipped. */
  complete: boolean
}

/** Best-effort, cycle-safe and paginated. Unlike the display reader it never
 * throws on a partial inventory: control must still act on what it observed,
 * and callers must report `complete: false` honestly. Abort/currentness throw. */
export async function readNativeControlFamily(client: OpenCodeClient, root: SessionInfo, signal: AbortSignal,
  options: { assertCurrent?: () => void; maxSessions?: number; deadline?: number } = {}): Promise<NativeControlFamily> {
  const maxSessions = options.maxSessions ?? MAX_CONTROL_FAMILY_SESSIONS
  const members = new Map([[root.id, { session: root, depth: 0 }]])
  const queue = [root.id]
  let complete = true, reads = 0
  for (let index = 0; index < queue.length; index++) {
    let cursor: string | undefined
    const cursors = new Set<string>()
    do {
      signal.throwIfAborted()
      options.assertCurrent?.()
      if (++reads > 2 * (maxSessions + 1) || (options.deadline !== undefined && Date.now() > options.deadline)) return { members, complete: false }
      let children: Awaited<ReturnType<OpenCodeClient["session"]["list"]>>
      try { children = await client.session.list({ parentID: queue[index], limit: CONTROL_PAGE_SIZE, ...(cursor ? { cursor } : {}) }, { signal }) }
      catch { signal.throwIfAborted(); complete = false; break }
      signal.throwIfAborted()
      options.assertCurrent?.()
      const depth = members.get(queue[index])!.depth + 1
      for (const child of children.data) {
        if (typeof child.id !== "string" || !child.id.trim() || child.parentID !== queue[index]
          || child.projectID !== root.projectID || !sameLocation(child.location, root.location) || members.has(child.id)) {
          complete = false
          continue
        }
        if (members.size >= maxSessions) return { members, complete: false }
        members.set(child.id, { session: child, depth })
        queue.push(child.id)
      }
      cursor = children.cursor.next ?? undefined
      if (cursor && (!children.data.length || cursors.has(cursor))) { complete = false; cursor = undefined }
      if (cursor) cursors.add(cursor)
    } while (cursor)
  }
  options.assertCurrent?.()
  return { members, complete }
}

/** Bounded ancestry probe for display/recovery when the capped family read
 * cannot enumerate the whole tree: does any natively active session descend
 * from `rootID`? A false result proves nothing; true is positive evidence.
 * Callers probing several roots share `parents` and `budget` so the native
 * reads stay bounded for the whole observation, not per root. */
export async function observeActiveDescendant(client: OpenCodeClient, rootID: string, active: Readonly<Record<string, unknown>>,
  signal: AbortSignal, options: { known?: ReadonlyMap<string, { parentID?: string }>; maxReads?: number
    parents?: Map<string, string | undefined>; budget?: { reads: number } } = {}): Promise<boolean> {
  const parents = options.parents ?? new Map<string, string | undefined>()
  for (const [id, session] of options.known ?? []) parents.set(id, session.parentID)
  const budget = options.budget ?? { reads: options.maxReads ?? 256 }
  for (const id of Object.keys(active).filter(id => id !== rootID && active[id]).slice(0, 256)) {
    const seen = new Set<string>()
    let cursor: string | undefined = id
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      if (cursor === rootID) return true
      if (!parents.has(cursor)) {
        // Exhausted: later chains may still resolve through cached parents.
        if (budget.reads <= 0) break
        budget.reads--
        signal.throwIfAborted()
        try { parents.set(cursor, (await client.session.get({ sessionID: cursor }, { signal })).parentID) }
        catch { signal.throwIfAborted(); parents.set(cursor, undefined) }
      }
      cursor = parents.get(cursor)
    }
  }
  return false
}
