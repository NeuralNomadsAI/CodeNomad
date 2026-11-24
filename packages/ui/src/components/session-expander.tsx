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
  let trigger: HTMLButtonElement | undefined
  // The row stays pinned until focus is back on the chevron (the list then keeps
  // the focused row mounted), so closing never unmounts an offscreen row first.
  const closeAutoFocus = (event: Event) => {
    event.preventDefault()
    const active = document.activeElement
    if (!active || active === document.body || (event.currentTarget as Element | null)?.contains(active)) trigger?.focus({ preventScroll: true })
    props.onOpenChange(false)
  }
  return (
    <ContextMenu onOpenChange={(open) => { if (open) props.onOpenChange(true) }}>
      <ContextMenu.Trigger
        ref={trigger}
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
        <ContextMenu.Content class="action-overflow-content" onCloseAutoFocus={closeAutoFocus}>
          <ContextMenu.Item class="action-overflow-item" disabled={props.markReadDisabled} onSelect={() => props.onMarkRead()}>
            <span class="action-overflow-item-icon" aria-hidden="true"><CheckCheck class="w-3.5 h-3.5" /></span>
            <span class="action-overflow-item-label">{props.markReadLabel}</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}
