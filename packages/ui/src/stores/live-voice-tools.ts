import { createSignal } from "solid-js"
import type { MessageRecord } from "./message-v2/types"
import type { ToolStateError } from "../types/tool-state"

/**
 * Standard CodeNomad Live Voice Tool Schema
 */
export interface LiveVoiceToolParameterProperty {
  type: string
  description?: string
  enum?: string[]
}

export interface LiveVoiceToolParameters {
  type: "object"
  properties: Record<string, LiveVoiceToolParameterProperty>
  required?: string[]
}

export interface LiveVoiceToolDefinition {
  name: string
  description: string
  parameters: LiveVoiceToolParameters
}

/**
 * Gemini Live API Function Declaration Format
 */
export interface GeminiFunctionDeclaration {
  name: string
  description: string
  parameters: {
    type: "OBJECT"
    properties: Record<string, { type: string; description?: string; enum?: string[] }>
    required?: string[]
  }
}

/**
 * OpenAI Realtime API Tool Format
 */
export interface OpenAIToolDefinition {
  type: "function"
  name: string
  description: string
  parameters: {
    type: "object"
    properties: Record<string, { type: string; description?: string; enum?: string[] }>
    required?: string[]
  }
}

/**
 * 1. get_session_status: Read-only, returns agent name, model, and active state.
 * 2. read_active_file: Read-only, returns currently focused file and truncated content if available.
 * 3. list_recent_errors: Read-only, returns last 3 errors from transcript.
 * 4. send_prompt_to_agent: Dispatches user prompt text to the active OpenCode agent via sendMessage.
 */
export const LIVE_VOICE_TOOLS: LiveVoiceToolDefinition[] = [
  {
    name: "get_session_status",
    description: "Get the current session status including agent name, model, and active state (e.g. idle, working).",
    parameters: {
      type: "object",
      properties: {
        instanceId: {
          type: "string",
          description: "Optional workspace instance ID. Defaults to active instance if omitted.",
        },
        sessionId: {
          type: "string",
          description: "Optional session ID. Defaults to active session if omitted.",
        },
      },
    },
  },
  {
    name: "read_active_file",
    description: "Read the currently focused file path and its truncated content in the editor/viewer if available.",
    parameters: {
      type: "object",
      properties: {
        maxLength: {
          type: "number",
          description: "Optional maximum characters of file content to return (defaults to 2000).",
        },
      },
    },
  },
  {
    name: "list_recent_errors",
    description: "Retrieve the last 3 errors recorded in the current session transcript.",
    parameters: {
      type: "object",
      properties: {
        instanceId: {
          type: "string",
          description: "Optional workspace instance ID. Defaults to active instance if omitted.",
        },
        sessionId: {
          type: "string",
          description: "Optional session ID. Defaults to active session if omitted.",
        },
        limit: {
          type: "number",
          description: "Maximum number of recent errors to return (defaults to 3).",
        },
      },
    },
  },
  {
    name: "send_prompt_to_agent",
    description: "Dispatch a prompt to the active OpenCode agent. This sends the instruction safely through standard session messaging.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The prompt text or instruction to send to the agent.",
        },
        instanceId: {
          type: "string",
          description: "Optional workspace instance ID. Defaults to active instance if omitted.",
        },
        sessionId: {
          type: "string",
          description: "Optional session ID. Defaults to active session if omitted.",
        },
      },
      required: ["prompt"],
    },
  },
]

export const ALLOWED_LIVE_VOICE_TOOL_NAMES = new Set(LIVE_VOICE_TOOLS.map((t) => t.name))

/**
 * Converts internal tool definitions to Gemini Live function declarations.
 */
export function toGeminiFunctionDeclarations(
  tools: LiveVoiceToolDefinition[] = LIVE_VOICE_TOOLS,
): GeminiFunctionDeclaration[] {
  return tools.map((tool) => {
    const properties: Record<string, { type: string; description?: string; enum?: string[] }> = {}
    for (const [key, prop] of Object.entries(tool.parameters.properties)) {
      properties[key] = {
        type: prop.type.toUpperCase(),
        ...(prop.description ? { description: prop.description } : {}),
        ...(prop.enum ? { enum: prop.enum } : {}),
      }
    }

    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "OBJECT",
        properties,
        ...(tool.parameters.required && tool.parameters.required.length > 0
          ? { required: tool.parameters.required }
          : {}),
      },
    }
  })
}

/**
 * Converts internal tool definitions to OpenAI Realtime tool definitions.
 */
export function toOpenAITools(
  tools: LiveVoiceToolDefinition[] = LIVE_VOICE_TOOLS,
): OpenAIToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "object",
      properties: { ...tool.parameters.properties },
      ...(tool.parameters.required && tool.parameters.required.length > 0
        ? { required: tool.parameters.required }
        : {}),
    },
  }))
}

export interface ActiveFileInfo {
  path: string | null
  content: string | null
}

const [activeFileState, setActiveFileState] = createSignal<ActiveFileInfo>({
  path: null,
  content: null,
})

export function setActiveFileInfo(fileInfo: ActiveFileInfo | null): void {
  setActiveFileState(fileInfo ?? { path: null, content: null })
}

export function getActiveFileInfo(): ActiveFileInfo {
  return activeFileState()
}

export interface LiveVoiceToolCall {
  name: string
  arguments?: Record<string, unknown> | string
}

export interface LiveVoiceToolContext {
  instanceId?: string | null
  sessionId?: string | null
  activeFile?: ActiveFileInfo | null
  session?: {
    id: string
    agent: string
    model: { providerId: string; modelId: string }
    status: string
    pendingPermission?: boolean
    pendingForm?: boolean
  } | null
  recentErrors?: Array<{ id: string; error: string; timestamp?: number }>
  sendMessageFn?: (instanceId: string, sessionId: string, prompt: string) => Promise<string>
}

export interface LiveVoiceExecutionSuccess {
  status?: string
  message?: string
  [key: string]: unknown
}

export interface LiveVoiceExecutionError {
  error: string
  [key: string]: unknown
}

export type LiveVoiceExecutionResult = LiveVoiceExecutionSuccess | LiveVoiceExecutionError

function parseArgs(args: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!args) return {}
  if (typeof args === "string") {
    try {
      return JSON.parse(args) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return args
}

/**
 * Executes a tool called by the live voice model.
 *
 * Tier 1: Synchronous read-only queries resolving from store state.
 * Tier 2: send_prompt_to_agent: Dispatches prompt via sendMessage and returns immediately
 *         { status: "dispatched", message: "Prompt queued for agent execution" }
 * Security Fence: Any destructive or unknown tool call outside the allowed whitelist is explicitly rejected with
 *                 { error: "Operation not permitted" }
 */
export async function executeLiveVoiceTool(
  toolCall: LiveVoiceToolCall,
  context?: LiveVoiceToolContext,
): Promise<LiveVoiceExecutionResult> {
  if (!toolCall || typeof toolCall.name !== "string" || !ALLOWED_LIVE_VOICE_TOOL_NAMES.has(toolCall.name)) {
    return { error: "Operation not permitted" }
  }

  const args = parseArgs(toolCall.arguments)
  const resolvedInstanceId =
    (typeof args.instanceId === "string" && args.instanceId) ||
    context?.instanceId ||
    ""

  const resolvedSessionId =
    (typeof args.sessionId === "string" && args.sessionId) ||
    context?.sessionId ||
    ""

  switch (toolCall.name) {
    case "get_session_status": {
      if (context?.session) {
        return {
          instanceId: resolvedInstanceId || "test-instance",
          sessionId: context.session.id,
          agent: context.session.agent,
          model: `${context.session.model.providerId}/${context.session.model.modelId}`,
          status: context.session.status,
          pendingPermission: context.session.pendingPermission ?? false,
          pendingForm: context.session.pendingForm ?? false,
        }
      }
      if (!resolvedInstanceId) {
        return { error: "No active instance available" }
      }
      try {
        const { sessions, getActiveSession } = await import("./session-state")
        const instanceSessions = sessions().get(resolvedInstanceId)
        const session = resolvedSessionId ? instanceSessions?.get(resolvedSessionId) : getActiveSession(resolvedInstanceId)
        if (!session) {
          return {
            instanceId: resolvedInstanceId,
            sessionId: resolvedSessionId || null,
            found: false,
            status: "unknown",
          }
        }

        return {
          instanceId: resolvedInstanceId,
          sessionId: session.id,
          agent: session.agent,
          model: `${session.model.providerId}/${session.model.modelId}`,
          status: session.status,
          pendingPermission: session.pendingPermission ?? false,
          pendingForm: session.pendingForm ?? false,
        }
      } catch {
        return {
          instanceId: resolvedInstanceId,
          sessionId: resolvedSessionId || null,
          found: false,
          status: "unknown",
        }
      }
    }

    case "read_active_file": {
      const activeFile = context?.activeFile ?? getActiveFileInfo()
      if (!activeFile || !activeFile.path) {
        return {
          path: null,
          content: null,
          message: "No active file selected",
        }
      }

      const maxLength = typeof args.maxLength === "number" && args.maxLength > 0 ? args.maxLength : 2000
      let content = activeFile.content
      let truncated = false
      if (typeof content === "string" && content.length > maxLength) {
        content = content.slice(0, maxLength)
        truncated = true
      }

      return {
        path: activeFile.path,
        content: content ?? null,
        truncated,
      }
    }

    case "list_recent_errors": {
      if (context?.recentErrors) {
        return {
          instanceId: resolvedInstanceId || "test-instance",
          sessionId: resolvedSessionId || "test-session",
          count: context.recentErrors.length,
          errors: context.recentErrors,
        }
      }
      if (!resolvedInstanceId || !resolvedSessionId) {
        return {
          instanceId: resolvedInstanceId || null,
          sessionId: resolvedSessionId || null,
          count: 0,
          errors: [],
          message: "No active session to retrieve errors for",
        }
      }

      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 10) : 3
      try {
        const { messageStoreBus } = await import("./message-v2/bus")
        const store = messageStoreBus.registerInstance(resolvedInstanceId)
        const messageIds = store.getSessionMessageIds(resolvedSessionId)

        const extractedErrors: Array<{
          messageId: string
          partId?: string
          error: string
          createdAt: number
        }> = []

        for (let i = messageIds.length - 1; i >= 0; i--) {
          const msgId = messageIds[i]
          const message: MessageRecord | undefined = store.getMessage(msgId)
          if (!message) continue

          const messageInfo = store.getMessageInfo(msgId)
          if (messageInfo?.error?.data?.message) {
            extractedErrors.push({
              messageId: msgId,
              error: messageInfo.error.data.message,
              createdAt: message.createdAt,
            })
            if (extractedErrors.length >= limit) break
          }

          for (const partId of message.partIds) {
            const partRecord = message.parts[partId]
            if (!partRecord || !partRecord.data) continue
            const part = partRecord.data

            if (part.type === "tool" && part.state && (part.state as ToolStateError).status === "error") {
              const errState = part.state as ToolStateError
              extractedErrors.push({
                messageId: msgId,
                partId,
                error: errState.error || `Tool ${part.tool} failed`,
                createdAt: message.createdAt,
              })
              if (extractedErrors.length >= limit) break
            }
          }

          if (extractedErrors.length >= limit) break
        }

        return {
          instanceId: resolvedInstanceId,
          sessionId: resolvedSessionId,
          errors: extractedErrors.slice(0, limit),
        }
      } catch {
        return {
          instanceId: resolvedInstanceId,
          sessionId: resolvedSessionId,
          errors: [],
        }
      }
    }

    case "send_prompt_to_agent": {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
      if (!prompt) {
        return { error: "Prompt text is required" }
      }

      if (!resolvedInstanceId || !resolvedSessionId) {
        return { error: "No active session available to receive prompt" }
      }

      const sendFn = context?.sendMessageFn
      if (sendFn) {
        void sendFn(resolvedInstanceId, resolvedSessionId, prompt).catch((err: unknown) => {
          console.error("Failed to dispatch voice prompt to agent:", err)
        })
      } else {
        void import("./session-actions").then(({ sendMessage }) => {
          return sendMessage(resolvedInstanceId, resolvedSessionId, prompt)
        }).catch((err: unknown) => {
          console.error("Failed to dispatch voice prompt to agent:", err)
        })
      }

      return {
        status: "dispatched",
        message: "Prompt queued for agent execution",
      }
    }

    default:
      return { error: "Operation not permitted" }
  }
}
