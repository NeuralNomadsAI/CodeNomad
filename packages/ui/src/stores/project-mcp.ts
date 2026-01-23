import { createSignal } from "solid-js"

// Project MCP configuration state
const [mcpServerCount, setMcpServerCount] = createSignal(0)
const [projectMcpConfig, setProjectMcpConfig] = createSignal<Record<string, unknown>>({})

export function getActiveMcpServerCount(): number {
  return mcpServerCount()
}

export function setProjectMcpServer(_serverId: string, _config: unknown): void {
  // Stub - would set MCP server config
}

export async function fetchProjectMcpConfig(_instanceId: string): Promise<void> {
  // Stub - would fetch MCP config from server
}
