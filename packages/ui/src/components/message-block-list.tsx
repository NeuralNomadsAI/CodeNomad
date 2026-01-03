import { Index, type Accessor } from "solid-js"
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
  lastAssistantIndex: () => number
  showThinking: () => boolean
  thinkingDefaultExpanded: () => boolean
  showUsageMetrics: () => boolean
  scrollContainer: Accessor<HTMLDivElement | undefined>
  loading?: boolean
  onRevert?: (messageId: string) => void
  onFork?: (messageId?: string) => void
  onContentRendered?: () => void
  onOpenPreview?: (filePath: string) => void
  setBottomSentinel: (element: HTMLDivElement | null) => void
  suspendMeasurements?: () => boolean
}

export default function MessageBlockList(props: MessageBlockListProps) {
  return (
    <>
      <Index each={props.messageIds()}>
        {(messageId, index) => (
          <VirtualItem
            id={getMessageAnchorId(messageId())}
            cacheKey={messageId()}
            scrollContainer={props.scrollContainer}
            threshold={VIRTUAL_ITEM_MARGIN_PX}
            placeholderClass="message-stream-placeholder"
            virtualizationEnabled={() => !props.loading}
            suspendMeasurements={props.suspendMeasurements}
          >
            <MessageBlock
              messageId={messageId()}
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              store={props.store}
              messageIndex={index}
              lastAssistantIndex={props.lastAssistantIndex}
              showThinking={props.showThinking}
              thinkingDefaultExpanded={props.thinkingDefaultExpanded}
              showUsageMetrics={props.showUsageMetrics}
              onRevert={props.onRevert}
              onFork={props.onFork}
              onContentRendered={props.onContentRendered}
              onOpenPreview={props.onOpenPreview}
            />
          </VirtualItem>
        )}
      </Index>
      <div ref={props.setBottomSentinel} aria-hidden="true" style={{ height: "1px" }} />
    </>
  )
}
