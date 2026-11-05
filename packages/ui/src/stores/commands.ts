import { createSignal } from "solid-js"
import type { CommandInfo, LocationRef, OpenCodeClient } from "@opencode/client"
import { requestConnectionOptions, requestLocationOptions, toRequestLocation } from "./request-locations"
import { captureInstanceRequestAuthority } from "./session-api"
import { instances } from "./instances"
import { sessionMatchesInventory } from "./session-inventory-scope"

const [commandMap, setCommandMap] = createSignal<Map<string, CommandInfo[]>>(new Map())
const commandRequestIds = new Map<string, number>()
let nextCommandRequestId = 0

export async function fetchCommands(
  instanceId: string,
  client: OpenCodeClient,
  location?: LocationRef,
): Promise<boolean> {
  if (instances().get(instanceId)?.client !== client) return false
  if (!sessionMatchesInventory(instances().get(instanceId), { location })) return false
  const current = captureInstanceRequestAuthority(instanceId)
  const requestOptions = requestConnectionOptions(instances().get(instanceId)) ?? requestLocationOptions(location)
  const requestId = ++nextCommandRequestId
  commandRequestIds.set(instanceId, requestId)
  let commands: CommandInfo[]
  try {
    commands = await client.command.list(location ? { location: toRequestLocation(location) } : undefined, requestOptions).then((result) => result.data)
  } catch {
    return false
  }
  if (!current() || instances().get(instanceId)?.client !== client || commandRequestIds.get(instanceId) !== requestId) return false
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
