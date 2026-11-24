import { randomUUID } from "node:crypto"
import type { BrowserPageAction } from "../../automation/browser-page"
import { keyChord } from "../../automation/page/keys"

/** What CodeNomad's native session preview offers this adapter, already bound to its session. */
export interface PreviewHost {
  /** The visible preview's target and whether a main-frame load is in progress, or undefined when the session shows none. */
  probe(deadline: number, signal: AbortSignal): Promise<{ target: string; loading: boolean } | undefined>
  open(url: string, deadline: number, signal: AbortSignal): Promise<{ url: string }>
  navigate(url: string, target: string, deadline: number, signal: AbortSignal): Promise<{ url: string }>
  back(target: string, deadline: number, signal: AbortSignal): Promise<{ url: string }>
  forward(target: string, deadline: number, signal: AbortSignal): Promise<{ url: string }>
  reload(target: string, deadline: number, signal: AbortSignal): Promise<{ url: string }>
  screenshot(target: string, deadline: number, signal: AbortSignal): Promise<{ image: { mime: string; data: string } }>
  page(action: BrowserPageAction, target: string, deadline: number, signal: AbortSignal): Promise<Record<string, unknown>>
}

export interface BrowserTab {
  id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; generation: number
}
export interface BrowserState { tabs: BrowserTab[]; focusedTabID: string | null }
export type BrowserOutcome =
  | { type: "success"; result: { value: unknown; files: { id: string; name: string; mime: string; data: string }[] } }
  | { type: "failure"; code: string; message: string }
type Action = Record<string, unknown> & { type: string }

/** OpenCode's wait bound; CodeNomad's page wait runs in chunks of at most its own bound. */
const MAX_WAIT_MS = 30_000, PAGE_WAIT_MS = 15_000, LOAD_POLL_MS = 100, MAX_TEXT = 100_000, DEFAULT_SNAPSHOT_CHARS = 20_000
/** OpenCode's limit for one result file. */
const MAX_FILE_BYTES = 5 * 1024 * 1024
/** The parameters each operation honors. Any other option that changes its meaning is refused, never ignored. */
const HONORED: Record<string, readonly string[]> = {
  "tabs.list": [], "tabs.open": ["url"], "tabs.focus": [], navigate: ["url"], back: [], forward: [], reload: [],
  snapshot: ["ref", "maxChars", "maxLines"], find: ["text", "maxChars", "maxLines"],
  click: ["ref"], hover: ["ref"], drag: ["from", "to"], fill: ["ref", "text"], fill_form: ["fields"],
  select: ["ref", "values"], check: ["ref", "checked"], press: ["key"], scroll: ["deltaX", "deltaY"],
  wait: ["condition", "text", "timeoutMs"], screenshot: [],
}
/** Option values that ask for what the operation does anyway. */
const DEFAULTS: Record<string, unknown> = { focus: true, ignoreCache: false, button: "left", count: 1, interactive: false, boxes: false, fullPage: false, format: "png" }

function unhonored(action: Action): string | undefined {
  const honored = HONORED[action.type]
  if (!honored) return undefined
  for (const [key, value] of Object.entries(action)) {
    if (key === "type" || key === "tabID" || honored.includes(key) || value === undefined || value === null) continue
    if ((Object.hasOwn(DEFAULTS, key) && DEFAULTS[key] === value) || (key === "modifiers" && Array.isArray(value) && !value.length)) continue
    return `${action.type} with ${key}`
  }
}
const failure = (code: string, message: string): BrowserOutcome => ({ type: "failure", code, message: message.slice(0, 2_000) })
const unsupported = (action: string) => failure("unsupported",
  `browser.${action} is not available in the CodeNomad browser. Use tabs, navigate, back, forward, reload, snapshot, find, click, hover, drag, fill, fill_form, select, check, press, scroll, wait or screenshot.`)

/**
 * One session's preview as OpenCode's browser contract sees it: at most one tab, the visible preview.
 * The tab ID is stable for the attachment; its generation changes with the document, which retires refs.
 * Each command keeps the target it started on, so its steps never reach a later document.
 */
export class PreviewTab {
  readonly id = `tab_${randomUUID()}`
  private target: string | undefined
  private url = "about:blank"
  /** The target whose address `url` holds: a failed read is retried on the next refresh. */
  private urlTarget: string | undefined
  private title = ""
  private canGoBack = false
  private canGoForward = false
  private queue: Promise<void> = Promise.resolve()
  private loading = false
  private generation = 0

  constructor(private readonly host: PreviewHost) {}

  state(): BrowserState {
    return this.target ? { tabs: [this.tab()], focusedTabID: this.id } : { tabs: [], focusedTabID: null }
  }

  /** Reads the visible target; a different document advances the generation. */
  async refresh(deadline: number, signal: AbortSignal): Promise<void> {
    const probed = await this.host.probe(deadline, signal).catch(() => undefined)
    if (!probed) { this.target = undefined; this.loading = false; return }
    this.loading = probed.loading
    if (probed.target !== this.target) {
      this.target = probed.target
      this.generation++
    }
    if (this.urlTarget === probed.target) return
    const location = await this.host.page({ action: "location" }, probed.target, deadline, signal).catch(() => undefined)
    this.noteURL(probed.target, location?.url)
    if (location && this.target === probed.target) {
      this.title = typeof location.title === "string" ? location.title.slice(0, 2_048) : ""
      this.canGoBack = location.canGoBack === true
      this.canGoForward = location.canGoForward === true
    }
  }

  private noteURL(target: string, url: unknown): void {
    if (typeof url !== "string" || !url || target !== this.target) return
    this.url = url
    this.urlTarget = target
  }

  /** Commands run one at a time: a check reads, then clicks, and another command must not act in between. */
  async run(action: Action, generation: number | undefined, signal: AbortSignal): Promise<BrowserOutcome> {
    if (action.type === "tabs.list") {
      // Same-document navigation keeps the target: the address, title and history are read again.
      this.urlTarget = undefined
      return this.execute(action, generation, signal)
    }
    const previous = this.queue
    let release!: () => void
    this.queue = new Promise<void>(resolve => { release = resolve })
    try {
      await previous
      if (signal.aborted) return failure("operation_failed", "The browser action was cancelled.")
      return await this.execute(action, generation, signal)
    } finally {
      // The page may have changed its history or title: the next refresh reads them again.
      this.urlTarget = undefined
      release()
    }
  }

  private async execute(action: Action, generation: number | undefined, signal: AbortSignal): Promise<BrowserOutcome> {
    const deadline = Date.now() + 55_000
    const refused = unhonored(action)
    if (refused) return unsupported(refused)
    await this.refresh(deadline, signal)
    if (action.type === "tabs.list") return this.success(this.state())
    if (action.type === "tabs.open") return this.open(action, deadline, signal)
    const target = this.target
    if (typeof action.tabID === "string" && (action.tabID !== this.id || !target))
      return failure("operation_failed", "This tab is no longer shown. Call browser.tabs.list({}) or browser.tabs.open({ url }).")
    if (generation !== undefined && generation !== this.generation)
      return failure("document_changed", "The page changed before this action ran; take a new snapshot.")
    if (!target) return failure("operation_failed", "No page is shown. Call browser.tabs.open({ url }).")
    try {
      return await this.perform(action, target, deadline, signal)
    } catch (error) {
      return failed(error)
    }
  }

  private async perform(action: Action, target: string, deadline: number, signal: AbortSignal): Promise<BrowserOutcome> {
    const page = async (step: BrowserPageAction) => {
      const result = await this.host.page(step, target, deadline, signal)
      this.noteURL(target, result.url)
      return result
    }
    const act = async (step: BrowserPageAction) => { await page(step); return this.success(this.tab()) }
    switch (action.type) {
      case "tabs.focus": return this.success(this.tab())
      case "navigate": return this.loaded(await this.host.navigate(String(action.url), target, deadline, signal), deadline, signal)
      case "back": return this.loaded(await this.host.back(target, deadline, signal), deadline, signal)
      case "forward": return this.loaded(await this.host.forward(target, deadline, signal), deadline, signal)
      case "reload": return this.loaded(await this.host.reload(target, deadline, signal), deadline, signal)
      case "snapshot":
      case "find": {
        const query = action.type === "find" ? String(action.text) : undefined
        const result = await page({ action: "snapshot", ...(action.ref ? { ref: ref(action.ref) } : {}), ...(query ? { query } : {}) })
        let text = String(result.snapshot ?? ""), truncated = Boolean(result.collapsed)
        const maxLines = Number(action.maxLines) || 0, limit = Math.min(MAX_TEXT, Number(action.maxChars) || DEFAULT_SNAPSHOT_CHARS)
        const lines = text.split("\n")
        if (maxLines && lines.length > maxLines) { text = lines.slice(0, maxLines).join("\n"); truncated = true }
        if (text.length > limit) { text = text.slice(0, limit); truncated = true }
        return this.success({ tab: this.tab(), content: text, truncated })
      }
      // A left click only: native context menus are unavailable to agents, as in OpenCode's browser.
      // File inputs are refused before input; Electron and WebView2 also intercept pickers a page opens itself.
      case "click": return act({ action: "click", ref: ref(action.ref), noFilePicker: true })
      case "hover": return act({ action: "hover", ref: ref(action.ref) })
      case "drag": return act({ action: "drag", ref: ref(action.from), to: ref(action.to) })
      case "fill": return act({ action: "type", ref: ref(action.ref), text: String(action.text), clear: true })
      case "fill_form": {
        for (const field of action.fields as Array<Record<string, unknown>>) {
          if (field.type === "text") await page({ action: "type", ref: ref(field.ref), text: String(field.value), clear: true })
          else if (field.type === "select") await page(select(field.ref, field.values))
          else if (field.type === "check") {
            const outcome = await this.check(ref(field.ref), Boolean(field.checked), page)
            if (outcome.type === "failure") return outcome
          }
        }
        return this.success(this.tab())
      }
      case "select": return act(select(action.ref, action.values))
      case "check": return this.check(ref(action.ref), Boolean(action.checked), page)
      case "press": {
        const refusal = keyRefusal(String(action.key))
        return refusal ? failure("operation_failed", refusal) : act({ action: "press", key: String(action.key) })
      }
      case "scroll": {
        const y = Number(action.deltaY ?? 0), x = Number(action.deltaX ?? 0)
        if (y) await page({ action: "scroll", direction: y > 0 ? "down" : "up", amount: Math.abs(y) })
        if (x) await page({ action: "scroll", direction: x > 0 ? "right" : "left", amount: Math.abs(x) })
        return this.success(this.tab())
      }
      case "wait": return this.wait(action, page, deadline, signal)
      case "screenshot": {
        const { image } = await this.host.screenshot(target, deadline, signal)
        const bytes = Math.floor(image.data.length * 3 / 4) - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0)
        if (bytes > MAX_FILE_BYTES) return failure("operation_failed", "The screenshot exceeds the 5 MiB file limit; make the preview smaller and capture again.")
        return this.success({ tab: this.tab() }, [{ id: `file_${randomUUID()}`, name: "screenshot.png", mime: image.mime, data: image.data }])
      }
      default: return unsupported(action.type)
    }
  }

  private async open(action: Action, deadline: number, signal: AbortSignal): Promise<BrowserOutcome> {
    const url = typeof action.url === "string" ? action.url : "about:blank"
    if (!/^https?:/i.test(url)) return failure("unsupported", "The CodeNomad browser opens http:// and https:// addresses only.")
    try {
      const opened = await this.host.open(url, deadline, signal)
      // A new guest or document: refs from the previous one expire.
      this.target = undefined
      await this.refresh(deadline, signal)
      if (!this.target) return failure("operation_failed", "The page opened, but its preview is not visible to the agent.")
      this.url = opened.url
      return this.success(this.tab())
    } catch (error) { return failed(error) }
  }

  private async loaded({ url }: { url: string }, deadline: number, signal: AbortSignal) {
    this.target = undefined
    await this.refresh(deadline, signal)
    this.url = url
    return this.success(this.tab())
  }

  private async wait(action: Action, page: (step: BrowserPageAction) => Promise<Record<string, unknown>>, deadline: number, signal: AbortSignal): Promise<BrowserOutcome> {
    const timeout = Math.min(MAX_WAIT_MS, Number(action.timeoutMs) || 10_000)
    const started = Date.now()
    if (action.condition === "load") {
      // The native host reports a main-frame load from its start, before the new document commits.
      for (;;) {
        await this.refresh(deadline, signal)
        if (!this.target) return failure("operation_failed", "This tab is no longer shown. Call browser.tabs.list({}).")
        if (!this.loading) return this.success(this.tab())
        if (Date.now() - started >= timeout) return failure("condition_unmet", "The page is still loading.")
        await new Promise(resolve => setTimeout(resolve, LOAD_POLL_MS))
        signal.throwIfAborted()
      }
    }
    if (action.condition === "delay") {
      await new Promise(resolve => setTimeout(resolve, timeout))
      return this.success(this.tab())
    }
    if (action.condition !== "text" && action.condition !== "textGone") return unsupported(`wait for ${String(action.condition)}`)
    for (;;) {
      const remaining = timeout - (Date.now() - started)
      try {
        await page({ action: "wait", text: String(action.text), gone: action.condition === "textGone", timeout: Math.max(0, Math.min(PAGE_WAIT_MS, remaining)), literal: true })
        return this.success(this.tab())
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/did not appear within|is still shown after/.test(message)) return failed(error)
        if (Date.now() - started >= timeout) return failure("condition_unmet", message)
      }
    }
  }

  private async check(targetRef: string, wanted: boolean, page: (step: BrowserPageAction) => Promise<Record<string, unknown>>): Promise<BrowserOutcome> {
    const result = await page({ action: "snapshot", ref: targetRef })
    const line = String(result.snapshot ?? "").split("\n", 1)[0] ?? ""
    const state = checkState(line, targetRef)
    if (!state) return failure("operation_failed", `${targetRef} is not a checkbox or radio control`)
    const current = state === "checked"
    if (current === wanted) return this.success(this.tab())
    if (/^-\s+radio\b/.test(line) && !wanted) {
      return failure("operation_failed", "A selected radio button cannot be unchecked; check another option in its group.")
    }
    await page({ action: "click", ref: targetRef })
    // The page may refuse the change: only the state read back counts.
    const after = await page({ action: "snapshot", ref: targetRef })
    if ((checkState(String(after.snapshot ?? "").split("\n", 1)[0] ?? "", targetRef) === "checked") !== wanted)
      return failure("operation_failed", `${targetRef} did not stay ${wanted ? "checked" : "unchecked"}; the page kept its previous state.`)
    return this.success(this.tab())
  }

  private tab(): BrowserTab {
    return { id: this.id, url: this.url.slice(0, 16_384), title: this.title, loading: this.loading,
      canGoBack: this.canGoBack, canGoForward: this.canGoForward, generation: this.generation }
  }

  private success(value: unknown, files: { id: string; name: string; mime: string; data: string }[] = []): BrowserOutcome {
    return { type: "success", result: { value, files } }
  }
}

/** OpenCode refs may carry a leading `@`. */
const ref = (value: unknown) => String(value).replace(/^@/, "")

/** OpenCode selects options by their exact value. */
const select = (target: unknown, values: unknown): BrowserPageAction =>
  ({ action: "select", ref: ref(target), values: (values as unknown[]).map(String), byValue: true })

/** The control's checked state, read from the snapshot attributes after its ref: its quoted name and values never count. */
export function checkState(line: string, targetRef: string): "checked" | "unchecked" | "checked=mixed" | undefined {
  // Quoted names and values are emptied first: they may contain a ref or a state word.
  const bare = line.replace(/"(?:[^"\\]|\\.)*"/g, '""')
  const at = bare.indexOf(`[${targetRef}]`)
  if (at < 0) return undefined
  const attributes = bare.slice(at + targetRef.length + 2)
  return /(?:^|\s)(checked=mixed|checked|unchecked)(?=\s|$)/.exec(attributes)?.[1] as "checked" | "unchecked" | "checked=mixed" | undefined
}

/** OpenCode's browser refuses clipboard and context-menu shortcuts from agents (its `agentKeyRefusal`). */
export function keyRefusal(chord: string): string | undefined {
  let events
  try { events = keyChord(chord) } catch { return undefined }
  const main = events.find(event => event.type !== "keyUp" && !["Alt", "Control", "Meta", "Shift"].includes(event.key))
  if (!main) return undefined
  const { key, modifiers, windowsVirtualKeyCode: code } = main
  const shortcut = (modifiers & 6) !== 0, shift = (modifiers & 8) !== 0
  if ((shortcut && (/^[cvx]$/i.test(key) || [67, 86, 88].includes(code)))
    || ((key === "Insert" || code === 45) && (shift || (modifiers & 2) !== 0))
    || (shift && (key === "Delete" || code === 46 || key === "F10" || code === 121))
    || key === "ContextMenu" || code === 93)
    return "Agent input cannot use clipboard or context-menu shortcuts. Use fill to enter text and snapshot to read page text."
}

function failed(error: unknown): BrowserOutcome {
  const message = error instanceof Error ? error.message : String(error)
  if (/Unknown or stale ref/.test(message)) return failure("stale_ref", message)
  if (/unavailable in WebKit previews/.test(message)) return failure("unsupported", message)
  if (/changed|navigation|replaced|stale/i.test(message)) return failure("document_changed", message)
  return failure("operation_failed", message)
}
