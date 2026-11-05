import { randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"
import { OpenCodeServerIdSchema } from "../config/schema"

export const PARTICIPATION_HEADER = "x-codenomad-participation"
export const PARTICIPATION_EVENT = "codenomad.project.participation"
export interface ProjectParticipationGrant { token: string }
export interface ProjectParticipationRef { tabId: string; serverId: string; directory: string; workspaceId?: string }
export interface ProjectParticipationUpdate { revision: number; refs: ProjectParticipationRef[]; unknown?: true }
const updateSchema = z.object({
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  unknown: z.literal(true).optional(),
  refs: z.array(z.object({ tabId: z.string().uuid(), serverId: OpenCodeServerIdSchema,
    directory: z.string().min(1).max(4096).refine(value => value.trim().length > 0 && !value.includes("\0")),
    workspaceId: z.string().min(1).max(512).optional(),
  }).strict()).max(32),
}).strict()
type Binding = { serverId: string; directory: string; owner: object }
type Participant = { id: string; principal: string; current: () => boolean; revision: number; admission?: object;
  refs: ProjectParticipationRef[]; bindings: Array<() => boolean>; known: boolean }
const holds = (check: () => boolean) => { try { return check() } catch { return false } }

/** Positive declarations only. Every snapshot keeps unknown overall participation. */
export class ProjectParticipants {
  private readonly active = new Map<string, Participant>()
  private readonly lost = new Map<string, ProjectParticipationRef[]>()
  private epoch = randomUUID()
  private closed = false
  private overflow = false

  private changed() { this.epoch = randomUUID() }
  private overflowed() { if (!this.overflow) { this.overflow = true; this.changed() } }
  register(principal: string, current: () => boolean) {
    this.changed() // Admission is visible before the grant can reach a renderer.
    if (this.closed || !holds(current)) return undefined
    // ponytail: uncertain closed streams retain one bounded slot until backend restart;
    // reclaim only after an authenticated retirement/reconciliation contract is qualified.
    if (this.active.size + this.lost.size >= 32) { this.overflowed(); return undefined }
    const token = randomBytes(32).toString("hex"), participant: Participant = {
      id: randomUUID(), principal, current, revision: 0, refs: [], bindings: [], known: false,
    }
    this.active.set(token, participant)
    return { grant: { token }, close: () => this.retire(token, participant) }
  }

  private retire(token: string, participant: Participant) {
    if (this.active.get(token) !== participant) return
    this.active.delete(token)
    this.lost.set(participant.id, participant.refs)
    this.changed()
  }

  /** Called before body parsing; each overlapping request owns a separate admission. */
  admit(token: unknown, principal: string) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || this.closed) return undefined
    const participant = this.active.get(token)
    if (!participant || participant.principal !== principal) return undefined
    if (!holds(participant.current)) { this.retire(token, participant); return undefined }
    const admission = {}
    const expiresAt = performance.now() + 5_000
    participant.admission = admission; participant.known = false; this.changed()
    const current = () => {
      if (this.closed || this.active.get(token) !== participant) return false
      if (!holds(participant.current)) { this.retire(token, participant); return false }
      return true
    }
    return {
      publish: (value: unknown, resolve: (id: string) => Binding | undefined) => {
        if (!current() || performance.now() >= expiresAt || participant.admission !== admission) return false
        const parsed = updateSchema.safeParse(value)
        if (!parsed.success || parsed.data.revision <= participant.revision) return false
        const update = parsed.data
        if (update.unknown) {
          if (update.refs.length) return false
          participant.revision = update.revision; this.changed(); return true
        }
        if (new Set(update.refs.map(ref => ref.tabId)).size !== update.refs.length) return false
        const total = [...this.active.values()].reduce((count, item) => count + (item === participant ? 0 : item.refs.length), 0)
          + [...this.lost.values()].reduce((count, refs) => count + refs.length, 0)
        if (total + update.refs.length > 512) { this.overflowed(); return false }
        const bindings: Array<() => boolean> = []
        const lookup = (id: string) => { try { return resolve(id) } catch { return undefined } }
        for (const ref of update.refs) if (ref.workspaceId !== undefined) {
          const id = ref.workspaceId, captured = lookup(id)
          if (!captured || captured.serverId !== ref.serverId || captured.directory !== ref.directory) return false
          bindings.push(() => { const now = lookup(id); return !!now && now.owner === captured.owner
            && now.serverId === captured.serverId && now.directory === captured.directory })
        }
        if (!current() || performance.now() >= expiresAt || participant.admission !== admission) return false
        participant.refs = update.refs.map(ref => ({ ...ref })); participant.bindings = bindings
        participant.revision = update.revision; participant.known = true; this.changed()
        return true
      },
    }
  }

  private revalidate() {
    for (const [token, participant] of this.active) {
      if (!holds(participant.current)) { this.retire(token, participant); continue }
      if (participant.known && participant.bindings.some(current => !holds(current))) {
        participant.known = false; participant.bindings = []; this.changed()
      }
    }
  }

  snapshot(serverId: string) {
    this.revalidate()
    return { receipt: this.epoch, status: "unknown" as const, overflow: this.overflow,
      referenceCount: [...this.active.values()].reduce((count, participant) => count + participant.refs.length, 0)
        + [...this.lost.values()].reduce((count, refs) => count + refs.length, 0),
      owners: [...this.active.values()].map(participant => ({ ownerId: participant.id, observation: participant.known ? "declared" as const : "unknown" as const }))
        .concat([...this.lost.keys()].map(ownerId => ({ ownerId, observation: "unknown" as const }))),
      refs: [...this.active.values()].flatMap(participant => participant.refs.filter(ref => ref.serverId === serverId)
        .map(ref => ({ ...ref, ownerId: participant.id, source: "participant" as const })))
        .concat([...this.lost].flatMap(([ownerId, refs]) => refs.filter(ref => ref.serverId === serverId)
          .map(ref => ({ ...ref, ownerId, source: "participant" as const })))),
      unresolvedOwners: this.lost.size,
    }
  }

  isCurrent(receipt: string) { this.revalidate(); return !this.closed && receipt === this.epoch }
  dispose() { this.closed = true; this.active.clear(); this.lost.clear(); this.changed() }
}
