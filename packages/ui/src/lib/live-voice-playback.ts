import { LIVE_VOICE_OUTPUT_RATE, LIVE_VOICE_TRACKED_IDS, type LiveVoiceClientMessage, type LiveVoiceServerMessage } from "../../../server/src/speech/live-voice-contract"

type AudioMessage = Extract<LiveVoiceServerMessage, { type: "audio" }>
export type TruncateMessage = Extract<LiveVoiceClientMessage, { type: "truncate" }>
type Item = { itemId: string; contentIndex: number; received: number; played: number }

export const LIVE_VOICE_PLAYBACK_CAPACITY = 12 * LIVE_VOICE_OUTPUT_RATE

/** Count PCM frames rendered per OpenAI item; silence and discarded frames do not count. */
export class LiveVoicePlayback {
  private readonly items = new Map<string, Item>()
  private readonly queued: { item?: Item; end: number }[] = []
  private received = 0
  private rendered = 0
  private replyStart = 0
  private readonly replyItems = new Set<Item>()
  private openItem?: Item
  private overflowItem?: Item

  get pending() { return this.received > this.rendered }

  append(frames: number, message: AudioMessage) {
    if (this.received - this.rendered + frames > LIVE_VOICE_PLAYBACK_CAPACITY) {
      const { itemId, contentIndex } = message
      if (itemId !== undefined && contentIndex !== undefined) {
        // Truncate the rejected item too, including a new item with zero played frames.
        this.overflowItem = this.items.get(itemId) ?? { itemId, contentIndex, played: 0, received: 0 }
      }
      return false
    }
    let item: Item | undefined
    if (message.itemId !== undefined && message.contentIndex !== undefined) {
      item = this.items.get(message.itemId)
      if (!item) {
        // Mirror gateway eviction; fail rather than losing queued samples' ownership.
        if (this.items.size >= LIVE_VOICE_TRACKED_IDS) {
          const [key, oldest] = this.items.entries().next().value!
          if (oldest.received !== oldest.played) throw new Error("Playback item overrun")
          this.items.delete(key)
        }
        item = { itemId: message.itemId, contentIndex: message.contentIndex, received: 0, played: 0 }
        this.items.set(item.itemId, item)
      }
      if (item.contentIndex !== message.contentIndex) throw new Error("Playback item changed")
      item.received += frames
      this.openItem = item
      this.replyItems.add(item)
    }
    this.received += frames
    const tail = this.queued.at(-1)
    if (tail && tail.item === item) tail.end = this.received
    else {
      if (this.queued.length >= 256) throw new Error("Playback item overrun")
      this.queued.push({ item, end: this.received })
    }
    return true
  }

  progress(rendered: number) {
    while (this.rendered < rendered) {
      const head = this.queued[0]
      const next = Math.min(rendered, head.end)
      if (head.item) head.item.played += next - this.rendered
      this.rendered = next
      if (next === head.end) this.queued.shift()
    }
  }

  turnComplete() {
    this.openItem = undefined
    this.replyItems.clear()
    this.replyStart = this.received
  }

  /** Rebase to the preceding replies. Worklet acknowledgement supplies their exact played position. */
  retainEarlierReplies() {
    const retained = new LiveVoicePlayback()
    retained.received = retained.replyStart = this.replyStart
    retained.rendered = Math.min(this.rendered, this.replyStart)
    for (const { item, end } of this.queued) {
      if (retained.queued.at(-1)?.end === this.replyStart || retained.rendered === this.replyStart) break
      let copy: Item | undefined
      if (item) {
        copy = retained.items.get(item.itemId)
        if (!copy) { copy = { ...item }; retained.items.set(copy.itemId, copy) }
      }
      retained.queued.push({ item: copy, end: Math.min(end, this.replyStart) })
    }
    return { playback: retained, keepThrough: this.replyStart }
  }

  interrupt(rendered: number, currentOnly = false): TruncateMessage[] {
    this.progress(rendered)
    const items = [...this.items.values()]
    if (this.overflowItem && !this.items.has(this.overflowItem.itemId)) items.push(this.overflowItem)
    return items
      .filter(item => item === this.overflowItem || (!currentOnly || this.replyItems.has(item))
        && (item === this.openItem || item.received > item.played))
      .map(({ itemId, contentIndex, played }) => ({
        type: "truncate",
        itemId,
        contentIndex,
        audioEndMs: Math.floor(played * 1000 / LIVE_VOICE_OUTPUT_RATE),
      }))
  }
}
