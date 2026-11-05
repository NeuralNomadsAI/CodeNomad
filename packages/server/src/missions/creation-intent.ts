import { z } from "zod"
import type { MissionStartInput } from "./control-types"
import { MissionControlError } from "./control-error"
import { missionCreationChoices, missionCreationChoicesSchema, parseMissionCreationDefaults, sameMissionCreationChoices,
  type MissionCreationDefaults } from "./creation-defaults"
import { runMissionExclusive } from "./exclusive"
import type { MissionStorage } from "./journal"
import type { MissionEvent, MissionJsonValue } from "./model"

type Request = MissionStartInput & { title?: string }
const requestSchema = missionCreationChoicesSchema.extend({ objective: z.string().min(1).max(20_000),
  title: z.string().min(1).max(60).optional(), notes: z.string().max(20_000).optional(),
  template: z.enum(["custom", "debug", "wayfinder", "delivery", "compare"]) }).strict()
const intentSchema = z.object({ version: z.literal(1), request: requestSchema, defaults: z.unknown() }).strict()
const sameRequest = (left: Request, right: Request) => left.objective === right.objective && left.title === right.title
  && left.notes === right.notes && left.template === right.template && sameMissionCreationChoices(left, right)
const originalRequest = (input: Request, defaults: MissionCreationDefaults): Request => ({
  objective: input.objective, template: input.template, ...(input.title === undefined ? {} : { title: input.title }),
  ...(input.notes === undefined ? {} : { notes: input.notes }), ...missionCreationChoices(defaults.request),
})

/** Durable, bounded pre-dispatch intentions. A missing document or lost RPC reply
 * never permits resolving the same original request against new preferences. */
export class MissionCreationIntents {
  private readonly prefix: string
  constructor(private readonly storage: MissionStorage, projectToken: string) {
    this.prefix = `codenomad-missions/v2/creation-intents/${projectToken}/`
  }

  private conflict(code: string): never {
    throw new MissionControlError("Creation request ID was already used with a different mission", code)
  }

  private async recorded(missionID: string, request: Request, conflict: string): Promise<MissionCreationDefaults | undefined> {
    const raw = await this.storage.get(this.prefix + missionID)
    if (raw === undefined) return undefined
    let saved: z.infer<typeof intentSchema>, defaults: MissionCreationDefaults
    try {
      saved = intentSchema.parse(raw)
      defaults = parseMissionCreationDefaults(saved.request.template, saved.defaults)
      if (!sameMissionCreationChoices(saved.request, defaults.request)) throw new Error("Invalid original choices")
    } catch { throw new MissionControlError("Mission creation intent is unreadable; existing data is retained", "invalid-journal") }
    if (!sameRequest(saved.request, request)) this.conflict(conflict)
    return defaults
  }

  private fromEvent(event: MissionEvent | undefined, request: Request, conflict: string) {
    if (event?.type !== "mission.created" || !event.creationDefaults) return undefined
    const original = originalRequest(event, event.creationDefaults)
    if (!sameRequest(original, request)) this.conflict(conflict)
    return event.creationDefaults
  }

  async read(missionID: string, request: Request, created: () => Promise<MissionEvent | undefined>, conflict: string) {
    // Read the intent before its eventual receipt: publication precedes removal.
    return await this.recorded(missionID, request, conflict) ?? this.fromEvent(await created(), request, conflict)
  }

  save(missionID: string, input: Request, defaults: MissionCreationDefaults, created: () => Promise<MissionEvent | undefined>,
    current: () => void, conflict: string): Promise<MissionCreationDefaults> {
    const request = originalRequest(input, defaults)
    return runMissionExclusive(this.prefix, async () => {
      const saved = await this.read(missionID, request, created, conflict)
      if (saved) return saved
      const pending = await this.storage.scan({ prefix: this.prefix, limit: 129 })
      if (pending.entries.length >= 128 || pending.next) throw new MissionControlError("Unresolved Mission preparations reached their safety limit; resolve existing requests first", "creation-capacity")
      current()
      await this.storage.set(this.prefix + missionID, JSON.parse(JSON.stringify({ version: 1, request, defaults })) as MissionJsonValue, current)
      return defaults
    })
  }

  async settled(missionID: string): Promise<void> {
    // The durable creation event owns the original receipt. Failed cleanup
    // retains redundant evidence and its capacity place.
    try { await this.storage.remove?.(this.prefix + missionID) } catch { /* Retain the original intent. */ }
  }
}
