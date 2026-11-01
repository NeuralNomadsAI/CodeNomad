import assert from "node:assert/strict"
import { MissionControl } from "./control"
import type { NativeMissionSession } from "./control-types"
import type { MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { NativeMissionDocumentStore, type MissionDocumentStorage } from "./mission-document-store"
import { missionActorResumeInput } from "./native-actor-lifecycle"
import type { MissionPreparationNative } from "./mission-preparation"
import type { MissionDocumentSources } from "./mission-document-one-time"
import type { MissionNativeAcknowledgement } from "./lifecycle-model"
import { prepareNativeDocumentSources } from "../opencode/missions/native-scheduled-passage-sources"
import type { MissionNativeService } from "../opencode/missions/native-service-adapter"

export async function preparationFixture(directory = "/fixture", sources?: MissionDocumentSources) {
  const values = new Map<string, MissionJsonValue>(), sessions = new Map<string, NativeMissionSession>()
  const occupied = new Set<string>(), admissions: Array<{ sessionID: string; text: string; profile: NativeMissionSession }> = []
  const acknowledged = new Map<string, MissionNativeAcknowledgement>()
  let fault = "", created = 0
  const storage: MissionStorage & MissionDocumentStorage = {
    get: async key => structuredClone(values.get(key)),
    remove: async key => { values.delete(key) },
    set: async (key, value, guard) => {
      guard?.()
      const preparation = value && typeof value === "object" && "type" in value && value.type === "mission.prepared"
      if (preparation && fault === "journal-before") { fault = ""; throw new Error("journal-before") }
      values.set(key, structuredClone(value))
      if (preparation && fault === "journal-after") { fault = ""; throw new Error("journal-after") }
    },
    scan: async ({ prefix, after, limit = 100 }) => {
      const rows = [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after)).sort(([a], [b]) => a < b ? -1 : 1)
      const entries = rows.slice(0, limit).map(([key, value]) => ({ key, value: structuredClone(value) }))
      return { entries, ...(rows.length > limit ? { next: entries.at(-1)!.key } : {}) }
    },
    compareAndSet: async (key, value, expected, guard) => {
      guard()
      assert.equal((values.get(key) as { revision?: number } | undefined)?.revision ?? null, expected)
      const preparation = (value && typeof value === "object" && "preparation" in value ? value.preparation : undefined) as { attempted?: boolean; pending?: boolean } | undefined
      if (preparation?.pending === false && fault === "document-before") { fault = ""; throw new Error("document-before") }
      values.set(key, structuredClone(value))
      if (preparation?.pending === false && fault === "document-after") { fault = ""; throw new Error("document-after") }
    },
  }
  const store = new NativeMissionDocumentStore(storage, "project", directory)
  const control: MissionControl = new MissionControl({ project: { id: "project", canonical: directory, location: { directory } }, storage,
    documents: use => use(store, sources), documentReads: use => use(store),
    sessions: { get: async ({ sessionID }) => { const value = sessions.get(sessionID); assert.ok(value); return structuredClone(value) },
      create: async input => {
        created++
        const value = { ...structuredClone(input), projectID: "project", agent: input.agent ?? "default-agent",
          model: input.model ?? { providerID: "default", id: "default" } }
        sessions.set(input.id, value)
        if (fault === "native-after") { fault = ""; throw new Error("native-after") }
        return value
      }, prompt: async () => assert.fail("No preparation prompt"), synthetic: async () => assert.fail("Use lifecycle transport") },
    transport: { prompt: async () => assert.fail("Unexpected prompt"), synthetic: async () => assert.fail("Unexpected synthetic"),
      lifecycle: async (coordinator, input) => {
        const mission = (await control.snapshot()).missions.find(item => item.id === input.missionID)!, operation = mission.control!
        assert.equal(coordinator, mission.coordinatorSessionId)
        const route = missionActorResumeInput(mission.id, operation.id, input.sessionID, coordinator)
        let ack = acknowledged.get(route.id)
        if (!ack) {
          const text = input.startText ?? route.text
          admissions.push({ sessionID: input.sessionID, text, profile: structuredClone(sessions.get(input.sessionID)!) }); occupied.add(input.sessionID)
          ack = { missionID: mission.id, operationID: operation.id, sessionID: input.sessionID, action: "start", disposition: "start-admitted",
            admission: { id: route.id, sessionID: route.sessionID, type: "synthetic", delivery: "queue", time: { created: Date.now() }, payload: { text, metadata: route.metadata } } }
          acknowledged.set(route.id, ack)
        }
        if (fault === "admission-after") { fault = ""; throw new Error("lost admission ACK") }
        return { nativeAcknowledgement: ack }
      } },
  })
  const native: MissionPreparationNative = { read: async id => structuredClone(sessions.get(id)), empty: async session => {
    const check = (): true => { if (occupied.has(session.id)) throw new Error("coordinator not empty"); return true }
    check(); return check
  } }
  const creation = { requestID: "preparation_original", objective: "Original instructions", template: "custom" as const }
  const mission = (await control.create(creation)).mission
  const read = async () => { const doc = await store.read(mission.id); assert.ok(doc && !("deletedAt" in doc)); return doc }
  const original = await read()
  const configuration = { ...original.configuration, title: "Edited title", objective: "Edited instructions", notes: "Edited notes",
    template: "delivery" as const, taskMode: "independent" as const,
    profiles: { coordinator: { agent: "coordinator", model: { providerID: "p", id: "m", variant: "precise" } },
      roles: { developer: { agent: "worker", model: { providerID: "p", id: "m", variant: "fast" } } } } }
  const request = { missionID: mission.id, requestID: "preparation_edit", expectedRevision: original.revision, configuration }
  return { control, store, storage, read, mission, original, creation, native, request, values, sessions, occupied, admissions,
    get created() { return created }, fail: (at: string) => { fault = at } }
}

export function scheduledPreparation(f: Awaited<ReturnType<typeof preparationFixture>>,
  timing: import("./launch-policy").MissionLaunchPolicy["timing"] = { kind: "every", intervalMs: 900000 }): import("./launch-policy").MissionConfiguration {
  const selection = f.request.configuration.profiles.coordinator
  return { ...f.request.configuration, template: "custom", profiles: { coordinator: selection, roles: { specialist: selection } },
    profileID: "profile", executionHost: "host", launch: { ...f.request.configuration.launch, timing } }
}

/** Production source composition, with bounded native transport observations. */
export async function followedPreparationFixture(directory = "/fixture") {
  const source: NativeMissionSession = { id: "ses_followed", projectID: "project", location: { directory } }
  const messages = [{ id: "msg_reference", type: "user", text: "Context present at Play", nativeDigest: "a".repeat(64) }]
  let reads = 0, available = true
  const service = {
    assertCurrent: () => true,
    get: async ({ sessionID }: { sessionID: string }) => { assert.equal(sessionID, source.id); return structuredClone(source) },
    sourceBaseline: async () => assert.fail("Immediate Play reads context, not a future-event baseline"),
    sourceMessages: async (input: Parameters<MissionNativeService["sourceMessages"]>[0]) => {
      reads++; if (!available) throw new Error("Source read unavailable")
      assert.equal(input.afterMessageID, null); assert.equal(input.limit, 32); assert.equal(input.excludeTechnical, true)
      assert.ok(input.contextLimit <= 16384)
      return structuredClone(messages.slice(0, input.limit))
    },
  } as unknown as MissionNativeService
  const f = await preparationFixture(directory, (doc, current) => prepareNativeDocumentSources(doc, service,
    new AbortController().signal, current, undefined, undefined, true))
  return { ...f, source, messages, get reads() { return reads }, available: (value: boolean) => { available = value } }
}
