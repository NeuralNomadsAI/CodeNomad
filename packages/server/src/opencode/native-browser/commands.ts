import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { pageMoved, type BrowserPageAction } from "../../automation/browser-page"
import type { DiagnosticRead } from "../../automation/page/diagnostic-events"
import { keyChord } from "../../automation/page/keys"
import { PreviewDiagnostics } from "./diagnostics"

/** What CodeNomad's native session preview offers this adapter, already bound to its session. */
export interface PreviewHost {
  /** The visible preview's target, its registration and whether a main-frame load is in progress, or undefined when
   * the session shows none. */
  probe(deadline: number, signal: AbortSignal): Promise<{ target: string; loading: boolean; registration?: string } | undefined>
  open(url: string, deadline: number, signal: AbortSignal): Promise<Loaded>
  /** Loads end with the URL and the registration of the preview that loaded it. */
  navigate(url: string, target: string, deadline: number, signal: AbortSignal): Promise<Loaded>
  back(target: string, deadline: number, signal: AbortSignal): Promise<Loaded>
  forward(target: string, deadline: number, signal: AbortSignal): Promise<Loaded>
  reload(target: string, deadline: number, signal: AbortSignal): Promise<Loaded>
  screenshot(target: string, deadline: number, signal: AbortSignal): Promise<{ image: { mime: string; data: string } }>
  page(action: BrowserPageAction, target: string, deadline: number, signal: AbortSignal): Promise<Record<string, unknown>>
}

export interface Loaded { url: string; registration?: string }

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
  wait: ["condition", "text", "url", "timeoutMs"], screenshot: [],
  console: ["level", "limit"], "network.list": ["urlContains", "resourceType", "limit"],
  "network.get": ["id", "includeBody", "includeResponseBody", "maxBodyChars"],
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
  `browser.${action} is not available in the CodeNomad browser. Use tabs, navigate, back, forward, reload, snapshot, find, click, hover, drag, fill, fill_form, select, check, press, scroll, wait, screenshot, console or network.`)

/**
 * One session's preview as OpenCode's browser contract sees it: at most one tab, the visible preview.
 * The tab ID is stable for the attachment; its generation changes with the document, which retires refs.
 * Each command keeps the target it started on, so its steps never reach a later document.
 */
export class PreviewTab {
  /** A web open and a preview replaced by another registration give a new tab: an older ID names a tab that is gone. */
  private tabID = `tab_${randomUUID()}`
  get id(): string { return this.tabID }
  private target: string | undefined
  private url = "about:blank"
  /** The target whose address `url` holds: a failed read is retried on the next refresh. */
  private urlTarget: string | undefined
  /** The tab (and, for a readout, the document) a successful command names; the inventory publication rechecks it. */
  private claim: { id: string; document?: number } | undefined
  /** The preview registration the target belongs to: a load that ends in another preview is no receipt for this tab. */
  private registration: string | undefined
  private refreshes = 0
  private applied = 0
  private title = ""
  private canGoBack = false
  private canGoForward = false
  private queue: Promise<void> = Promise.resolve()
  private loading = false
  private generation = 0
  private readonly diagnostics = new PreviewDiagnostics()
  /** The tab the readouts belong to. */
  private diagnosticsTab = ""

  constructor(private readonly host: PreviewHost) {}

  state(): BrowserState {
    return this.target ? { tabs: [this.tab()], focusedTabID: this.id } : { tabs: [], focusedTabID: null }
  }

  /** Reads the visible target; a different document advances the generation. */
  async refresh(deadline: number, signal: AbortSignal): Promise<void> {
    // tabs.list refreshes outside the command queue: a probe answered after a later one has been applied is stale.
    const ticket = ++this.refreshes
    const probed = await this.host.probe(deadline, signal).catch(() => undefined)
    if (ticket < this.applied) return
    this.applied = ticket
    // The last registration is kept while no preview shows: whichever preview shows next is another tab unless it is
    // the same registration.
    if (!probed) { this.target = undefined; this.loading = false; return }
    this.loading = probed.loading
    if (this.registration !== undefined && probed.registration !== this.registration) this.tabID = `tab_${randomUUID()}`
    this.registration = probed.registration
    if (probed.target !== this.target) {
      this.target = probed.target
      this.generation++
    }
    if (this.urlTarget === probed.target) return
    const location = await this.host.page({ action: "location" }, probed.target, deadline, signal).catch(() => undefined)
    if (ticket < this.applied) return
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

  /** Commands run one at a time: a check reads, then clicks, and another command must not act in between.
   * `admit` runs when the command's turn comes, before it reads or acts; an outcome it returns refuses the command. */
  async run(action: Action, generation: number | undefined, signal: AbortSignal,
    admit: () => Promise<BrowserOutcome | undefined> = async () => undefined,
    conclude: (outcome: BrowserOutcome) => Promise<BrowserOutcome> = async outcome => outcome): Promise<BrowserOutcome> {
    if (action.type === "tabs.list") {
      // Same-document navigation keeps the target: the address, title and history are read again.
      this.urlTarget = undefined
      return conclude(await admit() ?? await this.execute(action, generation, signal))
    }
    const previous = this.queue
    let release!: () => void
    this.queue = new Promise<void>(resolve => { release = resolve })
    try {
      await previous
      if (signal.aborted) return failure("operation_failed", "The browser action was cancelled.")
      // `conclude` (the inventory publication) runs before the next command: a later open cannot replace the tab an
      // earlier one is about to report. The publication refreshes the tab: a success naming a tab or document it
      // replaced fails instead.
      this.claim = undefined
      const outcome = await conclude(await admit() ?? await this.execute(action, generation, signal))
      // Commands set it while awaited: TypeScript would otherwise keep the narrowing above.
      const claim = this.claim as { id: string; document?: number } | undefined
      if (outcome.type === "success" && claim && (!this.target || this.id !== claim.id
        || (claim.document !== undefined && this.generation !== claim.document))) return replaced()
      return outcome
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
    // A navigation replaces the document anyway and a wait reads whichever is current, as in OpenCode's browser.
    if (generation !== undefined && generation !== this.generation && action.type !== "navigate" && action.type !== "wait")
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
    const act = async (step: BrowserPageAction) => {
      // Input that moved the page on (a followed link, a submitted form) succeeded: the tab reports where it went.
      const tab = this.id
      if ((await page(step)).pageChanged) {
        await this.refresh(deadline, signal)
        if (!this.target || this.id !== tab) return failure("operation_failed", "This tab is no longer shown. Call browser.tabs.list({}).")
      }
      return this.success(this.tab())
    }
    switch (action.type) {
      case "tabs.focus": return this.success(this.tab())
      case "navigate": return this.loaded(await this.host.navigate(String(action.url), target, deadline, signal), deadline, signal)
      case "back": return this.loaded(await this.host.back(target, deadline, signal), deadline, signal)
      case "forward": return this.loaded(await this.host.forward(target, deadline, signal), deadline, signal)
      case "reload": return this.loaded(await this.host.reload(target, deadline, signal), deadline, signal)
      case "snapshot":
      case "find": {
        const query = action.type === "find" ? String(action.text) : undefined
        const maxLines = Number(action.maxLines) || 0, limit = Math.min(MAX_TEXT, Number(action.maxChars) || DEFAULT_SNAPSHOT_CHARS)
        // The page renders within the requested limit, so a larger one expands collapsed nodes.
        const result = await page({ action: "snapshot", ...(action.ref ? { ref: ref(action.ref) } : {}), ...(query ? { query } : {}), budget: limit })
        let text = String(result.snapshot ?? ""), truncated = Boolean(result.collapsed)
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
        // One wheel event with both deltas, as OpenCode's browser sends.
        if (x || y) await page({ action: "scroll", delta: { x, y } })
        return this.success(this.tab())
      }
      case "wait": return this.wait(action, deadline, signal)
      // A readout belongs to the tab and document it was read for: a tabs.list that sees either change meanwhile fails it.
      case "console": {
        const tab = this.id, document = this.generation
        await this.pull(page)
        this.claim = { id: tab, document }
        return this.id !== tab || this.generation !== document ? replaced() : this.success({ tab: this.tab(), ...this.diagnostics.console(action as Parameters<PreviewDiagnostics["console"]>[0]) })
      }
      case "network.list": {
        const tab = this.id, document = this.generation
        await this.pull(page)
        this.claim = { id: tab, document }
        return this.id !== tab || this.generation !== document ? replaced() : this.success({ tab: this.tab(), ...this.diagnostics.list(action as Parameters<PreviewDiagnostics["list"]>[0]) })
      }
      case "network.get": {
        const tab = this.id, document = this.generation
        await this.pull(page)
        const request = await this.diagnostics.get(action as Action & { id: string }, async (nativeID, session) => page({ action: "response-body", request: nativeID, ...(session ? { session } : {}) }))
        this.claim = { id: tab, document }
        return this.id !== tab || this.generation !== document ? replaced() : this.success({ tab: this.tab(), ...request })
      }
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
      // The host's events so far belong to the previous tab: they are read before the open, so the new tab's readouts
      // start with the open itself, its own document's startup included, even when it keeps the document (a
      // fragment). Previews without diagnostics, or without a page yet, skip this.
      const shown = this.target
      if (shown) await this.pull(step => this.host.page(step, shown, deadline, signal)).catch(() => undefined)
      const opened = await this.host.open(url, deadline, signal)
      // A new guest or document: refs from the previous one expire.
      this.target = undefined
      await this.refresh(deadline, signal)
      if (!this.target || opened.registration !== this.registration)
        return failure("operation_failed", "The page opened, but its preview is not the one shown to the agent. Call browser.tabs.list({}).")
      // The address read from the preview is current; the receipt's only stands in when that read failed.
      if (this.urlTarget !== this.target) this.url = opened.url
      // OpenCode's web open gives a new tab: the one preview takes a new ID, so the previous one is never retargeted.
      this.tabID = `tab_${randomUUID()}`
      this.claim = { id: this.id }
      return this.success(this.tab())
    } catch (error) { return failed(error) }
  }

  private async loaded({ url, registration }: Loaded, deadline: number, signal: AbortSignal) {
    this.target = undefined
    await this.refresh(deadline, signal)
    // The result names a tab only while the inventory still lists the preview that loaded the page.
    if (!this.target || registration !== this.registration)
      return failure("operation_failed", "The page loaded, but its preview is no longer the one shown to the agent. Call browser.tabs.list({}).")
    if (this.urlTarget !== this.target) this.url = url
    this.claim = { id: this.id }
    return this.success(this.tab())
  }

  private async wait(action: Action, deadline: number, signal: AbortSignal): Promise<BrowserOutcome> {
    const timeout = Math.min(MAX_WAIT_MS, Number(action.timeoutMs) || 10_000)
    const started = Date.now()
    // A wait belongs to its tab: another preview replacing it ends the wait.
    const tab = this.id
    const gone = () => failure("operation_failed", "This tab is no longer shown. Call browser.tabs.list({}).")
    if (action.condition === "url") {
      for (;;) {
        // The address is read again each time: a same-document route change keeps the target.
        this.urlTarget = undefined
        await this.refresh(deadline, signal)
        if (!this.target || this.id !== tab) return gone()
        // Only an address read just now counts: a failed read leaves the cached one.
        if (this.urlTarget === this.target && matchesURL(this.url, String(action.url ?? ""))) return this.success(this.tab())
        if (Date.now() - started >= timeout) return failure("condition_unmet", `The address did not match ${String(action.url ?? "")} in time.`)
        await sleep(LOAD_POLL_MS, undefined, { signal })
      }
    }
    if (action.condition === "load") {
      // The native host reports a main-frame load from its start, before the new document commits.
      for (;;) {
        await this.refresh(deadline, signal)
        if (!this.target || this.id !== tab) return gone()
        if (!this.loading) return this.success(this.tab())
        if (Date.now() - started >= timeout) return failure("condition_unmet", "The page is still loading.")
        await sleep(LOAD_POLL_MS, undefined, { signal })
      }
    }
    if (action.condition === "delay") {
      // A cancelled pause releases the command queue at once.
      await sleep(timeout, undefined, { signal })
      return this.success(this.tab())
    }
    if (action.condition !== "text" && action.condition !== "textGone") return unsupported(`wait for ${String(action.condition)}`)
    // The text is read from whichever document the tab shows, as in OpenCode's browser: a navigation moves the wait on.
    for (;;) {
      const remaining = timeout - (Date.now() - started)
      const target = this.target
      if (!target) return failure("operation_failed", "This tab is no longer shown. Call browser.tabs.list({}).")
      try {
        const result = await this.host.page({ action: "wait", text: String(action.text), gone: action.condition === "textGone",
          timeout: Math.max(0, Math.min(PAGE_WAIT_MS, remaining)), literal: true }, target, deadline, signal)
        this.noteURL(target, result.url)
        return this.success(this.tab())
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const moved = pageMoved(error)
        if (!moved && !/did not appear within|is still shown after/.test(message)) return failed(error)
        if (Date.now() - started >= timeout) return failure("condition_unmet", moved ? "The page changed and the text did not appear in time." : message)
        if (moved) {
          await sleep(LOAD_POLL_MS, undefined, { signal })
          await this.refresh(deadline, signal)
          if (this.id !== tab) return gone()
        }
      }
    }
  }

  private async check(targetRef: string, wanted: boolean, page: (step: BrowserPageAction) => Promise<Record<string, unknown>>): Promise<BrowserOutcome> {
    const result = await page({ action: "snapshot", ref: targetRef })
    const line = String(result.snapshot ?? "").split("\n", 1)[0] ?? ""
    const state = checkState(line, targetRef)
    if (!state) return failure("operation_failed", `${targetRef} is not a checkbox or radio control`)
    // A native control's `checked` property decides, as in OpenCode's browser: a mixed checkbox may be either.
    const property = async () => {
      const read = await page({ action: "checked", ref: targetRef })
      return typeof read.checked === "boolean" ? read.checked : undefined
    }
    const current = await property() ?? state === "checked"
    if (current === wanted) return this.success(this.tab())
    if (/^-\s+radio\b/.test(line) && !wanted) {
      return failure("operation_failed", "A selected radio button cannot be unchecked; check another option in its group.")
    }
    await page({ action: "click", ref: targetRef })
    // The page may refuse the change or replace the control: only the checked state read back counts.
    const after = await page({ action: "snapshot", ref: targetRef })
    const afterState = checkState(String(after.snapshot ?? "").split("\n", 1)[0] ?? "", targetRef)
    const native = afterState && await property()
    const kept = afterState !== undefined && (typeof native === "boolean" ? native === wanted : afterState === (wanted ? "checked" : "unchecked"))
    if (!kept)
      return failure("operation_failed", `${targetRef} did not stay ${wanted ? "checked" : "unchecked"}; the page kept its previous state.`)
    return this.success(this.tab())
  }

  /** Takes the host's new console and network events for the current document. */
  private async pull(page: (step: BrowserPageAction) => Promise<Record<string, unknown>>): Promise<void> {
    // A new tab (a web open or another preview) starts with empty readouts, as a fresh tab does in OpenCode.
    if (this.diagnosticsTab !== this.id) {
      this.diagnostics.forget()
      this.diagnosticsTab = this.id
    }
    for (let read = 0; read < 16; read++) {
      const events = await page({ action: "diagnostics", after: this.diagnostics.cursor }) as unknown as DiagnosticRead
      if (!this.diagnostics.ingest(events)) continue
      if (!events.more) return
    }
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

const replaced = () => failure("document_changed", "The tab or its page changed while it was read. Call browser.tabs.list({}) and read again.")

function failed(error: unknown): BrowserOutcome {
  const message = error instanceof Error ? error.message : String(error)
  if (/Unknown or stale ref/.test(message)) return failure("stale_ref", message)
  if (/unavailable in WebKit previews|diagnostics are unavailable|does not support diagnostics/.test(message)) return failure("unsupported", message)
  if (/changed|navigation|replaced|stale|no longer current/i.test(message)) return failure("document_changed", message)
  return failure("operation_failed", message)
}

// OpenCode's URL wait pattern (plugin-browser/src/rpc.ts, v2.4.1, MIT): a glob such as **/dashboard matches the
// whole address; plain text matches anywhere in it.
export function matchesURL(url: string, pattern: string): boolean {
  if (!pattern.includes("*")) return url.includes(pattern)
  const parts = pattern.split(/\*+/)
  const first = parts.shift() ?? ""
  const last = parts.pop() ?? ""
  if (!url.startsWith(first) || !url.endsWith(last)) return false
  let offset = first.length
  for (const part of parts) {
    const found = url.indexOf(part, offset)
    if (found < 0) return false
    offset = found + part.length
  }
  return offset + last.length <= url.length
}