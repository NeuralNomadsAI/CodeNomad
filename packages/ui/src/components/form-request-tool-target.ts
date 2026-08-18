import type { FormInfo } from "@opencode-ai/client"

interface MessagePart {
  id?: string
  type?: string
  tool?: string
  callID?: string
  callId?: string
  toolCallID?: string
  toolCallId?: string
}

interface MessageRecord {
  partIds: string[]
  parts: Record<string, { data?: MessagePart } | undefined>
}

interface MessageStoreReader {
  getSessionMessageIds(sessionId: string): string[]
  getMessage(messageId: string): MessageRecord | undefined
}

interface FormToolTarget {
  messageId: string
  partId: string
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function explicitToolReference(form: FormInfo) {
  const metadata = metadataRecord(form.metadata)
  const tool = metadataRecord(metadata?.tool) ?? metadataRecord(metadata?.source)
  const messageId = tool?.messageID ?? tool?.messageId ?? metadata?.messageID ?? metadata?.messageId
  const callId = tool?.id ?? tool?.callID ?? tool?.callId ?? metadata?.callID ?? metadata?.callId
  return {
    messageId: typeof messageId === "string" ? messageId : undefined,
    callId: typeof callId === "string" ? callId : undefined,
  }
}

function partCallId(part: MessagePart): string | undefined {
  return part.callID ?? part.callId ?? part.toolCallID ?? part.toolCallId ?? part.id
}

function findToolPart(record: MessageRecord | undefined, callId: string): string | undefined {
  if (!record) return undefined
  for (const partId of record.partIds) {
    const part = record.parts[partId]?.data
    if (part?.type === "tool" && (partId === callId || partCallId(part) === callId)) return partId
  }
  return undefined
}

function inferredToolName(form: FormInfo): string | undefined {
  const kind = metadataRecord(form.metadata)?.kind
  if (kind === "websearch.provider") return "websearch"
  return undefined
}

export function resolveFormToolTarget(form: FormInfo, store: MessageStoreReader): FormToolTarget | null {
  const reference = explicitToolReference(form)
  if (reference.messageId && reference.callId) {
    const partId = findToolPart(store.getMessage(reference.messageId), reference.callId)
    return partId ? { messageId: reference.messageId, partId } : null
  }

  const toolName = inferredToolName(form)
  if (!toolName) return null
  const messageIds = store.getSessionMessageIds(form.sessionID)
  for (let messageIndex = messageIds.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const messageId = messageIds[messageIndex]
    const record = store.getMessage(messageId)
    if (!record) continue
    for (let partIndex = record.partIds.length - 1; partIndex >= 0; partIndex -= 1) {
      const partId = record.partIds[partIndex]
      const part = record.parts[partId]?.data
      if (part?.type === "tool" && part.tool === toolName) return { messageId, partId }
    }
  }
  return null
}

export function resolveInlineFormToolTarget(
  form: FormInfo,
  store: MessageStoreReader,
  activeSessionId: string | null | undefined,
): FormToolTarget | null {
  if (form.sessionID !== activeSessionId) return null
  return resolveFormToolTarget(form, store)
}

export function shouldRenderFormInFallback(
  form: FormInfo,
  store: MessageStoreReader | undefined,
  activeSessionId: string | null | undefined,
): boolean {
  return !store || !resolveInlineFormToolTarget(form, store, activeSessionId)
}
