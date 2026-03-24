import { createMemo, type Accessor } from "solid-js"
import type { TimelineSegment } from "./timeline-builder"
import type { InstanceMessageStore } from "../../stores/message-v2/instance-store"
import { getPartCharCount } from "../../lib/token-utils"

export const ABSOLUTE_TOKEN_CAP = 10000

export function useTimelineTokens(
  segments: Accessor<TimelineSegment[]>,
  isSelectionActive: Accessor<boolean>,
  store: Accessor<InstanceMessageStore>,
  expandedMessageIds?: Accessor<Set<string>>,
  deletableMessageIds?: Accessor<Set<string>>
) {
  const isHistogramEligible = (segment: TimelineSegment): boolean =>
    deletableMessageIds?.()?.has(segment.messageId) ?? true

  const xraySegments = createMemo(() =>
    isSelectionActive() ? segments().filter(isHistogramEligible) : []
  )

  const tokenMetrics = createMemo(() => {
    if (!isSelectionActive()) {
      return { chars: {}, aggregates: {}, max: 1 }
    }

    const segments = xraySegments()
    const resolvedStore = store()

    const { chars, rawAggregates } = segments.reduce(
      (acc, segment) => {
        let charCount = segment.totalChars
        const record = resolvedStore.getMessage(segment.messageId)
        
        if (record?.parts) {
          const ids = [...(segment.partIds ?? []), ...(segment.toolPartIds ?? [])]
          const activeChars = ids.reduce((sum, partId) => {
            const part = record.parts[partId]?.data
            return sum + (part ? getPartCharCount(part) : 0)
          }, 0)
          if (activeChars > 0) charCount = activeChars
        }
        acc.chars[segment.id] = charCount
        acc.rawAggregates[segment.messageId] = (acc.rawAggregates[segment.messageId] ?? 0) + charCount
        return acc
      },
      { chars: {} as Record<string, number>, rawAggregates: {} as Record<string, number> }
    )

    const aggregates = Object.entries(rawAggregates).reduce((acc, [id, val]) => {
      acc[id] = Math.max(Math.round(val / 4), 1)
      return acc
    }, {} as Record<string, number>)

    const isIdsExpanded = expandedMessageIds?.() ?? new Set()
    const max = segments.reduce((currentMax, segment) => {
      const isExpanded = isIdsExpanded.has(segment.messageId)
      let tokens: number
      if (!isExpanded && (segment.type === "assistant" || segment.type === "user")) {
        tokens = aggregates[segment.messageId] ?? 1
      } else {
        tokens = Math.max(Math.round(chars[segment.id] / 4), 1)
      }
      return Math.max(currentMax, tokens)
    }, 1)

    return { chars, aggregates, max }
  })

  const getSegmentTokens = (segment: TimelineSegment): number => {
    const isExpanded = expandedMessageIds?.().has(segment.messageId) ?? false
    return (!isExpanded && !isSelectionActive() && (segment.type === "assistant" || segment.type === "user")) 
      ? (tokenMetrics().aggregates[segment.messageId] ?? 1) 
      : Math.max(Math.round((tokenMetrics().chars[segment.id] ?? segment.totalChars) / 4), 1)
  }

  const getMessageAggregateTokens = (messageId: string): number => tokenMetrics().aggregates[messageId] ?? 1

  const formatTokenLabel = (tokens: number): string => 
    tokens >= 1000000 ? `${(tokens / 1000000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens)

  const maxTokens = createMemo(() => tokenMetrics().max)

  return {
    xraySegments,
    getSegmentTokens,
    getMessageAggregateTokens,
    formatTokenLabel,
    maxTokens,
  }
}
