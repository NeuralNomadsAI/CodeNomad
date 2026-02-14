import { For, Show, createSignal } from "solid-js"
import { Copy, Split, Trash2, Undo } from "lucide-solid"
import type { MessageInfo, ClientPart } from "../types/message"
import { partHasRenderableText } from "../types/message"
import type { MessageRecord } from "../stores/message-v2/types"
import MessagePart from "./message-part"
import { copyToClipboard } from "../lib/clipboard"
import { useI18n } from "../lib/i18n"
import { showAlertDialog } from "../stores/alerts"
import { deleteMessagePart } from "../stores/session-actions"

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
  const { t } = useI18n()
  const [copied, setCopied] = createSignal(false)
  const [deletingParts, setDeletingParts] = createSignal<Set<string>>(new Set())

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

  // User messages can temporarily include synthetic helper parts (e.g. tool traces / file reads).
  // We only want to display the primary prompt text for the user message; other synthetic text
  // parts should be hidden.
  const primaryUserTextPartId = () => {
    if (!isUser()) return null
    const firstText = messageParts().find((part) => part?.type === "text") as { id?: string } | undefined
    return typeof firstText?.id === "string" ? firstText.id : null
  }

  const fileAttachments = () =>
    messageParts().filter((part): part is FilePart => part?.type === "file" && typeof (part as FilePart).url === "string")


  const getAttachmentName = (part: FilePart) => {
    if (part.filename && part.filename.trim().length > 0) {
      return part.filename
    }
    const url = part.url || ""
    if (url.startsWith("data:")) {
      return t("messageItem.attachment.defaultName")
    }
    try {
      const parsed = new URL(url)
      const segments = parsed.pathname.split("/")
      return segments.pop() || t("messageItem.attachment.defaultName")
    } catch (error) {
      const fallback = url.split("/").pop()
      return fallback && fallback.length > 0 ? fallback : t("messageItem.attachment.defaultName")
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
      return error.data?.message || t("messageItem.errors.authenticationFallback")
    }
    if (error.name === "MessageOutputLengthError") {
      return t("messageItem.errors.outputLengthExceeded")
    }
    if (error.name === "MessageAbortedError") {
      return t("messageItem.errors.requestAborted")
    }
    if (error.name === "UnknownError") {
      return error.data?.message || t("messageItem.errors.unknownFallback")
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
    if (hasContent()) {
      return false
    }

    // Prefer the local record status for streaming placeholders.
    if (!isUser() && props.record.status === "streaming") {
      return true
    }

    const info = props.messageInfo
    return Boolean(info && info.role === "assistant" && info.time.completed !== undefined && info.time.completed === 0)
  }

  const handleRevert = () => {
    if (props.onRevert && isUser()) {
      props.onRevert(props.record.id)
    }
  }

  const copyLabel = () => (copied() ? t("messageItem.actions.copied") : t("messageItem.actions.copy"))

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

  const deletableTextPartId = () => {
    const part = props.parts.find((candidate) => {
      if (!candidate || candidate.type !== "text") return false
      const id = (candidate as any).id
      if (typeof id !== "string" || id.length === 0) return false
      return !Boolean((candidate as any).synthetic)
    })
    return (part as any)?.id as string | undefined
  }

  const isDeletingPart = (partId?: string) => {
    if (!partId) return false
    return deletingParts().has(partId)
  }

  const setPartDeleting = (partId: string, value: boolean) => {
    setDeletingParts((prev) => {
      const next = new Set(prev)
      if (value) {
        next.add(partId)
      } else {
        next.delete(partId)
      }
      return next
    })
  }

  const handleDeletePart = async (partId?: string) => {
    if (!partId) return
    if (isDeletingPart(partId)) return
    setPartDeleting(partId, true)
    try {
      await deleteMessagePart(props.instanceId, props.sessionId, props.record.id, partId)
    } catch (error) {
      showAlertDialog(t("messagePart.actions.deleteFailedMessage"), {
        title: t("messagePart.actions.deleteFailedTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      setPartDeleting(partId, false)
    }
  }

  if (!isUser() && !hasContent() && !isGenerating()) {
    return null
  }

  const containerClass = () =>
    isUser()
      ? "message-item-base bg-[var(--message-user-bg)] border-l-4 border-[var(--message-user-border)]"
      : "message-item-base assistant-message bg-[var(--message-assistant-bg)] border-l-4 border-[var(--message-assistant-border)]"

  const speakerLabel = () => (isUser() ? t("messageItem.speaker.you") : t("messageItem.speaker.assistant"))

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
      segments.push(t("messageItem.agentMeta.agentLabel", { agent }))
    }
    if (model) {
      segments.push(t("messageItem.agentMeta.modelLabel", { model }))
    }
    return segments.join(" • ")
  }


  return (
    <div class={containerClass()}>
      <header class={`message-item-header ${isUser() ? "pb-0.5" : "pb-0"}`}>
        <div class="message-item-header-row message-item-header-row--top">
          <div class="message-speaker">
            <span class="message-speaker-label" data-role={isUser() ? "user" : "assistant"}>
              {speakerLabel()}
            </span>
          </div>

          <div class="message-item-actions">
            <Show when={isUser()}>
              <div class="message-action-group">
                <Show when={props.onRevert}>
                  <button
                    class="message-action-button"
                    onClick={handleRevert}
                    title={t("messageItem.actions.revert")}
                    aria-label={t("messageItem.actions.revert")}
                  >
                    <Undo class="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </Show>
                <Show when={props.onFork}>
                  <button
                    class="message-action-button"
                    onClick={() => props.onFork?.(props.record.id)}
                    title={t("messageItem.actions.fork")}
                    aria-label={t("messageItem.actions.fork")}
                  >
                    <Split class="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </Show>
                <button
                  class="message-action-button"
                  onClick={handleCopy}
                  title={copyLabel()}
                  aria-label={copyLabel()}
                >
                  <Copy class="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </Show>
            <Show when={!isUser()}>
              <div class="message-action-group">
                <button
                  class="message-action-button"
                  onClick={handleCopy}
                  title={copyLabel()}
                  aria-label={copyLabel()}
                >
                  <Copy class="w-3.5 h-3.5" aria-hidden="true" />
                </button>

                <Show when={deletableTextPartId()}>
                  {(partId) => (
                    <button
                      class="message-action-button"
                      onClick={() => void handleDeletePart(partId())}
                      disabled={isDeletingPart(partId())}
                      title={isDeletingPart(partId()) ? t("messagePart.actions.deleting") : t("messagePart.actions.delete")}
                      aria-label={isDeletingPart(partId()) ? t("messagePart.actions.deleting") : t("messagePart.actions.delete")}
                    >
                      <Trash2 class="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  )}
                </Show>
              </div>
            </Show>
            <time class="message-timestamp" dateTime={timestampIso()}>{timestamp()}</time>
          </div>
        </div>

        <Show when={agentMeta()}>
          {(meta) => (
            <div class="message-item-header-row message-item-header-row--bottom">
              <span class="message-agent-meta">{meta()}</span>
            </div>
          )}
        </Show>

      </header>

      <div class="pt-1 whitespace-pre-wrap break-words leading-[1.1]">


        <Show when={props.isQueued && isUser()}>
          <div class="message-queued-badge">{t("messageItem.status.queued")}</div>
        </Show>

        <Show when={errorMessage()}>
          <div class="message-error-block">⚠️ {errorMessage()}</div>
        </Show>

        <Show when={isGenerating()}>
          <div class="message-generating">
            <span class="generating-spinner">⏳</span> {t("messageItem.status.generating")}
          </div>
        </Show>

        <For each={messageParts()}>
          {(part) => (
            <MessagePart
              part={part}
              messageType={props.record.role}
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              primaryUserTextPartId={primaryUserTextPartId()}
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
                      aria-label={t("messageItem.attachment.downloadAriaLabel", { name })}
                    >
                      <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12l4 4 4-4m-4-8v12" />
                      </svg>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleDeletePart(attachment.id)}
                      class="attachment-remove"
                      disabled={isDeletingPart(attachment.id)}
                      aria-label={t("messagePart.actions.deleteTitle")}
                      title={t("messagePart.actions.deleteTitle")}
                    >
                      <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
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
            <span class="generating-spinner">●</span> {t("messageItem.status.sending")}
          </div>
        </Show>

        <Show when={props.record.status === "error"}>
          <div class="message-error">⚠ {t("messageItem.status.failedToSend")}</div>
        </Show>
      </div>
    </div>
  )
}
