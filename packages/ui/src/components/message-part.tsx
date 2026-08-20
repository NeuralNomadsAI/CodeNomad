import { For, Match, Show, Suspense, Switch, createMemo, createSignal, lazy } from "solid-js"
import { ChevronsDownUp, ChevronsUpDown, Copy } from "lucide-solid"
import { Markdown } from "./markdown"
import { useTheme } from "../lib/theme"
import { partHasRenderableText, TextPart, ClientPart } from "../types/message"
import { useI18n } from "../lib/i18n"
import { splitPromptDisplaySections, type PromptDisplayMetadata } from "../lib/prompt-display-metadata"
import { copyToClipboard } from "../lib/clipboard"
import { getPastedTextLineCount } from "../lib/pasted-text-display"

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
  displayMetadataOverride?: PromptDisplayMetadata
  onRendered?: () => void
}

export default function MessagePart(props: MessagePartProps) {

  const { t } = useI18n()
  const { isDark } = useTheme()
  const partType = () => props.part?.type || ""
  const isAssistantMessage = () => props.messageType === "assistant"
  const textContainerClass = () => (isAssistantMessage() ? "message-text message-text-assistant" : "message-text")
  const markdownContainerClass = () => "message-text message-text-assistant"
  const textContainerRole = () => props.messageType || "assistant"
  const isPrimaryUserTextPart = () =>
    props.messageType === "user" &&
    props.part?.type === "text" &&
    typeof props.primaryUserTextPartId === "string" &&
    props.primaryUserTextPartId.length > 0 &&
    props.part.id === props.primaryUserTextPartId

  const shouldHideTextPart = () => {
    const part = props.part
    if (!part || part.type !== "text") return false
    if (isPrimaryUserTextPart()) return false
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

  const promptDisplaySegments = createMemo(() => {
    if (props.messageType !== "user") return null
    if (props.part?.type !== "text") return null
    if (typeof props.part.text !== "string") return null

    return splitPromptDisplaySections(props.part.text, props.displayMetadataOverride)
  })

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

  function PastedTextDisclosure(disclosureProps: { text: string; index: number }) {
    const [hasExpanded, setHasExpanded] = createSignal(false)
    const [isOpen, setIsOpen] = createSignal(false)
    const [copied, setCopied] = createSignal(false)
    const lineCount = () => getPastedTextLineCount(disclosureProps.text)
    const lineCountLabel = () =>
      lineCount() === 1
        ? t("messagePart.pastedText.lines.one", { count: String(lineCount()) })
        : t("messagePart.pastedText.lines.other", { count: String(lineCount()) })
    const copyLabel = () => (copied() ? t("codeBlockInline.actions.copied") : t("codeBlockInline.actions.copy"))

    const handleCopy = async (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const success = await copyToClipboard(disclosureProps.text)
      setCopied(success)
      setTimeout(() => setCopied(false), 2000)
    }

    return (
      <details
        class="rounded-md border border-base bg-transparent"
        onToggle={(event) => {
          const nextOpen = (event.currentTarget as HTMLDetailsElement).open
          setIsOpen(nextOpen)
          if (nextOpen) {
            setHasExpanded(true)
          }
        }}
      >
        <summary class="flex items-center justify-between gap-3 cursor-pointer list-none rounded-md bg-surface-secondary px-3 py-1.5 select-none text-xs font-medium text-secondary [&::-webkit-details-marker]:hidden">
          <span class="min-w-0 flex flex-1 items-center gap-2">
            <span>{t("messagePart.pastedText.summary")}</span>
            <span class="text-[11px] text-secondary/80">{lineCountLabel()}</span>
          </span>
          <span class="inline-flex items-center gap-1.5">
            <span class="inline-flex h-6 w-6 items-center justify-center text-secondary/80" aria-hidden="true">
              <Show when={isOpen()} fallback={<ChevronsUpDown class="h-3.5 w-3.5" aria-hidden="true" />}>
                <ChevronsDownUp class="h-3.5 w-3.5" aria-hidden="true" />
              </Show>
            </span>
            <button
              type="button"
              class="inline-flex h-6 w-6 items-center justify-center rounded text-secondary hover:bg-surface-tertiary"
              onClick={(event) => void handleCopy(event)}
              aria-label={t("messagePart.pastedText.copyAriaLabel")}
              title={t("messagePart.pastedText.copyAriaLabel")}
            >
              <Copy class="h-3.5 w-3.5" aria-hidden="true" />
              <span class="sr-only">{copyLabel()}</span>
            </button>
          </span>
        </summary>
        <Show when={hasExpanded()}>
          <div class="bg-transparent px-3 pb-3 pt-2">
            <Markdown
              part={createSegmentTextPart(disclosureProps.text, disclosureProps.index)}
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              isDark={isDark()}
              size="base"
              escapeRawHtml
              onRendered={props.onRendered}
            />
          </div>
        </Show>
      </details>
    )
  }

  return (
    <Switch>
      <Match when={partType() === "text"}>
        <Show when={!shouldHideTextPart() && (partHasRenderableText(props.part) || isPrimaryUserTextPart())}>
          <div
            class={canRenderMarkdown() ? markdownContainerClass() : textContainerClass()}
            dir="auto"
            data-role={textContainerRole()}
            data-part-type="text"
            data-part-id={typeof (props.part as any)?.id === "string" ? (props.part as any).id : undefined}
          >
            <Show
              when={promptDisplaySegments()}
              fallback={
                <Show when={canRenderMarkdown()} fallback={<span class="text-primary" dir="auto">{plainTextContent()}</span>}>
                  <Markdown
                    part={createTextPartForMarkdown()}
                    instanceId={props.instanceId}
                    sessionId={props.sessionId}
                    isDark={isDark()}
                    size={isAssistantMessage() ? "tight" : "base"}
                    escapeRawHtml
                    onRendered={props.onRendered}
                  />
                </Show>
              }
            >
              {(segments) => (
                <div class="flex flex-col gap-2">
                  <For each={segments().filter((segment) => segment.text.length > 0)}>
                    {(segment, index) =>
                      segment.kind === "pasted" ? (
                        <PastedTextDisclosure text={segment.text} index={index()} />
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
            onContentRendered={props.onRendered}
          />
        </Suspense>
      </Match>




    </Switch>
  )
}
