import { createSignal } from "solid-js"

// Project MCP configuration state
const [mcpServerCount, setMcpServerCount] = createSignal(0)
const [projectMcpConfig, setProjectMcpConfig] = createSignal<Record<string, unknown>>({})

export interface MergedMcpEntry {
  name: string
  source: "era-code" | "global" | "project"
  enabled: boolean
  config?: Record<string, unknown>
  overriddenBy?: "global" | "project"
}

export function getActiveMcpServerCount(): number {
  return mcpServerCount()
}

export function setProjectMcpServer(_serverId: string, _config: unknown): void {
  // Stub - would set MCP server config
}

export async function fetchProjectMcpConfig(_instanceId: string): Promise<void> {
  // Stub - would fetch MCP config from server
}

export function getMergedMcpServers(_folder: string): MergedMcpEntry[] {
  // Stub - returns empty list for now
  // Would merge era-code defaults, global config, and project config
  return []
}

export function removeProjectMcpServer(_serverId: string): void {
  // Stub - would remove project-level MCP server config
}

export function setProjectMcpOverride(_serverId: string, _override: boolean): void {
  // Stub - would set project-level override for an MCP server
}
