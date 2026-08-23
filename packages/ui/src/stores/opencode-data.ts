import type { OpenCodeEvent } from "@opencode-ai/client"
import { createData, type Data } from "@opencode-ai/client/solid"
import { createRoot } from "solid-js"
import { getRootClient } from "./opencode-client"
import { seedSessionMessagesV2 } from "./message-v2/bridge"
import { normalizeSessionMessage } from "./message-v2/normalizers"
import { sseManager } from "../lib/sse-manager"

const entries = new Map<string, { data: Data; emit: (event: OpenCodeEvent) => void; dispose: () => void }>()

function ensureData(instanceId: string, directory: string) {
  const existing = entries.get(instanceId)
  if (existing) return existing

  const listeners = new Set<(event: { name: OpenCodeEvent["type"]; details: OpenCodeEvent }) => void>()
  const entry = createRoot((dispose) => {
    const event = {
      listen(handler: (event: { name: OpenCodeEvent["type"]; details: OpenCodeEvent }) => void) {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
      on(type: OpenCodeEvent["type"], handler: (event: OpenCodeEvent) => void) {
        return event.listen(({ details }) => {
          if (details.type === type) handler(details)
        })
      },
    }
    return {
      data: createData({
        api: () => getRootClient(instanceId),
        directory,
        event: event as any,
        connection: {
          status: () => sseManager.getStatuses().get(instanceId) === "connected" ? "connected" : "reconnecting",
        },
      }),
      emit(details: OpenCodeEvent) {
        for (const listener of listeners) listener({ name: details.type, details })
      },
      dispose,
    }
  })
  entries.set(instanceId, entry)
  return entry
}

export function applyOpenCodeDataEvent(instanceId: string, directory: string, event: OpenCodeEvent): Data {
  if (event.type === "server.connected") destroyOpenCodeData(instanceId)
  const entry = ensureData(instanceId, directory)
  entry.emit(event)
  return entry.data
}

export function projectOpenCodeMessages(instanceId: string, sessionId: string, data: Data): void {
  const source = data.session.message.list(sessionId)
  if (!source.length) return
  const normalized = source.map((item) => normalizeSessionMessage(sessionId, item))
  seedSessionMessagesV2(
    instanceId,
    { id: sessionId },
    normalized.map((item) => item.message),
    new Map(normalized.map((item) => [item.info.id, item.info])),
    undefined,
    true,
  )
}

export function destroyOpenCodeData(instanceId: string): void {
  entries.get(instanceId)?.dispose()
  entries.delete(instanceId)
}
