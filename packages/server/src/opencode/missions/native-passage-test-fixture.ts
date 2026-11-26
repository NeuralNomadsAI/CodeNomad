import path from "node:path"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import type { MissionConfiguration } from "../../missions/launch-policy"
import type { MissionDocument } from "../../missions/mission-document"
import { missionDocumentPassage } from "../../missions/mission-document-passage-storage"
import type { documentPassageStartInput } from "../../missions/mission-document-passage-input"
import type { MissionControl } from "../../missions/control"
import type { MissionStorage } from "../../missions/journal"
import type { MissionJsonValue } from "../../missions/model"
import type { NativeMissionSession } from "../../missions/control-types"
import type { MissionNativeService } from "./native-service-adapter"
import type { PassageSessionObservation } from "./native-passage-observation"
import { admitNativeScheduledPassage } from "./native-scheduled-passage-admission"
import { nativeScheduledPassageBusiness, type NativeScheduledPassageContext } from "./native-scheduled-passage-business"
import { observeNativeScheduledPassage } from "./native-scheduled-passage-settlement"

const current = () => true as const, at = Date.parse("2026-10-01T00:00:00Z")

/** One running schedule ("schedule") holding a reserved manual passage, over scripted
 * native sessions. `start` admits it through the real admission, `finish` reports
 * through the real passage business and `observe` runs the real settlement. */
export async function passageFixture() {
  // A native absolute path that is never created: on Windows it keeps its backslashes.
  const root = path.resolve("passage-unit-project")
  const values = new Map<string, MissionJsonValue>(), sessions = new Map<string, NativeMissionSession>()
  const states = new Map<string, PassageSessionObservation>(), messages = new Map<string, unknown>()
  let creates = 0, sends = 0, environments = 0, pendingForm = false
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value, guard) => { guard?.(); values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const all = [...values].filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      const entries = all.slice(0, limit).map(([key, value]) => ({ key, value: structuredClone(value) }))
      return { entries, ...(all.length > limit ? { next: entries.at(-1)!.key } : {}) }
    },
  }
  const store = new NativeMissionDocumentStore({ get: storage.get, compareAndSet: async (key, value, revision, guard) => {
    guard()
    if (((values.get(key) as { revision: number } | undefined)?.revision ?? null) !== revision) throw new Error("Fixture revision conflict")
    values.set(key, structuredClone(value))
  } }, "project", root)
  const selection = { agent: "build", model: { providerID: "unit", id: "model" } }
  const config: MissionConfiguration = { title: "Unit passage", objective: "Do bounded work and finish through mission_report.",
    template: "custom", taskMode: "native", profileID: "profile", executionHost: "local",
    roots: [{ mode: "directory-only", directory: root }], watchedConversationIDs: [],
    profiles: { coordinator: selection, roles: { specialist: selection } },
    launch: { timing: { kind: "every", intervalMs: 900_000 }, condition: null, ends: { maxLaunches: 3, at: null, afterMs: null } } }
  const created = await store.create("schedule", config, at, current)
  const reserved = await store.change(created.id, created.revision, current, next => {
    changes.play(next, "play", at, [])
    changes.synchronized(next, "play", (["principal", "reconciliation"] as const).map(role => ({ role, slot: 0, timeGeneration: 1,
      scheduleID: `sch_${role}`, sessionID: `ses_${role}`, highWater: 0, pendingWake: null, wakePreparing: null })))
    changes.reserve(next, { kind: "manual", requestID: "unit-wake" }, at, [])
  })
  const passage = missionDocumentPassage(storage, reserved, current)
  const location = { directory: root, project: { id: "project", canonical: root, directory: root } }
  const native = {
    location, assertCurrent: current,
    get: async ({ sessionID }: { sessionID: string }) => {
      const session = sessions.get(sessionID); if (!session) throw new Error("Missing session"); return structuredClone(session)
    },
    create: async (input: { id: string; agent: string; model: NativeMissionSession["model"]; metadata: NativeMissionSession["metadata"] }, _options: unknown, guard: () => true) => {
      guard(); creates++
      const session = { ...input, projectID: "project", location: { directory: root } }
      sessions.set(input.id, session)
      states.set(input.id, { id: input.id, projectID: "project", directory: root, active: false, inbox: 0,
        suspended: false, runningTools: 0, failed: false, messagePresent: false })
      return session
    },
    inbox: async () => [],
    message: async ({ messageID }: { messageID: string }) => messages.get(messageID),
    environment: async (_input: unknown, _options: unknown, guard: () => true) => { guard(); environments++ },
    admit: async ({ input }: { input: ReturnType<typeof documentPassageStartInput> }, _options: unknown, guard: () => true) => {
      guard(); sends++
      messages.set(input.id, { type: "synthetic", id: input.id, text: input.text, metadata: input.metadata })
      // Scripted native turns complete at once and expose their durable input/idle correlation.
      states.get(input.sessionID)!.terminal ??= { inputMessageID: input.id, messageID: `idle_${input.id}`, outcome: "succeeded" }
      return { type: "synthetic", id: input.id, sessionID: input.sessionID, delivery: input.delivery,
        payload: { text: input.text, description: input.description, metadata: input.metadata } }
    },
  } as unknown as MissionNativeService
  const observation: NativeScheduledPassageContext["observation"] = {
    assertCurrent: current, exists: async id => sessions.has(id),
    session: async (id, messageID) => {
      const state = states.get(id); if (!state) throw new Error("Missing session")
      return { ...structuredClone(state), messagePresent: messageID === undefined ? state.messagePresent : messages.has(messageID) }
    },
    children: async id => [...sessions.values()].filter(session => session.parentID === id).map(session => session.id),
    requests: async () => pendingForm,
  }
  const read = async (): Promise<MissionDocument> => {
    const doc = await store.read("schedule"); if (!doc || "deletedAt" in doc) throw new Error("Fixture schedule missing"); return doc
  }
  const use = <T>(callback: (input: NativeScheduledPassageContext) => Promise<T>, observed = observation) => store.withExclusion(async locked => callback({
    document: await read(), locked, storage, native, observation: observed, authority: () => locked.assertActive(),
    profile: { profileID: "profile", executionHost: "local", configYamlPath: "unused-isolated-profile" },
    signal: new AbortController().signal, current, now: () => at + 1000, environment: async () => ({ PASSAGE_UNIT: "frozen" }) }))
  const business = <T>(callback: (control: MissionControl) => Promise<T>) => use(input => callback(nativeScheduledPassageBusiness(input).control))
  return { root, at, store, document: read, storage, passage, observation, sessions, states, business,
    async start() {
      const result = await use(admitNativeScheduledPassage)
      if (result.kind !== "admitted") throw new Error(`Fixture passage ${result.kind}`)
      const doc = await read()
      return store.change(doc.id, doc.revision, current, next => changes.admitted(next, result.passageID, result.at))
    },
    finish: (outcome: "completed" | "failed" = "completed") => business(control => control.report(passage.coordinatorSessionID,
      { missionID: passage.missionID, outcome, summary: "Finished through the passage business", final: true, evidence: [], next: [] })),
    observe: (observed = observation) => use(observeNativeScheduledPassage, observed),
    set pendingForm(value: boolean) { pendingForm = value },
    counts: () => ({ creates, sends, environments }) }
}
