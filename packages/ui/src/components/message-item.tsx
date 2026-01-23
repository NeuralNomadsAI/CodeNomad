import { For, Show, createSignal } from "solid-js"
import type { MessageInfo, ClientPart } from "../types/message"
import { partHasRenderableText } from "../types/message"
import type { MessageRecord } from "../stores/message-v2/types"
import MessagePart from "./message-part"
import { copyToClipboard } from "../lib/clipboard"

interface MessageItemProps {
  record: MessageRecord
  messageInfo?: MessageInfo
  instanceId: string
  sessionId: string
  isQueued?: boolean
  parts: ClientPart[]
  onRevert?: (messageId: string) => void
  onFork?: (messageId?: string) => void
  showAgentMeta?: boolean
  onContentRendered?: () => void
}

export default function MessageItem(props: MessageItemProps) {
  const [copied, setCopied] = createSignal(false)

  const isUser = () => props.record.role === "user"
  const createdTimestamp = () => props.messageInfo?.time?.created ?? props.record.createdAt

  const timestamp = () => {
    const date = new Date(createdTimestamp())
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  const timestampIso = () => new Date(createdTimestamp()).toISOString()

  type FilePart = Extract<ClientPart, { type: "file" }> & {
    url?: string
    mime?: string
    filename?: string
  }

  const messageParts = () => props.parts

  const fileAttachments = () =>
    messageParts().filter((part): part is FilePart => part?.type === "file" && typeof (part as FilePart).url === "string")


  const getAttachmentName = (part: FilePart) => {
    if (part.filename && part.filename.trim().length > 0) {
      return part.filename
    }
    const url = part.url || ""
    if (url.startsWith("data:")) {
      return "attachment"
    }
    try {
      const parsed = new URL(url)
      const segments = parsed.pathname.split("/")
      return segments.pop() || "attachment"
    } catch (error) {
      const fallback = url.split("/").pop()
      return fallback && fallback.length > 0 ? fallback : "attachment"
    }
  }

  const isImageAttachment = (part: FilePart) => {
    if (part.mime && typeof part.mime === "string" && part.mime.startsWith("image/")) {
      return true
    }
    return typeof part.url === "string" && part.url.startsWith("data:image/")
  }

  const handleAttachmentDownload = async (part: FilePart) => {
    const url = part.url
    if (!url) return

    const filename = getAttachmentName(part)
    const directDownload = (href: string) => {
      const anchor = document.createElement("a")
      anchor.href = href
      anchor.download = filename
      anchor.target = "_blank"
      anchor.rel = "noopener"
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
    }

    if (url.startsWith("data:")) {
      directDownload(url)
      return
    }

    if (url.startsWith("file://")) {
      window.open(url, "_blank", "noopener")
      return
    }

    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Failed to fetch attachment: ${response.status}`)
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      directDownload(objectUrl)
      URL.revokeObjectURL(objectUrl)
    } catch (error) {
      directDownload(url)
    }
  }

  const errorMessage = () => {
    const info = props.messageInfo
    if (!info || info.role !== "assistant" || !info.error) return null

    const error = info.error
    if (error.name === "ProviderAuthError") {
      return error.data?.message || "Authentication error"
    }
    if (error.name === "MessageOutputLengthError") {
      return "Message output length exceeded"
    }
    if (error.name === "MessageAbortedError") {
      return "Request was aborted"
    }
    if (error.name === "UnknownError") {
      return error.data?.message || "Unknown error occurred"
    }
    return null
  }

  const hasContent = () => {
    if (errorMessage() !== null) {
      return true
    }

    return messageParts().some((part) => partHasRenderableText(part))
  }

  const isGenerating = () => {
    const info = props.messageInfo
    return !hasContent() && info && info.role === "assistant" && info.time.completed !== undefined && info.time.completed === 0
  }

  const handleRevert = () => {
    if (props.onRevert && isUser()) {
      props.onRevert(props.record.id)
    }
  }

  const getRawContent = () => {
    return props.parts
      .filter(part => part.type === "text")
      .map(part => (part as { text?: string }).text || "")
      .filter(text => text.trim().length > 0)
      .join("\n\n")
  }

  const handleCopy = async () => {
    const content = getRawContent()
    if (!content) return
    const success = await copyToClipboard(content)
    setCopied(success)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!isUser() && !hasContent()) {
    return null
  }

  const containerClass = () =>
    isUser()
      ? "message-item-base message-user-bubble bg-[var(--message-user-bg)] border-r-[3px] border-[var(--message-user-border)]"
      : "message-item-base assistant-message bg-[var(--message-assistant-bg)] border-l-[3px] border-[var(--message-assistant-border)]"

  const speakerLabel = () => (isUser() ? "You" : "Assistant")

  const agentIdentifier = () => {
    if (isUser()) return ""
    const info = props.messageInfo
    if (!info || info.role !== "assistant") return ""
    return info.mode || ""
  }

  const modelIdentifier = () => {
    if (isUser()) return ""
    const info = props.messageInfo
    if (!info || info.role !== "assistant") return ""
    const modelID = info.modelID || ""
    const providerID = info.providerID || ""
    if (modelID && providerID) return `${providerID}/${modelID}`
    return modelID
  }

  const agentMeta = () => {
    if (isUser() || !props.showAgentMeta) return ""
    const segments: string[] = []
    const agent = agentIdentifier()
    const model = modelIdentifier()
    if (agent) {
      segments.push(`Agent: ${agent}`)
    }
    if (model) {
      segments.push(`Model: ${model}`)
    }
    return segments.join(" • ")
  }


  return (
    <div class={containerClass()}>
      <header class="message-item-header">
        <div class="message-speaker">
          <span class="message-speaker-label" data-role={isUser() ? "user" : "assistant"}>
            {speakerLabel()}
          </span>
          <Show when={agentMeta()}>{(meta) => <span class="message-agent-meta">{meta()}</span>}</Show>
        </div>
        <div class="message-header-right">
          <div class="message-item-actions">
            <Show when={isUser()}>
              <div class="message-action-group">
                <Show when={props.onRevert}>
                  <button
                    class="message-action-button"
                    onClick={handleRevert}
                    title="Revert to this message"
                    aria-label="Revert to this message"
                  >
                    Revert
                  </button>
                </Show>
                <Show when={props.onFork}>
                  <button
                    class="message-action-button"
                    onClick={() => props.onFork?.(props.record.id)}
                    title="Fork from this message"
                    aria-label="Fork from this message"
                  >
                    Fork
                  </button>
                </Show>
                <button
                  class="message-action-button"
                  onClick={handleCopy}
                  title="Copy message"
                  aria-label="Copy message"
                >
                  <Show when={copied()} fallback="Copy">
                    Copied!
                  </Show>
                </button>
              </div>
            </Show>
            <Show when={!isUser()}>
              <button
                class="message-action-button"
                onClick={handleCopy}
                title="Copy message"
                aria-label="Copy message"
              >
                <Show when={copied()} fallback="Copy">
                  Copied!
                </Show>
              </button>
            </Show>
          </div>
          <time class="message-timestamp" dateTime={timestampIso()}>{timestamp()}</time>
        </div>
      </header>

      <div class="pt-1 whitespace-pre-wrap break-words leading-[1.1]">


        <Show when={props.isQueued && isUser()}>
          <div class="message-queued-badge">QUEUED</div>
        </Show>

        <Show when={errorMessage()}>
          <div class="message-error-block">⚠️ {errorMessage()}</div>
        </Show>

        <Show when={isGenerating()}>
          <div class="message-generating">
            <span class="generating-spinner">⏳</span> Generating...
          </div>
        </Show>

        <For each={messageParts()}>
          {(part) => (
            <MessagePart
              part={part}
              messageType={props.record.role}
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              onRendered={props.onContentRendered}
            />
          )}
        </For>

        <Show when={fileAttachments().length > 0}>
          <div class="message-attachments mt-1">
            <For each={fileAttachments()}>
              {(attachment) => {
                const name = getAttachmentName(attachment)
                const isImage = isImageAttachment(attachment)
                return (
                  <div class={`attachment-chip ${isImage ? "attachment-chip-image" : ""}`} title={name}>
                    <Show when={isImage} fallback={
                      <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                        />
                      </svg>
                    }>
                      <img src={attachment.url} alt={name} class="h-5 w-5 rounded object-cover" />
                    </Show>
                    <span class="truncate max-w-[180px]">{name}</span>
                    <button
                      type="button"
                      onClick={() => void handleAttachmentDownload(attachment)}
                      class="attachment-download"
                      aria-label={`Download ${name}`}
                    >
                      <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12l4 4 4-4m-4-8v12" />
                      </svg>
                    </button>
                    <Show when={isImage}>
                      <div class="attachment-chip-preview">
                        <img src={attachment.url} alt={name} />
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>

        <Show when={props.record.status === "sending"}>
          <div class="message-sending">
            <span class="generating-spinner">●</span> Sending...
          </div>
        </Show>

        <Show when={props.record.status === "error"}>
          <div class="message-error">⚠ Message failed to send</div>
        </Show>
      </div>
    </div>
  )
}
