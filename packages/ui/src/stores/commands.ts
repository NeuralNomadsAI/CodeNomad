import { createSignal } from "solid-js"
import type { Command as SDKCommand } from "@opencode-ai/sdk"
import type { OpencodeClient } from "@opencode-ai/sdk/client"

const [commandMap, setCommandMap] = createSignal<Map<string, SDKCommand[]>>(new Map())

export async function fetchCommands(instanceId: string, client: OpencodeClient): Promise<void> {
  const response = await client.command.list()
  const commands = response.data ?? []
  console.log("[Commands Store] fetchCommands(", instanceId, ") fetched", commands.length, "commands:")
  console.table(commands.map((c) => ({
    name: c.name,
    description: c.description?.substring(0, 60) + "...",
    template: c.template
  })))
  console.log("[Commands Store] Full command names:", commands.map((c) => c.name).sort())
  setCommandMap((prev) => {
    const next = new Map(prev)
    next.set(instanceId, commands)
    return next
  })
}

export function getCommands(instanceId: string): SDKCommand[] {
  const commands = commandMap().get(instanceId) ?? []
  console.log("[Commands Store] getCommands(", instanceId, ") returning", commands.length, "commands:", commands.map((c) => c.name))
  return commands
}

export function clearCommands(instanceId: string): void {
  setCommandMap((prev) => {
    if (!prev.has(instanceId)) return prev
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
}

export { commandMap as commands }
