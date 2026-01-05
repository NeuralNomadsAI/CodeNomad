import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { LspStatus, Project as SDKProject } from "@opencode-ai/sdk/v2"

export interface LogEntry {
  timestamp: number
  level: "info" | "error" | "warn" | "debug"
  message: string
}

// Use SDK Project type instead of our own
export type ProjectInfo = SDKProject

export interface McpServerStatus {
  name: string
  status: "running" | "stopped" | "error"
}

// Raw MCP status from server (SDK returns unknown for /mcp endpoint)
export type RawMcpStatus = Record<string, {
  status?: string
  error?: string
}>

export interface InstanceMetadata {
  project?: ProjectInfo | null
  mcpStatus?: RawMcpStatus | null
  lspStatus?: LspStatus[] | null
  plugins?: string[] | null
  version?: string
}


export interface Instance {
  id: string
  folder: string
  port: number
  pid: number
  proxyPath: string
  status: "starting" | "ready" | "error" | "stopped"
  error?: string
  client: OpencodeClient | null
  metadata?: InstanceMetadata
  binaryPath?: string
  binaryLabel?: string
  binaryVersion?: string
  environmentVariables?: Record<string, string>
}
