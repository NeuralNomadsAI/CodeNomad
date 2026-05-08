import { For, Match, Show, Suspense, Switch, createMemo, lazy } from "solid-js"
import { isItemExpanded, toggleItemExpanded } from "../stores/tool-call-state"
import { Markdown } from "./markdown"
import { useTheme } from "../lib/theme"
import { partHasRenderableText, SDKPart, TextPart, ClientPart } from "../types/message"
import { useI18n } from "../lib/i18n"
import { splitHiddenPromptSections, type HiddenPromptDisplayMetadata } from "../lib/hidden-prompt-sections"

type ToolCallPart = Extract<ClientPart, { type: "tool" }>

const LazyToolCall = lazy(() => import("./tool-call"))

interface MessagePartProps {
  part: ClientPart
  messageType?: "user" | "assistant"
  instanceId: string
  sessionId: string
  // For user messages, keep the primary prompt text visible even when synthetic (optimistic).
  // Other synthetic text parts (tool traces, read outputs, etc.) should be hidden.
  primaryUserTextPartId?: string | null
  displayMetadataOverride?: HiddenPromptDisplayMetadata
  onRendered?: () => void
}

export default function MessagePart(props: MessagePartProps) {

  const { t } = useI18n()
  const { isDark } = useTheme()
  const partType = () => props.part?.type || ""
  const reasoningId = () => `reasoning-${props.part?.id || ""}`
  const isReasoningExpanded = () => isItemExpanded(reasoningId())
  const isAssistantMessage = () => props.messageType === "assistant"
  const textContainerClass = () => (isAssistantMessage() ? "message-text message-text-assistant" : "message-text")
  const markdownContainerClass = () => "message-text message-text-assistant"
  const textContainerRole = () => props.messageType || "assistant"

  const shouldHideTextPart = () => {
    const part = props.part
    if (!part || part.type !== "text") return false
    return Boolean((part as any).synthetic)
  }


  const plainTextContent = () => {
    const part = props.part

    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
      return part.text
    }

    return ""
  }

  const canRenderMarkdown = () => {
    const id = (props.part as unknown as { id?: unknown })?.id
    return typeof id === "string" && id.length > 0
  }

  const hiddenPromptSegments = createMemo(() => {
    if (props.messageType !== "user") return null
    if (props.part?.type !== "text") return null
    if (typeof props.part.text !== "string") return null

    return splitHiddenPromptSections(props.part.text, props.displayMetadataOverride)
  })

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
    if (part.type === "text" && typeof part.text === "string") {
      // Pass through the original part so `renderCache` updates persist.
      return part as unknown as TextPart
    }

    if (part.type === "reasoning" && typeof (part as any).text === "string") {
      // Reasoning parts render as markdown in some views; normalize to TextPart.
      return {
        id: part.id,
        type: "text",
        text: (part as any).text,
        synthetic: false,
        version: (part as { version?: number }).version,
        renderCache: (part as any).renderCache,
      }
    }

    return {
      id: part.id,
      type: "text",
      text: "",
      synthetic: false,
    }
  }

  function createSegmentTextPart(text: string, index: number): TextPart {
    return {
      id: `${String((props.part as { id?: string }).id ?? "text")}:display:${index}`,
      type: "text",
      text,
      synthetic: false,
    }
  }

  function handleReasoningClick(e: Event) {
    e.preventDefault()
    toggleItemExpanded(reasoningId())
  }

  return (
    <Switch>
      <Match when={partType() === "text"}>
        <Show when={!shouldHideTextPart() && partHasRenderableText(props.part)}>
          <div
            class={canRenderMarkdown() ? markdownContainerClass() : textContainerClass()}
            dir="auto"
            data-role={textContainerRole()}
            data-part-type="text"
            data-part-id={typeof (props.part as any)?.id === "string" ? (props.part as any).id : undefined}
          >
            <Show
              when={hiddenPromptSegments()}
              fallback={
                <Show when={canRenderMarkdown()} fallback={<span class="text-primary" dir="auto">{plainTextContent()}</span>}>
                  <Markdown
                    part={createTextPartForMarkdown()}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    isDark={isDark()}
                    size={isAssistantMessage() ? "tight" : "base"}
                    escapeRawHtml={props.messageType === "user"}
                    onRendered={props.onRendered}
                  />
                </Show>
              }
            >
              {(segments) => (
                <div class="flex flex-col gap-2">
                  <For each={segments().filter((segment) => segment.text.length > 0)}>
                    {(segment, index) =>
                      segment.hidden ? (
                        <details class="rounded-md border border-base bg-surface-secondary px-3 py-2">
                          <summary class="cursor-pointer select-none text-xs font-medium text-secondary">
                            {t("messagePart.hiddenPrompt.summary")}
                          </summary>
                          <div class="pt-2">
                            <Markdown
                              part={createSegmentTextPart(segment.text, index())}
                              instanceId={props.instanceId}
                              sessionId={props.sessionId}
                              isDark={isDark()}
                              size="base"
                              escapeRawHtml
                              onRendered={props.onRendered}
                            />
                          </div>
                        </details>
                      ) : (
                        <Markdown
                          part={createSegmentTextPart(segment.text, index())}
                          instanceId={props.instanceId}
                          sessionId={props.sessionId}
                          isDark={isDark()}
                          size="base"
                          escapeRawHtml
                          onRendered={props.onRendered}
                        />
                      )
                    }
                  </For>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </Match>

      <Match when={partType() === "tool"}>
        <Suspense fallback={<div class="tool-call tool-call-loading" />}>
          <LazyToolCall
            toolCall={props.part as ToolCallPart}
            toolCallId={props.part?.id}
            instanceId={props.instanceId}
            sessionId={props.sessionId}
          />
        </Suspense>
      </Match>




    </Switch>
  )
}
