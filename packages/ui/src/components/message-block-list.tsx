import { Index, createMemo, type Accessor } from "solid-js"
import VirtualItem from "./virtual-item"
import MessageBlock from "./message-block"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { DeleteHoverState } from "../types/delete-hover"

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
  onRevert?: (messageId: string) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
  onFork?: (messageId?: string) => void
  onContentRendered?: () => void
  deleteHover?: Accessor<DeleteHoverState>
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  selectedMessageIds?: Accessor<Set<string>>
  onToggleSelectedMessage?: (messageId: string, selected: boolean) => void
  setNewestSentinel: (element: HTMLDivElement | null) => void
  setOldestSentinel: (element: HTMLDivElement | null) => void
  suspendMeasurements?: () => boolean
}

export default function MessageBlockList(props: MessageBlockListProps) {
  // Render newest messages first in the DOM so the reversed scroll container
  // starts at the newest messages without any imperative scrolling.
  const reversedMessageIds = createMemo(() => props.messageIds().slice().reverse())
  const indexByMessageId = createMemo(() => {
    const ids = props.messageIds()
    const map = new Map<string, number>()
    for (let i = 0; i < ids.length; i++) {
      map.set(ids[i], i)
    }
    return map
  })

  return (
    <>
      <div ref={props.setNewestSentinel} aria-hidden="true" style={{ height: "1px" }} />
      <Index each={reversedMessageIds()}>
        {(messageId) => (
          <VirtualItem
            id={getMessageAnchorId(messageId())}
            cacheKey={messageId()}
            scrollContainer={props.scrollContainer}
            threshold={VIRTUAL_ITEM_MARGIN_PX}
            placeholderClass="message-stream-placeholder"
            suspendMeasurements={props.suspendMeasurements}
          >
            <MessageBlock
              messageId={messageId()}
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              store={props.store}
              messageIndex={indexByMessageId().get(messageId()) ?? 0}
              lastAssistantIndex={props.lastAssistantIndex}
              showThinking={props.showThinking}
              thinkingDefaultExpanded={props.thinkingDefaultExpanded}
              showUsageMetrics={props.showUsageMetrics}
              deleteHover={props.deleteHover}
              onDeleteHoverChange={props.onDeleteHoverChange}
              selectedMessageIds={props.selectedMessageIds}
              onToggleSelectedMessage={props.onToggleSelectedMessage}
              onRevert={props.onRevert}
              onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
              onFork={props.onFork}
              onContentRendered={props.onContentRendered}
            />
          </VirtualItem>
        )}
      </Index>
      <div ref={props.setOldestSentinel} aria-hidden="true" style={{ height: "1px" }} />
    </>
  )
}
