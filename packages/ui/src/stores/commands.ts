import { createSignal } from "solid-js"
import type { CommandInfo, LocationRef, OpenCodeClient } from "@opencode-ai/client"
import { waitForPluginActivation } from "./plugin-activation"
import { toRequestLocation } from "./request-locations"

const [commandMap, setCommandMap] = createSignal<Map<string, CommandInfo[]>>(new Map())
const commandRequestIds = new Map<string, number>()
let nextCommandRequestId = 0

export async function fetchCommands(
  instanceId: string,
  client: OpenCodeClient,
  location?: LocationRef,
): Promise<boolean> {
  const requestId = ++nextCommandRequestId
  commandRequestIds.set(instanceId, requestId)
  let commands: CommandInfo[]
  try {
    await waitForPluginActivation(client, location)
    commands = await client.command.list(location ? { location: toRequestLocation(location) } : undefined).then((result) => result.data)
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
