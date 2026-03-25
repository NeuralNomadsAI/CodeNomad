import { Show, type Component } from "solid-js"
import type { TimelineSegment } from "./timeline-builder"
import { ABSOLUTE_TOKEN_CAP } from "./use-timeline-tokens"
import { Virtualizer } from "virtua/solid"

export interface TimelineXRayOverlayProps {
  isSelectionActive: boolean
  xraySegments: TimelineSegment[]
  getSegmentTokens: (segment: TimelineSegment) => number
  getMessageAggregateTokens: (messageId: string) => number
  maxTokens: number
  formatTokenLabel: (tokens: number) => string
  scrollContainerRef: HTMLDivElement | undefined
}

export const TimelineXRayOverlay: Component<TimelineXRayOverlayProps> = (props) => {
  return (
    <Show when={props.isSelectionActive}>
      <div class="message-timeline-xray-overlay">
        <div class="message-timeline-xray-overlay-inner">
          <Virtualizer data={props.xraySegments} scrollRef={props.scrollContainerRef}>
            {(segment) => {
              const tokens = () => props.getSegmentTokens(segment)
              const relativeWeight = () => tokens() / props.maxTokens
              const absoluteWeight = () => Math.min(tokens() / ABSOLUTE_TOKEN_CAP, 1.0)
              const isOverflow = () => tokens() > ABSOLUTE_TOKEN_CAP
              const isParent = segment.type === "assistant" || segment.type === "user"
              const displayTokens = () =>
                isParent ? props.getMessageAggregateTokens(segment.messageId) : tokens()

              return (
                <div
                  class="message-timeline-xray-rib"
                  style={{
                    position: "relative",
                    "margin-bottom": "12px",
                    left: "var(--xray-overhang)",
                  }}
                >
                  <span class="message-timeline-xray-token-label">
                    {props.formatTokenLabel(displayTokens())}
                  </span>
                  <div
                    class="message-timeline-relative-bar"
                    style={{ "--segment-weight": relativeWeight() }}
                  />
                  <div
                    class={`message-timeline-absolute-bar${isOverflow() ? " message-timeline-absolute-bar-overflow" : ""}`}
                    style={{ "--segment-weight": absoluteWeight() }}
                  />
                </div>
              )
            }}
          </Virtualizer>
        </div>
      </div>
    </Show>
  )
}
