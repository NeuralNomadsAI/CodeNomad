import type { LocationPublicInfo, McpListOutput, OpenCodeClient, Project } from "@opencode/client"
import type { WorkspaceDescriptor } from "../../../server/src/api-types"

export interface LogEntry {
  timestamp: number
  level: "info" | "error" | "warn" | "debug"
  message: string
}

export type ProjectInfo = LocationPublicInfo["project"] & Partial<Pick<Project, "vcs">>

export interface McpServerStatus {
  name: string
  status: "running" | "stopped" | "error"
}

export type RawMcpStatus = McpListOutput

export interface InstanceMetadata {
  project?: ProjectInfo | null
  mcpStatus?: RawMcpStatus | null
  version?: string
}


export interface Instance {
  /** In-memory occurrence origin for retained renderer content; installed by the instance owner. */
  readonly renderBinding?: Readonly<{ serverId: string; directory: string; folder: string }>
  id: string
  binding?: WorkspaceDescriptor["binding"]
  capabilities?: WorkspaceDescriptor["capabilities"]
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
  /** CodeNomad-managed temporary folder: closing offers to keep or discard it. */
  temporary?: boolean
}
