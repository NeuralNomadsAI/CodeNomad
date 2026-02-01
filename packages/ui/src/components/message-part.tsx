import { Show, Match, Switch } from "solid-js"
import ToolCall from "./tool-call"
import { isItemExpanded, toggleItemExpanded } from "../stores/tool-call-state"
import { Markdown } from "./markdown"
import { useTheme } from "../lib/theme"
import { useConfig } from "../stores/preferences"
import { partHasRenderableText, SDKPart, TextPart, ClientPart } from "../types/message"
import { cn } from "../lib/cn"

type ToolCallPart = Extract<ClientPart, { type: "tool" }>

interface MessagePartProps {
  part: ClientPart
  messageType?: "user" | "assistant"
  instanceId: string
  sessionId: string
  onRendered?: () => void
 }
 export default function MessagePart(props: MessagePartProps) {

  const { isDark } = useTheme()
  const { preferences } = useConfig()
  const partType = () => props.part?.type || ""
  const reasoningId = () => `reasoning-${props.part?.id || ""}`
  const isReasoningExpanded = () => isItemExpanded(reasoningId())
  const isAssistantMessage = () => props.messageType === "assistant"
  const textContainerClass = () =>
    cn(
      "text-base leading-relaxed break-words overflow-wrap-anywhere",
      isAssistantMessage() && "whitespace-normal"
    )

  const plainTextContent = () => {
    const part = props.part

    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
      return part.text
    }

    return ""
  }

  function reasoningSegmentHasText(segment: unknown): boolean {
    if (typeof segment === "string") {
      return segment.trim().length > 0
    }
    if (segment && typeof segment === "object") {
      const candidate = segment as { text?: unknown; value?: unknown; content?: unknown[] }
      if (typeof candidate.text === "string" && candidate.text.trim().length > 0) {
        return true
      }
      if (typeof candidate.value === "string" && candidate.value.trim().length > 0) {
        return true
      }
      if (Array.isArray(candidate.content)) {
        return candidate.content.some((entry) => reasoningSegmentHasText(entry))
      }
    }
    return false
  }

  const hasReasoningContent = () => {
    if (props.part?.type !== "reasoning") {
      return false
    }
    if (reasoningSegmentHasText((props.part as any).text)) {
      return true
    }
    if (Array.isArray((props.part as any).content)) {
      return (props.part as any).content.some((entry: unknown) => reasoningSegmentHasText(entry))
    }
    return false
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
              <Markdown
                part={createTextPartForMarkdown()}
                isDark={isDark()}
                size={isAssistantMessage() ? "tight" : "base"}
                onRendered={props.onRendered}
              />
             </Show>

          </div>
        </Show>
      </Match>

      <Match when={partType() === "tool"}>
        <ToolCall
          toolCall={props.part as ToolCallPart}
          toolCallId={props.part?.id}
          instanceId={props.instanceId}
          sessionId={props.sessionId}
        />
      </Match>




    </Switch>
  )
}
