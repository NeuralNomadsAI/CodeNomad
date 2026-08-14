import { createSignal } from "solid-js"
import type { CommandInfo, LocationRef, OpenCodeClient } from "@opencode-ai/client"

const [commandMap, setCommandMap] = createSignal<Map<string, CommandInfo[]>>(new Map())
const commandRequestIds = new Map<string, number>()

export async function fetchCommands(
  instanceId: string,
  client: OpenCodeClient,
  location?: LocationRef,
): Promise<boolean> {
  const requestId = (commandRequestIds.get(instanceId) ?? 0) + 1
  commandRequestIds.set(instanceId, requestId)
  let commands: CommandInfo[]
  try {
    commands = await client.command.list(location ? { location } : undefined).then((result) => result.data)
  } catch {
    return false
  }
  if (commandRequestIds.get(instanceId) !== requestId) return false
  setCommandMap((prev) => {
    const next = new Map(prev)
    next.set(instanceId, commands)
    return next
  })
  return true
}

export function getCommands(instanceId: string): CommandInfo[] {
  return commandMap().get(instanceId) ?? []
}

export function clearCommands(instanceId: string): void {
  commandRequestIds.delete(instanceId)
  setCommandMap((prev) => {
    if (!prev.has(instanceId)) return prev
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
}
