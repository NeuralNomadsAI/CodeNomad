import type { Component } from "solid-js"
import MessageBlock from "./message-block"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { DeleteHoverState } from "../types/delete-hover"

interface MessagePreviewProps {
  instanceId: string
  sessionId: string
  messageId: string
  store: () => InstanceMessageStore
  deleteHover?: () => DeleteHoverState
  onDeleteHoverChange?: (state: DeleteHoverState) => void
  onDeleteMessagesUpTo?: (messageId: string) => void | Promise<void>
}

const MessagePreview: Component<MessagePreviewProps> = (props) => {
  const lastAssistantIndex = () => 0

  return (
    <div class="message-preview message-stream">
      <MessageBlock
        messageId={props.messageId}
        instanceId={props.instanceId}
        sessionId={props.sessionId}
        store={props.store}
        messageIndex={0}
        lastAssistantIndex={lastAssistantIndex}
        showThinking={() => false}
        thinkingDefaultExpanded={() => false}
        showUsageMetrics={() => false}
        deleteHover={props.deleteHover}
        onDeleteHoverChange={props.onDeleteHoverChange}
        onDeleteMessagesUpTo={props.onDeleteMessagesUpTo}
      />
    </div>
  )
}

export default MessagePreview
