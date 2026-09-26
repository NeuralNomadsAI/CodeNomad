import type { ToolState } from "../../../types/tool-state"
import { readToolStatePayload } from "../utils"

export interface ExecuteCall {
  tool: string
  status: "running" | "completed" | "error"
  input?: Record<string, unknown>
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// Read historical and live metadata defensively. Do not infer success for an
// unknown status or unpack output.files (native images use the shared surface).
export function executeData(state: ToolState | undefined) {
  const { input, metadata } = readToolStatePayload(state)
  const calls: ExecuteCall[] = []
  if (Array.isArray(metadata.toolCalls)) {
    for (const value of metadata.toolCalls) {
      if (!record(value) || typeof value.tool !== "string"
        || !["running", "completed", "error"].includes(String(value.status))) continue
      calls.push({ tool: value.tool, status: value.status as ExecuteCall["status"],
        ...(record(value.input) ? { input: value.input } : {}) })
    }
  }
  return { code: typeof input.code === "string" ? input.code : "", calls,
    failed: metadata.error === true, truncated: metadata.truncated === true,
    outputPath: typeof metadata.outputPath === "string" ? metadata.outputPath : undefined }
}

export function executeSummary(calls: readonly ExecuteCall[]): string {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1)
  return [...counts].slice(0, 4).map(([tool, count]) => count > 1 ? `${tool} ×${count}` : tool).join(", ")
    + (counts.size > 4 ? ` +${counts.size - 4}` : "")
}
