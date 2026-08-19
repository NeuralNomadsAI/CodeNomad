import type { OpenCodeEvent } from "@opencode-ai/client"
import { createData, type Data } from "@opencode-ai/client/solid"
import { createRoot } from "solid-js"
import { getRootClient } from "./opencode-client"
import { applyPartUpdateV2, upsertMessageInfoV2 } from "./message-v2/bridge"
import { normalizeSessionMessage } from "./message-v2/normalizers"
import { sseManager } from "../lib/sse-manager"
import { messageStoreBus } from "./message-v2/bus"

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
  const store = messageStoreBus.getOrCreate(instanceId)
  for (const item of source) {
    const normalized = normalizeSessionMessage(sessionId, item)
    if (normalized.info.role === "user" && normalized.message.parts.length) {
      store.confirmServerMessage(normalized.info.id, { clearOptimisticParts: true })
    }
    const status = normalized.message.status
    upsertMessageInfoV2(instanceId, normalized.info, {
      status: status === "sending" || status === "sent" || status === "streaming" || status === "error"
        ? status
        : "complete",
    })
    for (const part of normalized.message.parts) applyPartUpdateV2(instanceId, part)
  }
}

export function destroyOpenCodeData(instanceId: string): void {
  entries.get(instanceId)?.dispose()
  entries.delete(instanceId)
}
