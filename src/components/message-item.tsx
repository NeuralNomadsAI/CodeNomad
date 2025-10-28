import { For, Show } from "solid-js"
import type { Message } from "../types/message"
import MessagePart from "./message-part"

interface MessageItemProps {
  message: Message
  messageInfo?: any
  isQueued?: boolean
  parts?: any[]
  onRevert?: (messageId: string) => void
}

export default function MessageItem(props: MessageItemProps) {
  const isUser = () => props.message.type === "user"
  const timestamp = () => {
    const date = new Date(props.message.timestamp)
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  const messageParts = () => props.parts ?? props.message.parts

  const errorMessage = () => {
    if (!props.messageInfo?.error) return null

    const error = props.messageInfo.error
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
    return messageParts().length > 0 || errorMessage() !== null
  }

  const isGenerating = () => {
    return !hasContent() && props.messageInfo?.time?.completed === 0
  }

  const handleRevert = () => {
    if (props.onRevert && isUser()) {
      props.onRevert(props.message.id)
    }
  }

  return (
    <div 
      class={`message-item-base ${
        isUser() 
          ? "bg-[var(--message-user-bg)] border-l-4 border-[var(--message-user-border)]" 
          : "bg-[var(--message-assistant-bg)] border-l-4 border-[var(--message-assistant-border)]"
      }`}
    >
      <div class="flex justify-between items-center gap-3">
        <span class="font-semibold text-sm text-[var(--text-muted)]">
          {isUser() ? "You" : "Assistant"}
        </span>
        <span class="text-xs text-[var(--text-muted)]">{timestamp()}</span>
        <Show when={isUser() && props.onRevert}>
          <button
            class="bg-transparent border border-[var(--border-base)] text-[var(--text-muted)] cursor-pointer px-2 py-0.5 rounded text-base leading-none transition-all duration-200 flex items-center justify-center min-w-7 h-6 hover:bg-[var(--surface-hover)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] active:scale-95"
            onClick={handleRevert}
            title="Revert to this message"
            aria-label="Revert to this message"
          >
            ↶
          </button>
        </Show>
      </div>

      <div class="pt-1.5 leading-relaxed whitespace-pre-wrap break-words">
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

        <For each={messageParts()}>{(part) => <MessagePart part={part} />}</For>
      </div>

      <Show when={props.message.status === "sending"}>
        <div class="message-sending">
          <span class="generating-spinner">●</span> Sending...
        </div>
      </Show>

      <Show when={props.message.status === "error"}>
        <div class="message-error">⚠ Message failed to send</div>
      </Show>
    </div>
  )
}
