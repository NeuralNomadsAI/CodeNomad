export type ToolPayload = Record<string, unknown>

export interface ToolStatePending {
  status: "pending"
}

export interface ToolStateRunning {
  status: "running"
  input: ToolPayload
  metadata?: ToolPayload
  title?: string
}

export interface ToolStateCompleted {
  status: "completed"
  input: ToolPayload
  metadata?: ToolPayload
  output: unknown
  title?: string
}

export interface ToolStateError {
  status: "error"
  input: ToolPayload
  metadata?: ToolPayload
  error: string
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError
