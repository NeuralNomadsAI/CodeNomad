import { For, Show } from "solid-js"
import type { Message } from "../types/message"
import MessagePart from "./message-part"

interface MessageItemProps {
  message: Message
  messageInfo?: any
}

export default function MessageItem(props: MessageItemProps) {
  const isUser = () => props.message.type === "user"
  const timestamp = () => {
    const date = new Date(props.message.timestamp)
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

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
    return props.message.parts.length > 0 || errorMessage() !== null
  }

  const isGenerating = () => {
    return !hasContent() && props.messageInfo?.time?.completed === 0
  }

  return (
    <div class={`message-item ${isUser() ? "user" : "assistant"}`}>
      <div class="message-header">
        <span class="message-sender">{isUser() ? "You" : "Assistant"}</span>
        <span class="message-timestamp">{timestamp()}</span>
      </div>

      <div class="message-content">
        <Show when={errorMessage()}>
          <div class="message-error-block">⚠️ {errorMessage()}</div>
        </Show>

        <Show when={isGenerating()}>
          <div class="message-generating">
            <span class="generating-spinner">⏳</span> Generating...
          </div>
        </Show>

        <For each={props.message.parts}>{(part) => <MessagePart part={part} />}</For>
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
