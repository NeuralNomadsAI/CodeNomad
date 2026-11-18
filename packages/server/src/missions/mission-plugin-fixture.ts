import { MissionControl } from "./control"
import type { MissionInputTransport, NativeMissionSession } from "./control-types"
import type { MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { controlResumeAdmissionID } from "./receipt-identity"
import { setupMissionsPlugin } from "../opencode/missions-plugin"

export const FIXTURE_PROJECT = { id: "project-1", canonical: "/repo", location: { directory: "/repo" } }

type Tool = { execute(input: unknown, context: unknown): Promise<{ content: string }> }
type Handlers = Record<string, (input: unknown, context?: unknown) => Promise<unknown>>

/** In-memory native storage and sessions, real controls over them, and the real
 * plugin's RPC handlers and `mission_*` tool executors over the same storage. */
export function missionPluginFixture() {
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort().slice(0, limit)
      return { entries: keys.map(key => ({ key, value: structuredClone(values.get(key)!) })), next: keys.length === limit ? keys.at(-1) : undefined }
    },
  }
  const native = new Map<string, NativeMissionSession>()
  let now = 1_000
  /** The bridge's answer to `mission.interrupt`, settable per test. */
  const bridge: { interruptTask?: () => Promise<unknown> } = {}
  const transport: MissionInputTransport = {
    prompt: async () => {}, synthetic: async () => {},
    interruptTask: async () => { if (!bridge.interruptTask) throw new Error("No interrupt reply"); return bridge.interruptTask() },
    lifecycle: async (_, input) => {
      const mission = (await control().snapshot()).missions.find(item => item.id === input.missionID)!
      const action = mission.control!.action, identity = { ...input, action }
      return { nativeAcknowledgement: action === "start" ? { ...identity, disposition: "start-admitted", admission: {
        id: controlResumeAdmissionID(input.operationID, input.sessionID), sessionID: input.sessionID, type: "synthetic", delivery: "queue", time: { created: 100 },
        payload: { text: "Continue existing work", metadata: { "codenomad.mission": { version: 1, missionID: input.missionID, operationID: input.operationID, kind: "lifecycle" } } },
      } } : { ...identity, disposition: "interrupt-observed", interrupt: { interrupted: true }, cancellations: [] } }
    },
    cleanup: async () => ({ outcome: "removed" }),
  }
  const sessions = {
    get: async ({ sessionID }: { sessionID: string }) => { if (!native.has(sessionID)) throw new Error("missing"); return native.get(sessionID)! },
    create: async (input: NativeMissionSession) => { const session = { ...input, projectID: FIXTURE_PROJECT.id }; native.set(session.id, session); return session },
    prompt: async () => { throw new Error("Transport required") }, synthetic: async () => { throw new Error("Transport required") },
  }
  const control = () => new MissionControl({ project: FIXTURE_PROJECT, storage, now: () => now++, transport, sessions: sessions as never })

  /** The real plugin over this storage: its RPC handlers and tool executors. */
  async function plugin() {
    const tools = new Map<string, Tool>()
    let handlers: Handlers | undefined
    const registration = () => ({ dispose: async () => {} })
    const dispose = await setupMissionsPlugin({
      location: { directory: FIXTURE_PROJECT.canonical, project: { id: FIXTURE_PROJECT.id, canonical: FIXTURE_PROJECT.canonical } },
      storage, session: { ...sessions, hook: async () => registration() },
      agent: { list: async () => ({ data: [] }) }, model: { list: async () => ({ data: [] }) },
      tool: { transform: async (callback: (draft: unknown) => void) => {
        callback({ namespace: () => {}, add: (tool: Tool & { name: string }) => tools.set(tool.name, tool) })
        return registration()
      } },
      rpc: { register: async (_definition: unknown, registered: Handlers) => {
        handlers = registered
        return { ...registration(), events: { emit: async () => {} } }
      } },
    } as never, transport)
    return {
      dispose,
      /** One RPC call as the bridge makes it: JSON in, JSON out. */
      rpc: async (method: string, input: unknown) => JSON.parse(JSON.stringify(await handlers![method](JSON.parse(JSON.stringify(input))))),
      /** One `mission_<name>` tool call by `sessionID`: the exact text the model receives and its value. */
      tool: async (name: string, input: unknown, sessionID: string) => {
        const content = (await tools.get(name)!.execute(input, { sessionID, messageID: "msg_fixture", id: `call_${name}`, progress: async () => {} })).content
        return { content, value: JSON.parse(content) }
      },
    }
  }
  return { values, storage, native, bridge, control, plugin, setNow: (value: number) => { now = value } }
}
