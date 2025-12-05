import { Index, createEffect, createSignal, type Accessor } from "solid-js"
import VirtualItem from "./virtual-item"
import MessageBlock from "./message-block"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"

const VIRTUAL_ITEM_MARGIN_PX = 800
const ESTIMATED_MESSAGE_HEIGHT = 320
const INITIAL_FORCE_MIN_ITEMS = 12
const INITIAL_FORCE_OVERSCAN = 6

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
}

export default function MessageBlockList(props: MessageBlockListProps) {
  const [initialForceActive, setInitialForceActive] = createSignal(true)
  const [initialForceInitialized, setInitialForceInitialized] = createSignal(false)
  const [initialForceStartIndex, setInitialForceStartIndex] = createSignal(0)
  const [, setInitialForceRemaining] = createSignal(0)

  createEffect(() => {
    props.instanceId
    props.sessionId
    setInitialForceActive(true)
    setInitialForceInitialized(false)
    setInitialForceStartIndex(0)
    setInitialForceRemaining(0)
  })

  createEffect(() => {
    if (!initialForceActive() || initialForceInitialized()) return
    const ids = props.messageIds()
    if (ids.length === 0) return
    const viewportHeight = props.scrollContainer()?.clientHeight ?? (typeof window !== "undefined" ? window.innerHeight : 800)
    const estimatedCount = Math.min(
      ids.length,
      Math.max(INITIAL_FORCE_MIN_ITEMS, Math.ceil(viewportHeight / ESTIMATED_MESSAGE_HEIGHT) + INITIAL_FORCE_OVERSCAN),
    )
    setInitialForceStartIndex(Math.max(0, ids.length - estimatedCount))
    setInitialForceRemaining(estimatedCount)
    setInitialForceInitialized(true)
  })

  return (
    <>
      <Index each={props.messageIds()}>
        {(messageId) => {
          const messageIndex = () => props.messageIndexMap().get(messageId()) ?? 0
          const forceVisible = () => initialForceActive() && messageIndex() >= initialForceStartIndex()
          const handleMeasured = () => {
            if (!forceVisible()) return
            setInitialForceRemaining((value) => {
              const next = value > 0 ? value - 1 : 0
              if (next === 0) {
                setInitialForceActive(false)
              }
              return next
            })
          }
          return (
            <VirtualItem
              cacheKey={messageId()}
              scrollContainer={props.scrollContainer}
              threshold={VIRTUAL_ITEM_MARGIN_PX}
              placeholderClass="message-stream-placeholder"
              virtualizationEnabled={() => !props.loading}
              forceVisible={forceVisible}
              onMeasured={handleMeasured}
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
