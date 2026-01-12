import { Index, Show, type Accessor } from "solid-js"
import VirtualItem from "./virtual-item"
import MessageBlock from "./message-block"
import ThinkingCard from "./thinking-card"
import ReadyCard from "./ready-card"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import { preferences } from "../stores/preferences"

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
  isSessionBusy?: boolean
  onRevert?: (messageId: string) => void
  onFork?: (messageId?: string) => void
  onContentRendered?: () => void
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
            />
          </VirtualItem>
        )}
      </Index>
      {/* Thinking card - shown when assistant is processing and verbose output is disabled */}
      <Show when={props.isSessionBusy && !preferences().showVerboseOutput}>
        <ThinkingCard isThinking={true} />
      </Show>
      {/* Ready card - shown when assistant has finished and waiting for user input */}
      <Show when={!props.isSessionBusy && !props.loading && props.messageIds().length > 0}>
        <ReadyCard isReady={true} />
      </Show>
      <div ref={props.setBottomSentinel} aria-hidden="true" style={{ height: "1px" }} />
    </>
  )
}
