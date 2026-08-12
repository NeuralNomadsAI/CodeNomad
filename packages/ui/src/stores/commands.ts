import { createSignal } from "solid-js"
import type { CommandInfo, OpenCodeClient } from "@opencode-ai/client"

const [commandMap, setCommandMap] = createSignal<Map<string, CommandInfo[]>>(new Map())

export async function fetchCommands(instanceId: string, client: OpenCodeClient): Promise<void> {
  const commands = await client.command.list().then((result) => result.data).catch(() => [])
  setCommandMap((prev) => {
    const next = new Map(prev)
    next.set(instanceId, commands)
    return next
  })
}

export function getCommands(instanceId: string): CommandInfo[] {
  return commandMap().get(instanceId) ?? []
}

export function clearCommands(instanceId: string): void {
  setCommandMap((prev) => {
    if (!prev.has(instanceId)) return prev
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
}
