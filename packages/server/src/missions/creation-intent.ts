import { z } from "zod"
import type { MissionStartInput } from "./control-types"
import { MissionControlError } from "./control-error"
import { missionCreationChoices, missionCreationChoicesSchema, missionCreationTemplateSchema, parseMissionCreationDefaults, sameMissionCreationChoices,
  type MissionCreationMetadata } from "./creation-defaults"
import { runMissionExclusive } from "./exclusive"
import type { MissionStorage } from "./journal"
import type { MissionEvent, MissionJsonValue } from "./model"

type Request = MissionStartInput & { title?: string }
const requestSchema = missionCreationChoicesSchema.extend({ objective: z.string().min(1).max(20_000),
  title: z.string().min(1).max(60).optional(), notes: z.string().max(20_000).optional(),
  template: missionCreationTemplateSchema }).strict()
const intentSchema = z.object({ version: z.literal(1), request: requestSchema, defaults: z.unknown(),
  createdAt: z.number().finite().nonnegative() }).strict()
export const MISSION_CREATION_INTENT_RETENTION_MS = 24 * 60 * 60 * 1_000
export const MISSION_CREATION_INTENT_LIMIT = 128
const sameRequest = (left: Request, right: Request) => left.objective === right.objective && left.title === right.title
  && left.notes === right.notes && left.template === right.template && sameMissionCreationChoices(left, right)
const originalRequest = (input: Request, defaults: MissionCreationMetadata): Request => ({
  objective: input.objective, template: input.template, ...(input.title === undefined ? {} : { title: input.title }),
  ...(input.notes === undefined ? {} : { notes: input.notes }), ...missionCreationChoices(defaults.request),
})

function parseIntent(raw: unknown) {
  try {
    const saved = intentSchema.parse(raw)
    const defaults = parseMissionCreationDefaults(saved.request.template, saved.defaults)
    if (!sameMissionCreationChoices(saved.request, defaults.request)) throw new Error("Invalid original choices")
    return { ...saved, defaults }
  } catch { throw new MissionControlError("Mission creation intent is unreadable; existing data is retained", "invalid-journal") }
}

/** Retained preparation choices, separate from the backend's native-effect holds. */
export class MissionCreationIntents {
  private readonly prefix: string
  constructor(private readonly storage: MissionStorage, projectToken: string, private readonly now = Date.now) {
    this.prefix = `codenomad-missions/v2/creation-intents/${projectToken}/`
  }

  private conflict(code: string): never {
    throw new MissionControlError("Creation request ID was already used with a different mission", code)
  }

  private async recorded(missionID: string, request: Request, conflict: string): Promise<MissionCreationMetadata | undefined> {
    const raw = await this.storage.get(this.prefix + missionID)
    if (raw === undefined || raw === null) return undefined
    const saved = parseIntent(raw)
    if (this.expired(saved.createdAt)) { await this.clear(missionID); return undefined }
    if (!sameRequest(saved.request, request)) this.conflict(conflict)
    return saved.defaults
  }

  private fromEvent(event: MissionEvent | undefined, request: Request, conflict: string) {
    if (event?.type !== "mission.created" || !event.creationDefaults) return undefined
    const original = originalRequest(event, event.creationDefaults)
    if (!sameRequest(original, request)) this.conflict(conflict)
    return event.creationDefaults
  }

  async read(missionID: string, request: Request, created: () => Promise<MissionEvent | undefined>, conflict: string) {
    return runMissionExclusive(this.prefix, () => this.readCurrent(missionID, request, created, conflict))
  }

  private async readCurrent(missionID: string, request: Request, created: () => Promise<MissionEvent | undefined>, conflict: string) {
    // A positive receipt survives expiry and cleanup of the retained choices.
    return this.fromEvent(await created(), request, conflict) ?? await this.recorded(missionID, request, conflict)
  }

  private expired(createdAt: number): boolean {
    return this.now() - createdAt >= MISSION_CREATION_INTENT_RETENTION_MS || createdAt > this.now()
  }

  private async activeCount(): Promise<number> {
    let after: string | undefined, count = 0
    do {
      const page = await this.storage.scan({ prefix: this.prefix, after, limit: MISSION_CREATION_INTENT_LIMIT + 1 })
      for (const entry of page.entries) {
        if (!entry.key.startsWith(this.prefix) || after !== undefined && entry.key <= after) throw new MissionControlError("Mission preparation storage is unreadable", "invalid-journal")
        if (entry.value === null) continue
        const saved = parseIntent(entry.value)
        if (this.expired(saved.createdAt)) await this.clear(entry.key.slice(this.prefix.length))
        else if (++count >= MISSION_CREATION_INTENT_LIMIT) return count
      }
      if (page.next !== undefined && (page.next === after || !page.entries.length)) throw new MissionControlError("Mission preparation storage is unreadable", "invalid-journal")
      after = page.next
    } while (after)
    return count
  }

  save(missionID: string, input: Request, defaults: MissionCreationMetadata, created: () => Promise<MissionEvent | undefined>,
    current: () => void, conflict: string): Promise<MissionCreationMetadata> {
    const request = originalRequest(input, defaults)
    return runMissionExclusive(this.prefix, async () => {
      current()
      const saved = await this.readCurrent(missionID, request, created, conflict)
      if (saved) return saved
      if (await this.activeCount() >= MISSION_CREATION_INTENT_LIMIT) throw new MissionControlError("128 Mission preparation choices are retained. Retry the original requestIDs to recover completed preparations, or wait up to 24 hours for these choices to expire. Check uncertain outcomes before creating replacements.", "creation-capacity")
      current()
      await this.storage.set(this.prefix + missionID, JSON.parse(JSON.stringify({ version: 1, request, defaults, createdAt: this.now() })) as MissionJsonValue, current)
      return defaults
    })
  }

  async settled(missionID: string): Promise<void> {
    // Cleanup of retained choices cannot replace an authoritative success/refusal.
    // A failed cleanup keeps its timestamp, so later retries or expiry can reclaim it.
    try { await runMissionExclusive(this.prefix, () => this.clear(missionID)) } catch { /* Retain until storage recovers. */ }
  }

  private async clear(missionID: string): Promise<void> {
    const key = this.prefix + missionID
    const value = await this.storage.get(key)
    if (value === undefined || value === null) return
    try {
      if (this.storage.remove) { await this.storage.remove(key); return }
    } catch { /* A cleared marker also releases capacity when key removal fails. */ }
    // ponytail: adapters without remove retain null markers; provide remove if scan cost matters.
    await this.storage.set(key, null)
  }
}
