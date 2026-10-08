import path from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"
import { recurrenceConfigSchema, type RecurrenceConfig } from "../../missions/recurrence-contract"
import { recurrencePassage } from "../../missions/recurrence-passage"
import type { MissionStorage } from "../../missions/journal"
import type { MissionJsonValue } from "../../missions/model"
import type { MissionNativeService } from "./native-service-adapter"
import type { NativeMissionSession } from "../../missions/control-types"
import type { NativePassageObservation, PassageSessionObservation } from "./native-passage-observation"
import { admitNativeRecurrencePassage, type PassageInput } from "./native-recurrence-admission"
import { setupMissionsBusiness, type MissionsPluginContext } from "../missions-plugin"
import { selectNativePassageBusiness, retireNativePassageBusiness } from "./native-passage-business"

export async function passageFixture(business = true) {
  const root = await mkdtemp(path.join("C:/Users/Admin/AppData/Local/Temp/opencode", "passage-unit-"))
  const configYamlPath = path.join(root, "config.yaml")
  await writeFile(configYamlPath, "server:\n  environmentVariables:\n    PASSAGE_UNIT: frozen\n")
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value, current) => { current?.(); values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const all = [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after)).sort(([a], [b]) => a.localeCompare(b))
      const entries = all.slice(0, limit).map(([key, value]) => ({ key, value: structuredClone(value) }))
      return { entries, ...(all.length > limit ? { next: entries.at(-1)!.key } : {}) }
    },
  }
  const calendar = new NativeMissionRecurrenceStore(storage, "project", root)
  const config = { title: "Unit passage", consigne: "Do bounded work and finish through mission_report.",
    clock: { zone: "UTC", time: "23:59" }, template: "custom", profileID: "profile", executionHost: "local",
    profiles: { coordinator: { agent: "build", model: { providerID: "unit", id: "model" } },
      roles: { specialist: { agent: "build", model: { providerID: "unit", id: "model" } } } }, taskMode: "native",
    roots: [{ mode: "directory-only", directory: root }], watchedConversationIDs: [] }
  // Compile/test shim only: this front's base still has the old schedule codec.
  const simple = recurrenceConfigSchema.safeParse(config)
  const legacy = { ...config, budgets: { effects: 64, nativeCalls: 32, inboxMessages: 256, publications: 0 },
    publication: { policy: "disabled", conversationIDs: [] } }
  delete (legacy as Partial<typeof config>).title
  const parsed = (simple.success ? simple.data : recurrenceConfigSchema.parse(legacy)) as RecurrenceConfig
  const paused = await calendar.create("schedule", parsed, 10, () => true)
  const created = await calendar.setState("schedule", paused.revision, "running", () => true)
  let doc = await calendar.reserve("schedule", created.revision, { kind: "manual", requestID: "unit-wake", expectedRevision: created.revision, at: 10 }, 10, () => true)
  const passage = recurrencePassage(storage, doc, () => true, () => 20)
  const sessions = new Map<string, NativeMissionSession>()
  const states = new Map<string, PassageSessionObservation>()
  const messages = new Set<string>()
  let creates = 0, sends = 0, environments = 0, pendingForm = false, crashAfterSend = false
  const location = { directory: root, project: { id: "project", canonical: root, directory: root } }
  const observation: NativePassageObservation = {
    assertCurrent: () => true,
    assertScheduleCurrent: () => true,
    assertQuiescent: () => true,
    exists: async id => sessions.has(id),
    session: async (id, messageID) => { const state = states.get(id); if (!state) throw new Error("Missing session")
      return { ...structuredClone(state), messagePresent: messageID === undefined ? state.messagePresent : messages.has(`${id}\0${messageID}`) } },
    children: async id => [...sessions.values()].filter(session => session.parentID === id).map(session => session.id),
    requests: async () => pendingForm,
  }
  const native = {
    location, assertCurrent: () => true,
    get: async ({ sessionID }: { sessionID: string }) => { const session = sessions.get(sessionID); if (!session) throw new Error("Missing session"); return structuredClone(session) },
    create: async (input: { id: string; agent: string; model: NativeMissionSession["model"]; metadata: NativeMissionSession["metadata"]; title: string }) => {
      creates++
      const session = { ...input, projectID: "project", location: { directory: root } }
      sessions.set(input.id, session)
      states.set(input.id, { id: input.id, projectID: "project", directory: root, active: false, inbox: 0, pending: 0,
        suspended: false, runningTools: 0, failed: false, messagePresent: false })
      return session
    },
    environment: async (input: { variables: Record<string, string> }) => {
      if (input.variables.PASSAGE_UNIT !== "frozen") throw new Error("Profile ENV missing")
      environments++
    },
    admit: async (command: { input: { sessionID: string; id: string } }) => {
      sends++
      messages.add(`${command.input.sessionID}\0${command.input.id}`)
      states.get(command.input.sessionID)!.messagePresent = true
      if (crashAfterSend) { crashAfterSend = false; throw new Error("Crash after native admission") }
      return { id: command.input.id }
    },
  } as unknown as MissionNativeService
  const input = async (): Promise<PassageInput> => ({ document: (await calendar.read(doc.id))!, storage, native, observation,
    profile: { profileID: "profile", executionHost: "local", configYamlPath }, signal: new AbortController().signal,
    current: () => true, read: () => calendar.read(doc.id), now: () => 20 })
  // Manual fixture pending predates explicit Play; make the schedule running
  // using its ordinary store control before reserving in production tests.
  const tools = new Map<string, { execute(input: unknown, context: { sessionID: string; messageID: string; id: string; progress(update: Record<string, unknown>): Promise<void> }): Promise<{ content: string }> }>()
  const context = { location, storage: { ...storage, remove: async () => {} }, session: { get: native.get,
    hook: async () => ({ dispose: async () => {} }) }, tool: { transform: async (callback: (draft: unknown) => void) => {
      callback({ namespace: () => {}, add: (tool: { name: string }) => tools.set(tool.name, tool as never) })
      return { dispose: async () => {} }
    } } } as unknown as MissionsPluginContext
  const disposeTools = business ? await setupMissionsBusiness(context, id => selectNativePassageBusiness(context, id)) : async () => {}
  return { root, calendar, passage, storage, observation, sessions, states, input, tools, context,
    async start() { const ack = await admitNativeRecurrencePassage(await input()); doc = await calendar.recordAdmission(doc.id, ack, 20, () => true); return doc },
    async finish() { return tools.get("report")!.execute({ final: true, outcome: "completed", summary: "Finished via real mission tool", evidence: [], next: [] },
      { sessionID: passage.coordinatorSessionID, messageID: "msg_report", id: "call_report", progress: async () => {} }) },
    set pendingForm(value: boolean) { pendingForm = value }, set crashAfterSend(value: boolean) { crashAfterSend = value },
    counts: () => ({ creates, sends, environments }),
    async dispose() { await disposeTools(); retireNativePassageBusiness(location); await rm(root, { recursive: true, force: true }) } }
}
