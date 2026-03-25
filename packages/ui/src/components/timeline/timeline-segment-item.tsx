import { Show, type Component } from "solid-js"
import { User as UserIcon, Bot as BotIcon, FoldVertical, ShieldAlert } from "lucide-solid"
import type { TimelineSegment } from "./timeline-builder"
import type { DeleteHoverState } from "../../types/delete-hover"
import type { InstanceMessageStore } from "../../stores/message-v2/instance-store"
import { useLongPress } from "../../lib/hooks/use-long-press"
import { getToolIcon } from "../tool-call/utils"

export interface TimelineSegmentItemProps {
  segment: TimelineSegment
  isFirstInGroup: boolean
  groupRole: "child" | "parent" | "none"
  isActive: boolean
  isSelected: boolean
  isMultiSelectActive: boolean
  isExpanded: boolean
  isHidden: boolean
  hasActivePermission: boolean
  isDeleteHovered: boolean
  isDeleteSelected: boolean
  scrollContainerRef: HTMLDivElement | undefined
  registerRef: (id: string, el: HTMLButtonElement | null) => void
  onSegmentClick: (segment: TimelineSegment) => void
  onSelectRange: (id: string) => void
  onToggleSelection: (id: string) => void
  onLongPressSelection?: (segment: TimelineSegment) => void
  onMouseEnter: (segment: TimelineSegment, event: MouseEvent) => void
  onMouseLeave: () => void
  onContextMenu: (event: MouseEvent) => void
}

export const TimelineSegmentItem: Component<TimelineSegmentItemProps> = (props) => {
  const pointerEvents = useLongPress({
    delay: 500,
    jitterThreshold: 10,
    onLongPress: (e) => {
      let anchorOffset: number | null = null
      const btn = e.currentTarget as HTMLButtonElement
      if (btn && props.scrollContainerRef) {
        anchorOffset = btn.offsetTop - props.scrollContainerRef.scrollTop
      }

      if (props.onLongPressSelection) {
        props.onLongPressSelection(props.segment)
      } else {
        props.onToggleSelection?.(props.segment.id)
      }

      if (anchorOffset !== null && btn && props.scrollContainerRef) {
        const desired = btn.offsetTop - anchorOffset
        if (Math.abs(props.scrollContainerRef.scrollTop - desired) > 1) {
          props.scrollContainerRef.scrollTop = desired
        }
      }
    }
  })

  const shortLabelContent = () => {
    if (props.segment.type === "tool") {
      if (props.hasActivePermission) {
        return <ShieldAlert class="message-timeline-icon" aria-hidden="true" />
      }
      return props.segment.shortLabel ?? getToolIcon("tool")
    }
    if (props.segment.type === "compaction") {
      return <FoldVertical class="message-timeline-icon" aria-hidden="true" />
    }
    if (props.segment.type === "user") {
      return <UserIcon class="message-timeline-icon" aria-hidden="true" />
    }
    return <BotIcon class="message-timeline-icon" aria-hidden="true" />
  }

  const handleClick = (e: MouseEvent) => {
    if (pointerEvents.wasLongPress) {
      pointerEvents.resetWasLongPress()
      return
    }

    const btn = e.currentTarget as HTMLButtonElement
    let anchorOffset: number | null = null
    if (btn && props.scrollContainerRef) {
      anchorOffset = btn.offsetTop - props.scrollContainerRef.scrollTop
    }

    if (e.shiftKey) {
      props.onSelectRange?.(props.segment.id)
    } else if (e.ctrlKey || e.metaKey) {
      props.onToggleSelection?.(props.segment.id)
    } else if (props.isMultiSelectActive) {
      props.onSegmentClick?.(props.segment)
    } else {
      props.onSegmentClick?.(props.segment)
    }

    if (anchorOffset !== null && btn && props.scrollContainerRef) {
      const desired = btn.offsetTop - anchorOffset
      if (Math.abs(props.scrollContainerRef.scrollTop - desired) > 1) {
        props.scrollContainerRef.scrollTop = desired
      }
    }
  }

  const handleContextMenuProxy = (e: MouseEvent) => {
    if (pointerEvents.wasLongPress) {
      e.preventDefault()
    }
    props.onContextMenu(e)
  }

  const badgeClass = () => {
    const classes = [`message-timeline-segment message-timeline-${props.segment.type}`]
    if (props.hasActivePermission) classes.push("message-timeline-segment-permission")
    if (props.segment.type === "compaction") classes.push(`message-timeline-compaction-${props.segment.variant ?? "manual"}`)
    if (props.isActive) classes.push("message-timeline-segment-active")
    if (props.isHidden) classes.push("message-timeline-segment-hidden")
    if (props.isSelected) classes.push("message-timeline-segment-selected")
    if (props.isDeleteSelected) classes.push("message-timeline-segment-delete-selected")
    if (props.groupRole !== "none") classes.push(`message-timeline-group-${props.groupRole}`)
    if (props.isFirstInGroup) classes.push("message-timeline-group-start")
    return classes.join(" ")
  }

  return (
    <button
      ref={(el) => props.registerRef(props.segment.id, el)}
      type="button"
      data-variant={props.segment.variant}
      class={badgeClass()}
      data-delete-hover={props.isDeleteHovered || props.isDeleteSelected || props.isSelected ? "true" : undefined}
      aria-current={props.isActive ? "true" : undefined}
      aria-hidden={props.isHidden ? "true" : undefined}
      aria-label={props.segment.label}
      onClick={handleClick}
      onPointerDown={pointerEvents.onPointerDown}
      onPointerUp={pointerEvents.onPointerUp}
      onPointerCancel={pointerEvents.onPointerCancel}
      onPointerMove={pointerEvents.onPointerMove}
      onContextMenu={handleContextMenuProxy}
      onMouseEnter={(event) => props.onMouseEnter(props.segment, event)}
      onMouseLeave={props.onMouseLeave}
    >
      <span class="message-timeline-label message-timeline-label-full">{props.segment.label}</span>
      <span class="message-timeline-label message-timeline-label-short">{shortLabelContent()}</span>
    </button>
  )
}
