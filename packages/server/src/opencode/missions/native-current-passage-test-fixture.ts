import { Context, Effect, Schema } from "effect"
import { Location } from "@opencode/schema/location"
import { passageFixture } from "./native-passage-test-fixture"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { missionDocumentPassage } from "../../missions/mission-document-passage-storage"
import { MissionControl } from "../../missions/control"
import { readNativeRecurrenceCurrent, readNativeRecurrenceCurrentPage, readNativeRecurrenceCurrentContent } from "./native-recurrence-current"

/** Actual isolated journals and invocation-scoped native readers; no native effects from reads. */
export async function currentPassageFixture(owner: "daily" | "scheduled") {
  const f = await passageFixture(), current = () => true as const
  const documents = new NativeMissionDocumentStore({ get: f.storage.get, compareAndSet: async (key, value, expected, guard) => {
    guard(); const before = await f.storage.get(key) as { revision?: number } | undefined
    if ((before?.revision ?? null) !== expected) throw new Error("Fixture revision conflict")
    await f.storage.set(key, value)
  } }, "project", f.root)
  const config = (await f.calendar.read("schedule"))!.config
  const coordinator = config.profiles?.coordinator
  if (!coordinator?.model) throw Error("Fixture coordinator profile missing")
  let passage = f.passage, scheduleID = "schedule"
  if (owner === "daily") await f.start()
  else {
    scheduleID = "scheduled_current"
    let doc = await documents.create(scheduleID, { title: "Scheduled current", objective: config.consigne, template: config.template,
      profiles: config.profiles, taskMode: config.taskMode, profileID: config.profileID, executionHost: config.executionHost,
      roots: config.roots, watchedConversationIDs: [], launch: { timing: { kind: "every", intervalMs: 900_000 }, condition: null, ends: { maxLaunches: 3, at: null, afterMs: null } } }, 100, current)
    doc = await documents.change(doc.id, doc.revision, current, value => {
      changes.play(value, "play", 100, [])
      changes.synchronized(value, "play", (["principal", "reconciliation"] as const).map(role => ({ role, slot: 0, timeGeneration: 1,
        scheduleID: `sch_${role}`, sessionID: `ses_${role}`, highWater: 0, pendingWake: null, wakePreparing: null })))
      changes.reserve(value, { kind: "manual", requestID: "run-now" }, 101, [])
      changes.admitted(value, value.pending!.id, 102)
    })
    const execution = missionDocumentPassage(f.storage, doc, current)
    passage = { ...f.passage, ...execution }
    f.sessions.set(execution.coordinatorSessionID, { id: execution.coordinatorSessionID, projectID: "project", location: { directory: f.root },
      agent: coordinator.agent!, model: coordinator.model, metadata: { "codenomad.mission": { version: 1, missionID: execution.missionID, kind: "coordinator", role: "coordinator" } } })
    const initial = new MissionControl({ project: { id: "project", canonical: f.root, location: { directory: f.root } }, storage: execution.storage,
      sessions: { get: async ({ sessionID }: { sessionID: string }) => f.sessions.get(sessionID), create: async () => { throw Error("No implicit coordinator") }, prompt: async () => {}, synthetic: async () => {} } as never })
    await initial.create({ requestID: execution.passageID, objective: config.consigne, template: config.template, profiles: config.profiles,
      taskMode: config.taskMode, coordinatorSessionID: execution.coordinatorSessionID })
  }
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
  const control = new MissionControl({ project: { id: "project", canonical: f.root, location: { directory: f.root } }, storage: passage.storage,
    sessions: { get: async ({ sessionID }: { sessionID: string }) => f.sessions.get(sessionID), create: async (input: any) => {
      const session = { ...input, projectID: "project", location: { directory: f.root } }; f.sessions.set(input.id, session); return session
    }, prompt: async () => {}, synthetic: async () => {} } as never })
  return { ...f, passage, scheduleID, owner, documents, control, location, ctx,
    read: () => run(readNativeRecurrenceCurrent(ctx, { scheduleID, owner })),
    page: (input: unknown, signal?: AbortSignal) => run(readNativeRecurrenceCurrentPage(ctx, input), signal),
    content: (input: unknown) => run(readNativeRecurrenceCurrentContent(ctx, input)),
    metrics: () => ({ ranges, entries }),
  }
}
