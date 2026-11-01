// Qualification only: production readers and storage, with explicit fixture controls.
import { Plugin, Rpc } from "@opencode/plugin/effect"
import { Cause, Effect, Scope } from "effect"
import { appendFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { acquireNativeMissionDocumentStore } from "../../packages/server/src/opencode/missions/native-mission-document-storage"
import { acquireMissionNativeService } from "../../packages/server/src/opencode/missions/native-service-adapter"
import { acquireNativeMissionConditionReader } from "../../packages/server/src/opencode/missions/native-mission-condition-reader"
import { acquireNativeSourceFence } from "../../packages/server/src/opencode/missions/native-source-fence"
import { prepareNativeDocumentSources } from "../../packages/server/src/opencode/missions/native-scheduled-passage-sources"
import { nativeInvocation } from "../../packages/server/src/opencode/missions/native-invocation"
import { missionDocumentChanges as changes } from "../../packages/server/src/missions/mission-document-state"
import { missionDocumentPassage } from "../../packages/server/src/missions/mission-document-passage-storage"
import type { MissionConfiguration } from "../../packages/server/src/missions/launch-policy"
import type { MissionDocument } from "../../packages/server/src/missions/mission-document"

const method = { input: { type: "object" }, output: { type: "object" } } as const
export const EventReaderRpc = Rpc.define({ id: "codenomad.event-readers-qualification", methods: { initialize: method, read: method,
  begin: method, complete: method, reserve: method, settle: method, edit: method, race: method }, events: {} })

export default Plugin.define({ id: "codenomad.missions", effect: ctx => Effect.gen(function* () {
  const invocation = nativeInvocation(30_000), current = () => true as const
  const handle = (action: string) => (raw: unknown) => invocation.capture(Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const input = raw as { id: string; conversationID?: string; extraDirectory?: string; completed?: boolean; condition?: MissionConfiguration["launch"]["condition"] }
    return yield* Effect.tryPromise(() => invocation.check(async run => {
      const store = await run(acquireNativeMissionDocumentStore(ctx, run))
      const native = await run(acquireMissionNativeService(current, run).pipe(Effect.provideService(Scope.Scope, scope)))
      const signal = new AbortController().signal
      const reader = await run(acquireNativeMissionConditionReader(ctx, store, run, signal, current).pipe(Effect.provideService(Scope.Scope, scope)))
      const fence = await run(acquireNativeSourceFence(current))
      const storage = { get: key => run(ctx.storage.get(key)), set: (key, value) => run(ctx.storage.set(key, value)), scan: value => run(ctx.storage.scan(value)) }
      const config = (): MissionConfiguration => {
        const selected = { agent: "build", model: { providerID: "fixture", id: "fixture" } }
        return { title: "Native sources", objective: "Fixture bounded source observation", template: "custom", taskMode: "native",
          profileID: "fixture", executionHost: "host", roots: [{ mode: "directory-only", directory: ctx.location.directory },
            ...(input.extraDirectory ? [{ mode: "directory-only" as const, directory: input.extraDirectory }] : [])],
          watchedConversationIDs: [], profiles: { coordinator: selected, roles: { specialist: selected } },
          launch: { timing: { kind: "every", intervalMs: 900_000 }, condition: null, ends: { maxLaunches: null, afterMs: null, at: null } } }
      }
      const snapshot = (doc: MissionDocument) => prepareNativeDocumentSources(doc, native, signal, current, reader, fence())
      return store.withExclusion(async locked => {
        const read = async id => {
          const doc = await locked.read(id)
          if (!doc || "deletedAt" in doc) throw new Error("Fixture source missing")
          return doc
        }
        if (action === "initialize") {
          for (const id of ["source_recurring", "source_once"]) {
            const configuration = config()
            if (id === "source_once") { configuration.launch.timing = { kind: "immediate" }; configuration.roots.reverse() }
            const doc = await locked.create(id, configuration, Date.now(), current)
            await locked.change(id, doc.revision, current, next => { changes.play(next, `play_${id}`, Date.now(), []); next.synchronization = null })
          }
          const conditions = [{ kind: "schedule-success", missionID: "source_recurring" }, { kind: "mission-completed", missionID: "source_once" },
            { kind: "branch-commits", directory: ctx.location.directory, ref: "refs/heads/selected" },
            { kind: "conversation-message", conversationID: input.conversationID }, { kind: "files-changed", paths: ["included.txt"] }] as MissionConfiguration["launch"]["condition"][]
          for (const condition of conditions) {
            const configuration = config(); configuration.launch.condition = condition
            const doc = await locked.create(`target_${condition!.kind}`, configuration, Date.now(), current)
            const proof = await snapshot(doc)
            await locked.change(doc.id, doc.revision, proof.current, next => { changes.play(next, `play_${doc.id}`, Date.now(), proof.checkpoints); next.synchronization = null }, proof.revalidate)
          }
          return { initialized: true }
        }
        let doc = await read(input.id)
        if (action === "read") { const result = await snapshot(doc); return { changed: result.changed, checkpoints: result.checkpoints } }
        if (action === "race") {
          const proof = await snapshot(doc)
          writeFileSync(path.join(ctx.location.directory, "included.txt"), "changed between read and CAS")
          let refused = false
          try { await locked.change(doc.id, doc.revision, proof.current, next => { next.checkpoints = proof.checkpoints }, proof.revalidate) } catch { refused = true }
          return { refused, revisionUnchanged: (await read(doc.id)).revision === doc.revision }
        }
        if (action === "edit") {
          const candidate = { ...doc, configuration: { ...doc.configuration, launch: { ...doc.configuration.launch, condition: input.condition ?? null } } }
          const proof = await snapshot(candidate)
          doc = await locked.change(doc.id, doc.revision, proof.current, next => changes.configure(next, candidate.configuration, Date.now(), proof.checkpoints), proof.revalidate)
          return { revision: doc.revision }
        }
        if (action === "reserve") {
          const proof = await snapshot(doc)
          doc = await locked.change(doc.id, doc.revision, proof.current, next => changes.reserve(next, { kind: "manual", requestID: `fixture_${doc.revision}` }, Date.now(), proof.checkpoints), proof.revalidate)
          return { pending: doc.pending }
        }
        if (action === "settle") {
          doc = await locked.change(doc.id, doc.revision, current, next => { changes.admitted(next, next.pending!.id, Date.now()); changes.settle(next, next.pending!.id, input.completed ? "completed" : "failed", Date.now()) })
          return { checkpoints: doc.checkpoints, blocked: doc.blocked }
        }
        if (action === "begin") {
          doc = await locked.change(doc.id, doc.revision, current, next => changes.reserve(next, { kind: "manual", requestID: `source_${doc.revision}` }, Date.now(), []))
          const pending = doc.pending!, passage = missionDocumentPassage(storage, doc, current)
          const directory = doc.configuration.roots[0].directory
          await native.create({ id: pending.coordinatorSessionID, title: "Explicit fixture source", location: { directory },
            agent: "build", model: { providerID: "fixture", id: "fixture" }, metadata: {} }, { signal }, current)
          await passage.journal.append({ version: 1, id: `created_${doc.revision}`, projectID: doc.projectID, projectCanonical: doc.projectCanonical,
            missionID: pending.missionID, createdAt: Date.now(), type: "mission.created", objective: "Explicit source", template: "custom",
            coordinator: { sessionID: pending.coordinatorSessionID, title: "Source", location: { directory } } })
          await native.admit({ kind: "prompt", input: { id: pending.messageID, sessionID: pending.coordinatorSessionID, text: "Say fixture answer",
            delivery: "queue", resume: true } }, { signal }, current)
          return { sessionID: pending.coordinatorSessionID }
        }
        if (action === "complete") {
          const passage = missionDocumentPassage(storage, doc, current)
          await passage.journal.append({ version: 1, id: `finished_${doc.revision}`, projectID: doc.projectID, missionID: doc.pending!.missionID,
            createdAt: Date.now(), type: "mission.finished", outcome: "completed", summary: "Explicit fixture completion" })
          doc = await locked.change(doc.id, doc.revision, current, next => { changes.admitted(next, next.pending!.id, Date.now()); changes.settle(next, next.pending!.id, "completed", Date.now()) })
          return { count: doc.successfulCount }
        }
        throw new Error("Fixture action unavailable")
      })
    })).pipe(Effect.orDie)
  }).pipe(Effect.tapCause(cause => Effect.sync(() => appendFileSync(path.join(ctx.location.directory, "fixture-errors.log"), `${action}: ${Cause.pretty(cause)}\n`)))))
  yield* ctx.rpc.register(EventReaderRpc, Object.fromEntries(["initialize", "read", "begin", "complete", "reserve", "settle", "edit", "race"].map(action => [action, handle(action)])))
}) })
