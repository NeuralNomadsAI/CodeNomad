import type { OpencodeClient } from "@opencode-ai/sdk/client"

export interface LogEntry {
  timestamp: number
  level: "info" | "error" | "warn" | "debug"
  message: string
}

export interface Instance {
  id: string
  folder: string
  port: number
  pid: number
  status: "starting" | "ready" | "error" | "stopped"
  error?: string
  client: OpencodeClient | null
  logs: LogEntry[]
}
