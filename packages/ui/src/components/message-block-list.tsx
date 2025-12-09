import { Index, createEffect, createSignal, type Accessor } from "solid-js"
import VirtualItem from "./virtual-item"
import MessageBlock from "./message-block"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"

export function getMessageAnchorId(messageId: string) {
  return `message-anchor-${messageId}`
}

const VIRTUAL_ITEM_MARGIN_PX = 800

interface MessageBlockListProps {

  instanceId: string
  sessionId: string
  store: () => InstanceMessageStore
  messageIds: () => string[]
  messageIndexMap: () => Map<string, number>
  lastAssistantIndex: () => number
  showThinking: () => boolean
  thinkingDefaultExpanded: () => boolean
  showUsageMetrics: () => boolean
  scrollContainer: Accessor<HTMLDivElement | undefined>
  loading?: boolean
  onRevert?: (messageId: string) => void
  onFork?: (messageId?: string) => void
  onContentRendered?: () => void
  setBottomSentinel: (element: HTMLDivElement | null) => void
  suspendMeasurements?: () => boolean
  onInitialRenderComplete?: () => void
}

export default function MessageBlockList(props: MessageBlockListProps) {
  const totalMessages = () => props.messageIds().length
  let renderedCount = 0
  let initialRenderReported = false
  const handleBlockRendered = () => {
    if (initialRenderReported) return
    renderedCount += 1
    if (renderedCount >= totalMessages() && totalMessages() > 0) {
      initialRenderReported = true
      renderedCount = 0
      props.onInitialRenderComplete?.()
    }
  }

  createEffect(() => {
    if (props.loading) {
      renderedCount = 0
      initialRenderReported = false
    }
  })

  return (
    <>
      <Index each={props.messageIds()}>
        {(messageId) => {
          return (
            <VirtualItem
              id={getMessageAnchorId(messageId())}
              cacheKey={messageId()}
              scrollContainer={props.scrollContainer}
              threshold={VIRTUAL_ITEM_MARGIN_PX}
              placeholderClass="message-stream-placeholder"
              virtualizationEnabled={() => !props.loading}
              suspendMeasurements={props.suspendMeasurements}
              onMeasured={handleBlockRendered}
            >
              <MessageBlock
                messageId={messageId()}
                instanceId={props.instanceId}
                sessionId={props.sessionId}
                store={props.store}
                messageIndexMap={props.messageIndexMap}
                lastAssistantIndex={props.lastAssistantIndex}
                showThinking={props.showThinking}
                thinkingDefaultExpanded={props.thinkingDefaultExpanded}
                showUsageMetrics={props.showUsageMetrics}
                onRevert={props.onRevert}
                onFork={props.onFork}
                onContentRendered={props.onContentRendered}
              />
            </VirtualItem>
          )
        }}
      </Index>
      <div ref={props.setBottomSentinel} aria-hidden="true" style={{ height: "1px" }} />
    </>
  )
}
