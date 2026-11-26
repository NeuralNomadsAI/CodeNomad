import { Context, Effect, Schema } from "effect"
import { Location } from "@opencode/schema/location"
import { passageFixture } from "./native-passage-test-fixture"
import { MissionControl } from "../../missions/control"
import { readNativeRecurrenceCurrent, readNativeRecurrenceCurrentPage, readNativeRecurrenceCurrentContent } from "./native-recurrence-current"

/** An admitted passage with its real isolated journal and invocation-scoped native readers; reads have no native effects. */
export async function currentPassageFixture() {
  const f = await passageFixture(), scheduleID = "schedule"
  await f.start()
  const location = Schema.decodeUnknownSync(Location.Info)({ directory: f.root, project: { id: "project", directory: f.root, canonical: f.root } })
  const tag = (name: string) => Context.Service<never, unknown>(name)
  const sql = Object.assign(() => {}, { unsafe: () => { throw Error("Display never queries native sessions or signer") } })
  const graph = Context.make(tag("@opencode/storage/Database"), { db: { $client: sql, transaction: () => Effect.die("Display never writes") } })
    .pipe(Context.add(tag("@opencode/Location"), location))
  let ranges = 0, entries = 0
  const ctx = { location, storage: { get: (key: string) => {
    if (key.includes("/finishes/")) throw Error("Isolated finish counter trap")
    return Effect.promise(() => f.storage.get(key))
  }, set: () => Effect.die("Display never writes"), scan: (input: Parameters<typeof f.storage.scan>[0]) => Effect.promise(async () => {
    if (!input.after) ranges++; const page = await f.storage.scan(input); entries += page.entries.length; return page
  }) } } as unknown as Parameters<typeof readNativeRecurrenceCurrent>[0]
  const run = <A>(effect: Effect.Effect<A, unknown>, signal?: AbortSignal) => Effect.runPromise(effect.pipe(Effect.provide(graph)), { signal })
  /** Journal edits made by the test itself, outside the passage business and its native effects. */
  const control = new MissionControl({ project: { id: "project", canonical: f.root, location: { directory: f.root } }, storage: f.passage.storage,
    sessions: { get: async ({ sessionID }: { sessionID: string }) => f.sessions.get(sessionID), create: async (input: any) => {
      const session = { ...input, projectID: "project", location: { directory: f.root } }; f.sessions.set(input.id, session); return session
    }, prompt: async () => {}, synthetic: async () => {} } as never })
  return { ...f, scheduleID, control, location, ctx,
    read: () => run(readNativeRecurrenceCurrent(ctx, { scheduleID })),
    page: (input: unknown, signal?: AbortSignal) => run(readNativeRecurrenceCurrentPage(ctx, input), signal),
    content: (input: unknown) => run(readNativeRecurrenceCurrentContent(ctx, input)),
    metrics: () => ({ ranges, entries }),
  }
}
