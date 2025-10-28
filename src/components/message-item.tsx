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
    <div class={`message-item ${isUser() ? "user" : "assistant"}`}>
      <div class="message-header">
        <span class="message-sender">{isUser() ? "You" : "Assistant"}</span>
        <span class="message-timestamp">{timestamp()}</span>
        <Show when={isUser() && props.onRevert}>
          <button
            class="message-revert-button"
            onClick={handleRevert}
            title="Revert to this message"
            aria-label="Revert to this message"
          >
            ↶
          </button>
        </Show>
      </div>

      <div class="message-content">
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
