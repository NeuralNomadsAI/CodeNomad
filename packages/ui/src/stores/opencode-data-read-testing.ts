import { applyOpenCodeDataEvent, destroyOpenCodeData } from "./opencode-data.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { getRootClient } from "./opencode-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"

const model = { providerID: "provider", id: "model" }
const sessionId = "session"

/** Stubs the authoritative session endpoints; message.list comes from the caller. */
export function stubAuthoritativeSession(client: any, messages: () => Promise<any>) {
  client.session.get = async () => ({
    id: sessionId, title: sessionId, projectID: "project", location: { directory: "/work" },
    time: { created: 1, updated: 1 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  client.session.active = async () => ({})
  client.session.inbox = { list: async () => [] }
  client.permission.list = async () => []
  client.session.form.list = async () => []
  client.message.list = messages
}

export const assistantRow = (id: string, text?: string, created = 100): Record<string, unknown> => ({
  id, type: "assistant", agent: "build", model,
  content: text === undefined ? [] : [{ type: "text", text }],
  time: { created },
})

export const textOf = (data: ReturnType<typeof applyOpenCodeDataEvent>, messageId: string): string => {
  const row: any = data.session.message.get(sessionId, messageId)
  return String(row?.content?.find((part: any) => part.type === "text")?.text ?? "")
}

/** Arms one live assistant row whose projected text already holds its base. */
export function armLive(instanceId: string, base = "base") {
  const baseData = { sessionID: sessionId, assistantMessageID: "live" }
  let data = applyOpenCodeDataEvent(instanceId, "/work", {
    id: "step", type: "session.step.started", created: 1, data: { ...baseData, agent: "build", model },
  } as any)
  data = applyOpenCodeDataEvent(instanceId, "/work", {
    id: "text", type: "session.text.started", created: 2, data: { ...baseData },
  } as any)
  data = applyOpenCodeDataEvent(instanceId, "/work", {
    id: "base", type: "session.text.delta", created: 3, data: { ...baseData, ordinal: 0, delta: base },
  } as any)
  return data
}

export const deltaDuring = (instanceId: string, ordinal: string | number, delta = "X", target = "live") =>
  applyOpenCodeDataEvent(instanceId, "/work", {
    id: `delta-${ordinal}`, type: "session.text.delta", created: 1000 + Number(ordinal),
    data: { sessionID: sessionId, assistantMessageID: target, ordinal: 0, delta },
  } as any)

/** Client stub plus connected SSE status for one read fixture. */
export function readFixture(instanceId: string, messages: () => Promise<any>) {
  const client: any = getRootClient(instanceId)
  sseManager.seedStatus(instanceId, "connected")
  stubAuthoritativeSession(client, messages)
  return {
    client,
    cleanup() {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    },
  }
}

/** Awaits the real sync promise; the timeout is only a failure bound. */
export async function settleSync(sync: Promise<unknown>, reads: () => number): Promise<void> {
  await Promise.race([
    sync,
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`message.list sync did not settle (${reads()} reads)`)), 2000)
    }),
  ])
}

export const readTestingSessionId = sessionId
export const readTestingModel = model
