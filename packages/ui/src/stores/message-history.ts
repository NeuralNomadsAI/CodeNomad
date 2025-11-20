import type { InstanceData } from "../../../server/src/api-types"
import {
  ensureInstanceConfigLoaded,
  getInstanceConfig,
  updateInstanceConfig,
} from "./instance-config"

const MAX_HISTORY = 100

export async function addToHistory(instanceId: string, text: string): Promise<void> {
  if (!instanceId || !text) return
  await ensureInstanceConfigLoaded(instanceId)
  await updateInstanceConfig(instanceId, (draft) => {
    const nextHistory = [text, ...(draft.messageHistory ?? [])]
    if (nextHistory.length > MAX_HISTORY) {
      nextHistory.length = MAX_HISTORY
    }
    draft.messageHistory = nextHistory
  })
}

export async function getHistory(instanceId: string): Promise<string[]> {
  if (!instanceId) return []
  await ensureInstanceConfigLoaded(instanceId)
  const data = getInstanceConfig(instanceId)
  return [...(data.messageHistory ?? [])]
}

export async function clearHistory(instanceId: string): Promise<void> {
  if (!instanceId) return
  await ensureInstanceConfigLoaded(instanceId)
  await updateInstanceConfig(instanceId, (draft) => {
    draft.messageHistory = []
  })
}
