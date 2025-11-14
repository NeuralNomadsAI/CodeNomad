import { Show, Match, Switch } from "solid-js"
import ToolCall from "./tool-call"
import { isItemExpanded, toggleItemExpanded } from "../stores/tool-call-state"
import { Markdown } from "./markdown"
import { useTheme } from "../lib/theme"
import { useConfig } from "../stores/preferences"
import { partHasRenderableText, SDKPart, TextPart, ClientPart } from "../types/message"

type ToolCallPart = Extract<ClientPart, { type: "tool" }>

interface MessagePartProps {
  part: ClientPart
  messageType?: "user" | "assistant"
}
export default function MessagePart(props: MessagePartProps) {
  const { isDark } = useTheme()
  const { preferences } = useConfig()
  const partType = () => props.part?.type || ""
  const reasoningId = () => `reasoning-${props.part?.id || ""}`
  const isReasoningExpanded = () => isItemExpanded(reasoningId())
  const isAssistantMessage = () => props.messageType === "assistant"
  const textContainerClass = () => (isAssistantMessage() ? "message-text message-text-assistant" : "message-text")

  const plainTextContent = () => {
    const part = props.part

    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
      return part.text
    }

    return ""
  }

  const createTextPartForMarkdown = (): TextPart => {
    const part = props.part
    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
      return {
        id: part.id,
        type: "text",
        text: part.text,
        synthetic: part.type === "text" ? part.synthetic : false,
        version: (part as { version?: number }).version
      }
    }
    return {
      id: part.id,
      type: "text", 
      text: "",
      synthetic: false
    }
  }

  function handleReasoningClick(e: Event) {
    e.preventDefault()
    toggleItemExpanded(reasoningId())
  }

  return (
    <Switch>
      <Match when={partType() === "text"}>
        <Show when={!(props.part.type === "text" && props.part.synthetic) && partHasRenderableText(props.part)}>
          <div class={textContainerClass()}>
            <Show
              when={isAssistantMessage()}
              fallback={<span>{plainTextContent()}</span>}
            >
              <Markdown part={createTextPartForMarkdown()} isDark={isDark()} size={isAssistantMessage() ? "tight" : "base"} />
            </Show>
          </div>
        </Show>
      </Match>

      <Match when={partType() === "tool"}>
        <ToolCall toolCall={props.part as ToolCallPart} toolCallId={props.part?.id} />
      </Match>



      <Match when={partType() === "reasoning"}>
        <Show when={preferences().showThinkingBlocks && partHasRenderableText(props.part)}>
          <div class="message-reasoning">
            <div class="reasoning-container">
              <div class="reasoning-header" onClick={handleReasoningClick}>
                <span class="reasoning-icon">{isReasoningExpanded() ? "▼" : "▶"}</span>
                <span class="reasoning-label">Reasoning</span>
              </div>
              <Show when={isReasoningExpanded()}>
                <div class={`${textContainerClass()} mt-2`}>
                  <Markdown part={createTextPartForMarkdown()} isDark={isDark()} size={isAssistantMessage() ? "tight" : "base"} />
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </Match>
    </Switch>
  )
}
