import { applyOpenCodeDataEvent, destroyOpenCodeData } from "./opencode-data.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { getRootClient } from "./opencode-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"

export const readTestingModel = { providerID: "provider", id: "model" }
export const readTestingSessionId = "session"
const sessionId = readTestingSessionId

export const assistantRow = (id: string, text?: string, created = 100): Record<string, unknown> => ({
  id, type: "assistant", agent: "build", model: readTestingModel,
  content: text === undefined ? [] : [{ type: "text", text }],
  time: { created },
})

export const textOf = (data: ReturnType<typeof applyOpenCodeDataEvent>, messageId: string): string => {
  const row: any = data.session.message.get(sessionId, messageId)
  return String(row?.content?.find((part: any) => part.type === "text")?.text ?? "")
}

let sequence = 0
export function emitEvent(instanceId: string, type: string, payload: Record<string, unknown> = {}, id?: string) {
  const created = ++sequence
  return applyOpenCodeDataEvent(instanceId, "/work", {
    id: id ?? `evt_${created}`, type, created, data: { sessionID: sessionId, ...payload },
  } as any)
}

/** Arms one live assistant row whose reduced text already holds `base`. */
export function armLive(instanceId: string, base = "base") {
  const live = { assistantMessageID: "live" }
  emitEvent(instanceId, "session.step.started", { ...live, agent: "build", model: readTestingModel, started: 100 })
  emitEvent(instanceId, "session.text.started", live)
  return emitEvent(instanceId, "session.text.delta", { ...live, ordinal: 0, delta: base })
}

export const delta = (instanceId: string, text = "X", target = "live") =>
  emitEvent(instanceId, "session.text.delta", { assistantMessageID: target, ordinal: 0, delta: text })

/** Connected client stub whose message.list comes from the caller. */
export function readFixture(instanceId: string, messages: () => Promise<any>) {
  const client: any = getRootClient(instanceId)
  sseManager.seedStatus(instanceId, "connected")
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
  return {
    client,
    cleanup() {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    },
  }
}

/** Awaits the real sync promise; the timeout only bounds a failure. */
export async function settleSync(sync: Promise<unknown>, reads: () => number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      sync,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`message.list sync did not settle (${reads()} reads)`)), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
