import type { McpListOutput, OpenCodeClient, Project, ProjectCurrent } from "@opencode-ai/client"

export interface LogEntry {
  timestamp: number
  level: "info" | "error" | "warn" | "debug"
  message: string
}

export type ProjectInfo = ProjectCurrent & Partial<Pick<Project, "vcs">>

export interface McpServerStatus {
  name: string
  status: "running" | "stopped" | "error"
}

export type RawMcpStatus = McpListOutput

export interface InstanceMetadata {
  project?: ProjectInfo | null
  mcpStatus?: RawMcpStatus | null
  lspStatus?: [] | null
  plugins?: string[] | null
  version?: string
}


export interface Instance {
  id: string
  folder: string
  projectName?: string
  port: number
  pid: number
  proxyPath: string
  status: "starting" | "ready" | "error" | "stopped"
  error?: string
  client: OpenCodeClient | null
  metadata?: InstanceMetadata
  binaryPath?: string
  binaryLabel?: string
  binaryVersion?: string
  environmentVariables?: Record<string, string>
}
