export const MESSAGE_HISTORY_TOP_THRESHOLD_PX = 320

export function shouldLoadOlderMessages(options: {
  active: boolean
  failed: boolean
  hasMore: boolean
  loading: boolean
  messageCount: number
  scrollTop: number
}): boolean {
  return options.active
    && !options.failed
    && options.hasMore
    && !options.loading
    && options.messageCount > 0
    && options.scrollTop <= MESSAGE_HISTORY_TOP_THRESHOLD_PX
}
