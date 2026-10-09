// Persist URLs and a cursor, never Chromium pageState (forms, POST bodies, DOM).
export interface BrowserHistory { urls: string[]; index: number }
export interface NativeBrowserHistory { entries: Array<{ id: number; url: string }>; index: number }
export const MAX_BROWSER_HISTORY = 32

export function historyUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return
    return url.href
  } catch { return }
}

export function parseBrowserHistory(value: unknown, currentUrl: string): BrowserHistory {
  const fallback = { urls: [currentUrl], index: 0 }
  if (!value || typeof value !== "object") return fallback
  const { urls, index } = value as BrowserHistory
  if (!Array.isArray(urls) || urls.length > MAX_BROWSER_HISTORY || !Number.isInteger(index) || index < 0 || index >= urls.length) return fallback
  const safe = urls.map(historyUrl)
  if (safe.some(url => !url) || safe[index] !== currentUrl) return fallback
  return { urls: safe as string[], index }
}

// Saved entries have no live native ID after restart. Use native traversal when
// possible; otherwise load only the selected saved URL, not the intervening pages.
export class BrowserHistoryJournal {
  private ids: Array<number | undefined>
  private currentId?: number
  private pending?: { index: number; from?: number }
  constructor(public value: BrowserHistory) { this.ids = value.urls.map(() => undefined) }

  request(index: number, native: NativeBrowserHistory): { id?: number; url: string } {
    if (!Number.isInteger(index) || index < 0 || index >= this.value.urls.length) throw new Error("Invalid history index")
    this.pending = { index, from: this.currentId }
    const id = this.ids[index]
    return { id: native.entries.some(entry => entry.id === id) ? id : undefined, url: this.value.urls[index] }
  }
  cancel() { this.pending = undefined }
  get traversing() { return this.pending !== undefined }

  visitUrl(url: string): BrowserHistory {
    if (!historyUrl(url)) return this.value
    if (this.pending) {
      const urls = [...this.value.urls]
      urls[this.pending.index] = url
      this.value = { urls, index: this.pending.index }
      this.pending = undefined
    } else if (url !== this.value.urls[this.value.index]) {
      const urls = [...this.value.urls.slice(0, this.value.index + 1), url].slice(-MAX_BROWSER_HISTORY)
      this.value = { urls, index: urls.length - 1 }
    }
    return this.value
  }

  observe(native: NativeBrowserHistory): BrowserHistory {
    const current = native.entries[native.index]
    if (!current || !historyUrl(current.url) || !Number.isInteger(current.id)) return this.value
    let { urls, index } = this.value
    urls = [...urls]
    if (this.pending) {
      if (current.id === this.pending.from) return this.value
      index = this.pending.index
      urls[index] = current.url // Redirects replace the restored entry, not its neighbours.
      this.ids[index] = current.id
      this.pending = undefined
    } else {
      const known = this.ids.indexOf(current.id)
      if (known >= 0) { index = known; urls[index] = current.url }
      else if (this.currentId === undefined) { urls[index] = current.url; this.ids[index] = current.id }
      else {
        let anchor = native.index - 1
        while (anchor >= 0 && !this.ids.includes(native.entries[anchor].id)) anchor--
        if (anchor < 0) { urls[index] = current.url; this.ids[index] = current.id }
        else {
          const logical = this.ids.indexOf(native.entries[anchor].id)
          const added = native.entries.slice(anchor + 1, native.index + 1).filter(entry => historyUrl(entry.url))
          urls = [...urls.slice(0, logical + 1), ...added.map(entry => entry.url)]
          this.ids = [...this.ids.slice(0, logical + 1), ...added.map(entry => entry.id)]
          index = urls.length - 1
        }
      }
    }
    this.currentId = current.id
    if (urls.length > MAX_BROWSER_HISTORY) {
      const start = Math.max(0, index - MAX_BROWSER_HISTORY + 1)
      urls = urls.slice(start, start + MAX_BROWSER_HISTORY)
      this.ids = this.ids.slice(start, start + MAX_BROWSER_HISTORY)
      index -= start
    }
    this.value = { urls, index }
    return this.value
  }
}
