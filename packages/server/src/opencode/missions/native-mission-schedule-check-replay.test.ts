import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { controlNativeMissionSchedule } from "./native-mission-schedule-control"
import { nativeMissionScheduleControlExecution } from "./native-mission-schedule-authority"
import { nativeMissionScheduleResult } from "./native-mission-schedule-result"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { missionDocumentPassage } from "../../missions/mission-document-passage-storage"
import { controlOperationID, controlReceiptID } from "../../missions/receipt-identity"
import { missionActorResumeInput } from "../../missions/native-actor-lifecycle"
import type { MissionStorage } from "../../missions/journal"

for (const action of ["pause", "stop", "play", "resume"] as const) {
  for (const linked of [true, false]) {
    for (const principal of [{ kind: "human" as const, sessionID: "cookie" },
      { kind: "agent" as const, author: { coordinatorSessionID: "ses_agent" } }]) {
      test(`${principal.kind} Check replay resolves ${linked ? "linked" : "latest"} ${action} actor proof before read-only completion`, async t => {
        const f = await ownerFixture(t)
        await f.control("play")
        let doc = await f.read()
        doc = await f.store.change(doc.id, doc.revision, f.current, value => {
          changes.reserve(value, { kind: "manual", requestID: "manual_original" }, f.now + 1, [])
          changes.admitted(value, value.pending!.id, f.now + 2)
        })
        f.advance(3)
        f.allowPendingResume()
        const original = { missionID: doc.id, requestID: "actor_original", expectedRevision: doc.revision, action }
        if (linked) await f.owner.prepareControl(original)
        else await f.owner.control(original)
        doc = await f.read()
        const input = { missionID: doc.id, requestID: "check_original", expectedRevision: doc.revision, action: "check" as const }
        doc = await f.owner.control(input)
        assert.equal(doc.calendarOwner!.operation.pending, false, "calendar proof is complete")
        assert.equal(doc.calendarOwner!.checks.some(check => check.requestID === input.requestID), linked)

        const storage: MissionStorage = {
          get: async key => structuredClone(f.values.get(key)),
          set: async (key, value, current) => { current?.(); f.values.set(key, structuredClone(value)) },
          scan: async ({ prefix, after, limit = 100 }) => {
            const keys = [...f.values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort()
            const page = keys.slice(0, limit)
            return { entries: page.map(key => ({ key, value: structuredClone(f.values.get(key)!) })),
              ...(keys.length > limit ? { next: page.at(-1) } : {}) }
          },
        }
        const ctx = { ...f.ctx, storage: { ...f.ctx.storage,
          scan: (input: Parameters<MissionStorage["scan"]>[0]) => Effect.promise(() => storage.scan(input)) } }
        const read = () => nativeMissionScheduleResult(ctx, doc, Effect.runPromise, false, input.requestID)
        const replay = (control = input as typeof input | typeof original) => {
          const request = { ...control, transport: { principal, issuedAt: Date.now() } }
          return Effect.runPromise(controlNativeMissionSchedule(ctx, {
            request, before: doc, store: f.store, ...nativeMissionScheduleControlExecution(request as never, f.current),
          } as never, undefined, Effect.runPromise).pipe(Effect.scoped))
        }
        const saved = structuredClone([...f.values])
        assert.equal((await read()).pending, true, "missing original actor receipt stays unknown")
        assert.deepEqual([...f.values], saved, "status reads never reconcile")
        // The fixture has no native service graph: recovery reaches acquisition
        // instead of returning the calendar-only receipt as confirmed.
        await assert.rejects(replay())
        await assert.rejects(replay(original))
        assert.deepEqual([...f.values], saved)

        const passage = missionDocumentPassage(storage, doc, f.current)
        const base = { version: 1 as const, projectID: doc.projectID, missionID: passage.missionID }
        await passage.journal.append({ ...base, id: "evt_created", createdAt: f.now - 2, type: "mission.created",
          projectCanonical: doc.projectCanonical, objective: "Actor proof", template: "custom",
          coordinator: { sessionID: passage.coordinatorSessionID, title: "Coordinator", location: { directory: f.directory } } })
        const actorAction = action === "play" || action === "resume" ? "start" : action
        const operationID = controlOperationID(passage.missionID, original.requestID)
        await passage.journal.append({ ...base, id: operationID, createdAt: f.now, type: "mission.control-requested",
          requestID: original.requestID, expectedRevision: 1, action: actorAction,
          targets: [{ sessionID: passage.coordinatorSessionID, location: { directory: f.directory } }] })
        assert.equal((await read()).pending, true, "partial actor receipt stays unknown")
        await assert.rejects(replay())
        await assert.rejects(replay(original))
        const resume = missionActorResumeInput(passage.missionID, operationID, passage.coordinatorSessionID, passage.coordinatorSessionID, "")
        const identity = { missionID: passage.missionID, operationID, sessionID: passage.coordinatorSessionID }
        await passage.journal.append({ ...base, id: controlReceiptID(operationID, passage.coordinatorSessionID),
          createdAt: f.now + 1, type: "mission.control-applied", operationID, sessionID: passage.coordinatorSessionID,
          nativeAcknowledgement: actorAction === "start" ? { ...identity, action: actorAction, disposition: "start-admitted",
            admission: { id: resume.id, sessionID: resume.sessionID, type: "synthetic", delivery: "queue", time: { created: f.now + 1 },
              payload: { text: resume.text, metadata: resume.metadata } } }
            : { ...identity, action: actorAction, disposition: "interrupt-observed", interrupt: { interrupted: true }, cancellations: [] } })
        const snapshot = await passage.journal.snapshot()
        assert.equal(snapshot.discardedEvents, 0)
        assert.ok(!snapshot.controlUnavailable)
        assert.deepEqual(snapshot.missions[0].control?.pending, [])
        const complete = structuredClone([...f.values]), calls = [...f.calls]
        const result = await replay()
        assert.equal(result.pending, false)
        assert.equal(result.document?.control?.requestID, input.requestID, "public receipt keeps Check identity")
        assert.equal(result.document?.control?.action, "check")
        assert.equal(result.document?.revision, doc.revision)
        assert.deepEqual([...f.values], complete, "proven replay writes neither journal nor document")
        assert.deepEqual(f.calls, calls, "proven replay sends no calendar effects")
        assert.equal((await replay(original)).pending, false, "original actor control also replays read-only")
        assert.deepEqual([...f.values], complete)
        assert.deepEqual(f.calls, calls)
      })
    }
  }
}
