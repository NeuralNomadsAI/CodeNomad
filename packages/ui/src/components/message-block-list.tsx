import { Index, createMemo, type Accessor } from "solid-js"
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
  isSessionBusy?: boolean
  onRevert?: (messageId: string) => void
  onFork?: (messageId?: string) => void
  onContentRendered?: () => void
  setBottomSentinel: (element: HTMLDivElement | null) => void
  suspendMeasurements?: () => boolean
}

export default function MessageBlockList(props: MessageBlockListProps) {
  // Compute which messages are the "last in their assistant turn"
  // Tools should be consolidated and shown only at the end of each assistant turn
  const assistantTurnInfo = createMemo(() => {
    const ids = props.messageIds()
    const store = props.store()
    const info = new Map<string, { isLastInTurn: boolean; turnStartIndex: number }>()

    let turnStartIndex = 0
    for (let i = 0; i < ids.length; i++) {
      const record = store.getMessage(ids[i])
      const role = record?.role || "user"

      if (role === "user") {
        // User message - mark previous assistant messages
        turnStartIndex = i + 1
      } else if (role === "assistant") {
        // Check if next message is NOT assistant (or this is last message)
        const nextRecord = i + 1 < ids.length ? store.getMessage(ids[i + 1]) : null
        const nextRole = nextRecord?.role || "user"
        const isLastInTurn = nextRole !== "assistant"

        info.set(ids[i], { isLastInTurn, turnStartIndex })
      }
    }

    return info
  })

  // Get all message IDs in the same assistant turn (for tool consolidation)
  const getAssistantTurnIds = (messageId: string, index: number) => {
    const info = assistantTurnInfo().get(messageId)
    if (!info?.isLastInTurn) return []

    const ids = props.messageIds()
    const store = props.store()
    const turnIds: string[] = []

    // Collect all assistant message IDs from turnStartIndex to current index
    for (let i = info.turnStartIndex; i <= index; i++) {
      const record = store.getMessage(ids[i])
      if (record?.role === "assistant") {
        turnIds.push(ids[i])
      }
    }

    return turnIds
  }

  return (
    <>
      <Index each={props.messageIds()}>
        {(messageId, index) => {
          const isLastMessage = () => index === props.messageIds().length - 1
          // Only show tools on the last message of each assistant turn
          const turnInfo = () => assistantTurnInfo().get(messageId())
          const isLastInAssistantTurn = () => turnInfo()?.isLastInTurn ?? false

          // Get all message IDs in this turn for tool consolidation
          const turnMessageIds = () => isLastInAssistantTurn() ? getAssistantTurnIds(messageId(), index) : []

          // Only show step-finish (summary pill) when session is idle and this is the last message
          const showStepFinish = () => !props.isSessionBusy && !props.loading && isLastMessage()

          return (
            <VirtualItem
              id={getMessageAnchorId(messageId())}
              cacheKey={messageId()}
              scrollContainer={props.scrollContainer}
              threshold={VIRTUAL_ITEM_MARGIN_PX}
              placeholderClass="block w-full relative bg-transparent transition-[height] duration-100 ease-out"
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
                isLastMessage={isLastMessage()}
                isLastInAssistantTurn={isLastInAssistantTurn()}
                turnMessageIds={turnMessageIds()}
                showStepFinish={showStepFinish()}
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
