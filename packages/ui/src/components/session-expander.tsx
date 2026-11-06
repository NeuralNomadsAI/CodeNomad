import { ContextMenu } from "@kobalte/core/context-menu"
import { CheckCheck, ChevronRight } from "lucide-solid"
import type { ChildActivityKind } from "./session-child-activity"

interface SessionExpanderProps {
  expanded: boolean
  /** The most urgent visible state among descendants, shown expanded or not. */
  activity?: ChildActivityKind
  label: string
  title: string
  class: string
  markReadLabel: string
  /** No descendant (or the row) shows an Idle or Interrupted badge to clear. */
  markReadDisabled: boolean
  onToggle: () => void
  onMarkRead: () => void
  /** Lets the virtualized list keep the row mounted while its menu is open. */
  onOpenChange: (open: boolean) => void
}

/** A parent row's chevron; its context menu marks the whole hierarchy as read. */
export default function SessionExpander(props: SessionExpanderProps) {
  return (
    <ContextMenu onOpenChange={(open) => props.onOpenChange(open)}>
      <ContextMenu.Trigger
        as="button"
        type="button"
        class={props.class}
        onClick={() => props.onToggle()}
        aria-expanded={props.expanded}
        aria-label={props.label}
        title={props.title}
        data-child-activity={props.activity}
      >
        <ChevronRight class="disclosure-chevron w-3.5 h-3.5" />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content class="action-overflow-content">
          <ContextMenu.Item class="action-overflow-item" disabled={props.markReadDisabled} onSelect={() => props.onMarkRead()}>
            <span class="action-overflow-item-icon" aria-hidden="true"><CheckCheck class="w-3.5 h-3.5" /></span>
            <span class="action-overflow-item-label">{props.markReadLabel}</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}
