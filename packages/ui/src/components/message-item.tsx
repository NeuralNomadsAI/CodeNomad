import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { Copy, ListStart, Split, Trash, Undo } from "lucide-solid"
import type { MessageInfo, ClientPart, SDKAssistantMessageV2 } from "../types/message"
import { partHasRenderableText } from "../types/message"
import type { MessageRecord } from "../stores/message-v2/types"
import MessagePart from "./message-part"
import { copyToClipboard } from "../lib/clipboard"
import { useI18n } from "../lib/i18n"
import { showAlertDialog } from "../stores/alerts"
import { deleteMessage } from "../stores/session-actions"
import { isTauriHost } from "../lib/runtime-env"
import type { DeleteHoverState } from "../types/delete-hover"

function DeleteUpToIcon() {
  return (
    <span class="relative inline-block w-3.5 h-3.5" aria-hidden="true">
      <ListStart class="absolute inset-0 w-3.5 h-3.5" aria-hidden="true" />
    </span>
  )
}

interface MessageItemProps {
  record: MessageRecord
  messageInfo?: MessageInfo
  instanceId: string
  sessionId: string
  isQueued?: boolean
  parts: ClientPart[]
  onRevert?: (messageId: string) => void
  selectedMessageIds?: () => Set<string>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  onFork?: (messageId?: string) => void
  showAgentMeta?: boolean
  onContentRendered?: () => void
  showDeleteMessage?: boolean
  onDeleteHoverChange?: (state: DeleteHoverState) => void
}

export default function MessageItem(props: MessageItemProps) {
  const { t } = useI18n()
  const [copied, setCopied] = createSignal(false)
  const [deletingMessage, setDeletingMessage] = createSignal(false)
  const [deletingUpTo, setDeletingUpTo] = createSignal(false)

  type ImagePreviewState = {
    url: string
    name: string
    anchor: HTMLElement
  }

  const [imagePreview, setImagePreview] = createSignal<ImagePreviewState | null>(null)

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

  const getImagePreviewPosition = () => {
    const state = imagePreview()
    if (!state) return null

    const rect = state.anchor.getBoundingClientRect()

    // Outer box: 320px image + 8px padding on each side.
    const padding = 8
    const maxImage = 320
    const gap = 8
    const chrome = padding * 2
    const outerWidth = maxImage + chrome
    const outerHeight = maxImage + chrome

    const viewportW = window.innerWidth
    const viewportH = window.innerHeight

    const left = clamp(rect.left, 8, Math.max(8, viewportW - outerWidth - 8))

    const fitsAbove = rect.top >= outerHeight + gap + 8
    const preferredTop = fitsAbove ? rect.top - outerHeight - gap : rect.bottom + gap
    const top = clamp(preferredTop, 8, Math.max(8, viewportH - outerHeight - 8))

    return { left, top }
  }

  createEffect(() => {
    const active = imagePreview()
    if (!active) return

    // If the user scrolls (message stream scroll container) or resizes, the anchor moves.
    // Hide the popover to avoid showing it in the wrong place.
    const hide = () => setImagePreview(null)
    window.addEventListener("scroll", hide, true)
    window.addEventListener("resize", hide)
    onCleanup(() => {
      window.removeEventListener("scroll", hide, true)
      window.removeEventListener("resize", hide)
    })
  })

  const isSelectedForDeletion = () => Boolean(props.selectedMessageIds?.().has(props.record.id))

  let topRowEl: HTMLDivElement | undefined
  let actionsEl: HTMLDivElement | undefined
  let speakerPrimaryEl: HTMLDivElement | undefined
  let metaMeasureEl: HTMLSpanElement | undefined
  const [showMetaInline, setShowMetaInline] = createSignal(true)

  const metaText = () => agentMeta()

  const updateMetaLayout = () => {
    const text = metaText()
    if (!text) return
    if (!topRowEl || !actionsEl || !speakerPrimaryEl || !metaMeasureEl) return

    const rowWidth = topRowEl.getBoundingClientRect().width
    const actionsWidth = actionsEl.getBoundingClientRect().width
    const primaryWidth = speakerPrimaryEl.getBoundingClientRect().width
    const metaWidth = metaMeasureEl.getBoundingClientRect().width

    // Allow for the flex gap between left and actions.
    const availableLeft = Math.max(0, rowWidth - actionsWidth - 12)
    setShowMetaInline(primaryWidth + metaWidth + 8 <= availableLeft)
  }

  createEffect(() => {
    const text = metaText()
    if (!text || typeof ResizeObserver === "undefined") {
      setShowMetaInline(true)
      return
    }

    updateMetaLayout()
    const observer = new ResizeObserver(() => updateMetaLayout())
    if (topRowEl) observer.observe(topRowEl)
    if (actionsEl) observer.observe(actionsEl)
    if (speakerPrimaryEl) observer.observe(speakerPrimaryEl)
    onCleanup(() => observer.disconnect())
  })

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
      // Local filesystem URLs are not reliably downloadable from the message stream.
      // We hide the download action for these chips.
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

  const showImagePreview = (anchor: HTMLElement, url: string, name: string) => {
    if (!url) return
    setImagePreview({ anchor, url, name })
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
    const timeInfo = info?.time as { created: number; end?: number } | undefined
    return Boolean(info && info.role === "assistant" && (timeInfo?.end === undefined || timeInfo?.end === 0))
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

  const handleDeleteMessage = async () => {
    if (deletingMessage()) return
    setDeletingMessage(true)
    try {
      await deleteMessage(props.instanceId, props.sessionId, props.record.id)
    } catch (error) {
      showAlertDialog(t("messageItem.actions.deleteMessageFailedMessage"), {
        title: t("messageItem.actions.deleteMessageFailedTitle"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      setDeletingMessage(false)
    }
  }

  const handleDeleteUpTo = async () => {
    if (!props.onDeleteMessagesUpTo) return
    if (deletingUpTo()) return
    setDeletingUpTo(true)
    try {
      await props.onDeleteMessagesUpTo(props.record.id)
    } finally {
      setDeletingUpTo(false)
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

    const base = modelID && providerID ? `${providerID}/${modelID}` : modelID
    if (!base) return ""

    const variant = (info as SDKAssistantMessageV2).variant
    if (typeof variant === "string" && variant.trim().length > 0) {
      return `${base} (${variant.trim()})`
    }

    return base
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
    <div
      class={containerClass()}
      data-view="message-item"
      data-instance-id={props.instanceId}
      data-session-id={props.sessionId}
      data-message-id={props.record.id}
      data-message-role={isUser() ? "user" : "assistant"}
      data-message-status={props.record.status}
    >
      <header class={`message-item-header ${isUser() ? "pb-0.5" : "pb-0"}`}>
        <div class="message-item-header-row message-item-header-row--top" ref={(el) => (topRowEl = el)}>
          <div class="message-header-left">
            <div class="message-speaker-primary" ref={(el) => (speakerPrimaryEl = el)}>
              <Show when={props.showDeleteMessage}>
                <input
                  class="message-select-checkbox"
                  type="checkbox"
                  checked={isSelectedForDeletion()}
                  onClick={(event) => {
                    event.stopPropagation()
                  }}
                  onChange={(event) => {
                    event.stopPropagation()
                    const next = Boolean((event.currentTarget as HTMLInputElement).checked)
                    props.onToggleSelectedMessage?.(props.record.id, next)
                  }}
                  aria-label={t("messageItem.selection.checkboxAriaLabel")}
                  title={t("messageItem.selection.checkboxAriaLabel")}
                />
              </Show>

              <span class="message-speaker-label" data-role={isUser() ? "user" : "assistant"}>
                {speakerLabel()}
              </span>
            </div>

            <Show when={metaText() && showMetaInline()}>
              <span class="message-agent-meta-inline">{metaText()}</span>
            </Show>

            <Show when={metaText()}>
              <span
                ref={(el) => (metaMeasureEl = el)}
                class="message-agent-meta-inline message-agent-meta-inline--measure"
              >
                {metaText()}
              </span>
            </Show>
          </div>

          <div class="message-item-actions" ref={(el) => (actionsEl = el)}>
            <Show when={isUser()}>
              <div class="message-action-group">
                <button
                  class="message-action-button"
                  onClick={handleCopy}
                  title={copyLabel()}
                  aria-label={copyLabel()}
                >
                  <Copy class="w-3.5 h-3.5" aria-hidden="true" />
                </button>

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

                <Show when={props.onRevert}>
                  <button
                    class="message-action-button"
                    onClick={handleRevert}
                    title={t("messageItem.actions.revertTitle")}
                    aria-label={t("messageItem.actions.revertTitle")}
                  >
                    <Undo class="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </Show>

                <Show when={props.showDeleteMessage}>
                  <button
                    class="message-action-button"
                    onClick={() => void handleDeleteUpTo()}
                    disabled={!props.onDeleteMessagesUpTo || deletingUpTo()}
                    onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "deleteUpTo", messageId: props.record.id })}
                    onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
                    title={t("messageItem.actions.deleteMessagesUpTo")}
                    aria-label={t("messageItem.actions.deleteMessagesUpTo")}
                  >
                    <DeleteUpToIcon />
                  </button>

                  <button
                    class="message-action-button"
                    onClick={handleDeleteMessage}
                    disabled={deletingMessage()}
                    onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "message", messageId: props.record.id })}
                    onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
                    title={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
                    aria-label={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
                  >
                    <Trash class="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </Show>
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

                <Show when={props.showDeleteMessage}>
                  <button
                    class="message-action-button"
                    onClick={() => void handleDeleteUpTo()}
                    disabled={!props.onDeleteMessagesUpTo || deletingUpTo()}
                    onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "deleteUpTo", messageId: props.record.id })}
                    onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
                    title={t("messageItem.actions.deleteMessagesUpTo")}
                    aria-label={t("messageItem.actions.deleteMessagesUpTo")}
                  >
                    <DeleteUpToIcon />
                  </button>

                  <button
                    class="message-action-button"
                    onClick={handleDeleteMessage}
                    disabled={deletingMessage()}
                    onMouseEnter={() => props.onDeleteHoverChange?.({ kind: "message", messageId: props.record.id })}
                    onMouseLeave={() => props.onDeleteHoverChange?.({ kind: "none" })}
                    title={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
                    aria-label={deletingMessage() ? t("messageItem.actions.deletingMessage") : t("messageItem.actions.deleteMessage")}
                  >
                    <Trash class="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </Show>
              </div>
            </Show>
            <time class="message-timestamp" dateTime={timestampIso()}>{timestamp()}</time>
          </div>
        </div>

        <Show when={metaText() && !showMetaInline()}>
          <div class="message-item-header-row message-item-header-row--meta">
            <span class="message-agent-meta-block">{metaText()}</span>
          </div>
        </Show>

      </header>

      <div class="pt-1 whitespace-pre-wrap break-words leading-[1.1]" dir="auto">


        <Show when={props.isQueued && isUser()}>
          <div class="message-queued-badge">{t("messageItem.status.queued")}</div>
        </Show>

        <Show when={errorMessage()}>
          <div class="message-error-block" dir="auto">⚠️ {errorMessage()}</div>
        </Show>

        <Show when={isGenerating()}>
          <div class="message-generating">
            <span class="generating-spinner">⏳</span> {t("messageItem.status.generating")}
          </div>
        </Show>

        <For each={messageParts()}>
          {(part) => {
            return (
              <div class="message-part-shell">
                <MessagePart
                  part={part}
                  messageType={props.record.role}
                  instanceId={props.instanceId}
                  sessionId={props.sessionId}
                  primaryUserTextPartId={primaryUserTextPartId()}
                  onRendered={props.onContentRendered}
                />
              </div>
            )
          }}
        </For>

        <Show when={fileAttachments().length > 0}>
          <div class="message-attachments mt-1">
            <For each={fileAttachments()}>
              {(attachment) => {
                const name = getAttachmentName(attachment)
                const isImage = isImageAttachment(attachment)
                return (
                  <div
                    class={`attachment-chip ${isImage ? "attachment-chip-image" : ""}`}
                    title={name}
                    onMouseEnter={(e) => {
                      if (!isImage) return
                      const el = e.currentTarget as HTMLElement
                      showImagePreview(el, attachment.url || "", name)
                    }}
                    onMouseLeave={() => setImagePreview(null)}
                  >
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
                    <Show when={!attachment.url?.startsWith("file://")}>
                      <button
                        type="button"
                        onClick={() => void handleAttachmentDownload(attachment)}
                        class="attachment-download"
                        aria-label={t("messageItem.attachment.downloadAriaLabel", { name })}
                        title={t("messageItem.attachment.downloadAriaLabel", { name })}
                      >
                        <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12l4 4 4-4m-4-8v12" />
                        </svg>
                      </button>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>

        <Show when={imagePreview()}>
          {(stateAccessor) => {
            const state = stateAccessor()
            const pos = () => getImagePreviewPosition()
            return (
              <Portal>
                <Show when={pos()}>
                  {(posAccessor) => {
                    const coords = posAccessor()
                    return (
                      <div
                        class="attachment-image-popover"
                        style={{ left: `${coords.left}px`, top: `${coords.top}px` }}
                        aria-hidden="true"
                      >
                        <img src={state.url} alt={state.name} />
                      </div>
                    )
                  }}
                </Show>
              </Portal>
            )
          }}
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
