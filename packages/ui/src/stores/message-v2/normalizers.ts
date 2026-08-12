import { decodeHtmlEntities } from "../../lib/text-render-utils"
import type { SessionMessageInfo } from "@opencode-ai/client"
import type { ClientPart, Message, MessageInfo } from "../../types/message"

function decodeTextSegment(segment: any): any {
  if (typeof segment === "string") {
    return decodeHtmlEntities(segment)
  }

  if (segment && typeof segment === "object") {
    const updated: Record<string, any> = { ...segment }

    if (typeof updated.text === "string") {
      updated.text = decodeHtmlEntities(updated.text)
    }

    if (typeof updated.value === "string") {
      updated.value = decodeHtmlEntities(updated.value)
    }

    if (Array.isArray(updated.content)) {
      updated.content = updated.content.map((item: any) => decodeTextSegment(item))
    }

    return updated
  }

  return segment
}

export function normalizeMessagePart(part: any): any {
  if (!part || typeof part !== "object") {
    return part
  }

  if (part.type === "tool" && (typeof part.id !== "string" || part.id.length === 0)) {
    throw new Error("Tool part missing id")
  }

  if (part.type !== "text" && part.type !== "reasoning") {
    return part
  }

  const normalized: Record<string, any> = { ...part, renderCache: undefined }

  if (typeof normalized.text === "string") {
    normalized.text = decodeHtmlEntities(normalized.text)
  } else if (normalized.text && typeof normalized.text === "object") {
    const textObject: Record<string, any> = { ...normalized.text }

    if (typeof textObject.value === "string") {
      textObject.value = decodeHtmlEntities(textObject.value)
    }

    if (Array.isArray(textObject.content)) {
      textObject.content = textObject.content.map((item: any) => decodeTextSegment(item))
    }

    if (typeof textObject.text === "string") {
      textObject.text = decodeHtmlEntities(textObject.text)
    }

    normalized.text = textObject
  }

  if (Array.isArray(normalized.content)) {
    normalized.content = normalized.content.map((item: any) => decodeTextSegment(item))
  }

  if (normalized.thinking && typeof normalized.thinking === "object") {
    const thinking: Record<string, any> = { ...normalized.thinking }
    if (Array.isArray(thinking.content)) {
      thinking.content = thinking.content.map((item: any) => decodeTextSegment(item))
    }
    normalized.thinking = thinking
  }

  return normalized
}

export interface NormalizedSessionMessage {
  message: Message
  info: MessageInfo
}

function toolOutput(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  const text = content
    .filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
  return text || content
}

export function normalizeSessionMessage(sessionId: string, source: SessionMessageInfo): NormalizedSessionMessage {
  const assistant = source.type === "assistant" ? source : undefined
  const role: MessageInfo["role"] = source.type === "user" ? "user" : "assistant"
  const info: MessageInfo = {
    id: source.id,
    sessionID: sessionId,
    role,
    time: source.time,
    ...(assistant
      ? {
          mode: assistant.agent,
          agent: assistant.agent,
          providerID: assistant.model.providerID,
          modelID: assistant.model.id,
          variant: assistant.model.variant,
          cost: assistant.cost,
          tokens: assistant.tokens,
          error: assistant.error
            ? { ...assistant.error, name: assistant.error.type, data: { message: assistant.error.message } }
            : undefined,
        }
      : {}),
    ...(source.type === "user" ? { text: source.text } : {}),
  }

  let parts: ClientPart[]
  if (source.type === "assistant") {
    parts = source.content.map((part, index) => {
      if (part.type !== "tool") {
        return normalizeMessagePart({
          ...part,
          id: `${source.id}-${part.type}-${index}`,
          sessionID: sessionId,
          messageID: source.id,
        }) as ClientPart
      }
      const state = part.state
      const normalizedState = state.status === "streaming"
        ? { status: "pending" as const }
        : {
            ...state,
            ...(state.status === "completed" ? { output: toolOutput(state.content) } : {}),
            ...(state.status === "error" ? { error: state.error.message } : {}),
          }
      return {
        id: part.id,
        type: "tool",
        tool: part.name,
        callID: part.id,
        sessionID: sessionId,
        messageID: source.id,
        time: part.time,
        state: normalizedState,
      } as unknown as ClientPart
    })
  } else if (source.type === "user") {
    parts = [
      normalizeMessagePart({ id: `${source.id}-text`, type: "text", text: source.text, sessionID: sessionId, messageID: source.id }),
      ...(source.files ?? []).map((file, index) => ({
        id: `${source.id}-file-${index}`,
        type: "file" as const,
        url: file.source.type === "uri" ? file.source.uri : file.data,
        mime: file.mime,
        filename: file.name,
        sessionID: sessionId,
        messageID: source.id,
      } as ClientPart)),
    ]
  } else if (source.type === "compaction") {
    parts = [{
      id: source.id,
      type: "compaction",
      auto: source.reason === "auto",
      text: "summary" in source ? source.summary : source.error.message,
      sessionID: sessionId,
      messageID: source.id,
    } as ClientPart]
  } else {
    const text = "text" in source ? source.text : source.type === "shell" ? source.output?.output ?? source.command : source.type
    parts = [normalizeMessagePart({
      id: source.id,
      type: "text",
      text,
      synthetic: source.type !== "system",
      sessionID: sessionId,
      messageID: source.id,
    }) as ClientPart]
  }

  return {
    info,
    message: {
      id: source.id,
      sessionId,
      type: role,
      parts,
      timestamp: source.time.created,
      status: assistant?.error ? "error" : role === "user" || assistant?.time.completed ? "complete" : "streaming",
      version: 0,
    },
  }
}

