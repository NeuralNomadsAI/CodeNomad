import { randomUUID } from "node:crypto"
import type { BrowserPageAction } from "../../automation/browser-page"

/** What CodeNomad's native session preview offers this adapter: the exact visible target and its operations. */
export interface PreviewHost {
  /** The visible preview's target, or undefined when the session shows none. */
  probe(sessionID: string, deadline: number): Promise<string | undefined>
  open(sessionID: string, url: string, deadline: number): Promise<{ url: string }>
  navigate(sessionID: string, url: string, target: string, deadline: number): Promise<{ url: string }>
  back(sessionID: string, target: string, deadline: number): Promise<{ url: string }>
  forward(sessionID: string, target: string, deadline: number): Promise<{ url: string }>
  reload(sessionID: string, target: string, deadline: number): Promise<{ url: string }>
  screenshot(sessionID: string, target: string, deadline: number): Promise<{ image: { mime: string; data: string } }>
  page(sessionID: string, action: BrowserPageAction, target: string, deadline: number, signal: AbortSignal): Promise<Record<string, unknown>>
}

export interface BrowserTab {
  id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; generation: number
}
export interface BrowserState { tabs: BrowserTab[]; focusedTabID: string | null }
export type BrowserOutcome =
  | { type: "success"; result: { value: unknown; files: { id: string; name: string; mime: string; data: string }[] } }
  | { type: "failure"; code: string; message: string }

/** OpenCode's wait bound; CodeNomad's page wait runs in chunks of at most its own bound. */
const MAX_WAIT_MS = 30_000, PAGE_WAIT_MS = 15_000, MAX_TEXT = 100_000
const failure = (code: string, message: string): BrowserOutcome => ({ type: "failure", code, message: message.slice(0, 2_000) })
const unsupported = (action: string) => failure("unsupported",
  `browser.${action} is not available in the CodeNomad browser. Use tabs, navigate, back, forward, reload, snapshot, find, click, hover, drag, fill, fill_form, select, check, press, scroll, wait or screenshot.`)

/**
 * One session's preview as OpenCode's browser contract sees it: at most one tab, the visible preview.
 * The tab ID is stable for the attachment; its generation changes with the document, which retires refs.
 */
export class PreviewTab {
  readonly id = `tab_${randomUUID()}`
  private target: string | undefined
  private url = "about:blank"
  private generation = 0

  constructor(private readonly host: PreviewHost, private readonly sessionID: string) {}

  state(): BrowserState {
    return this.target ? { tabs: [this.tab()], focusedTabID: this.id } : { tabs: [], focusedTabID: null }
  }

  /** Reads the visible target; a different document advances the generation. */
  async refresh(deadline: number, signal: AbortSignal): Promise<void> {
    const target = await this.host.probe(this.sessionID, deadline).catch(() => undefined)
    if (!target) { this.target = undefined; return }
    if (target === this.target) return
    this.target = target
    this.generation++
    const location = await this.host.page(this.sessionID, { action: "location" }, target, deadline, signal).catch(() => undefined)
    if (typeof location?.url === "string") this.url = location.url
  }

  async run(action: Record<string, unknown> & { type: string }, generation: number | undefined, signal: AbortSignal): Promise<BrowserOutcome> {
    const deadline = Date.now() + 55_000
    await this.refresh(deadline, signal)
    if (action.type === "tabs.list") return this.success(this.state())
    if (action.type === "tabs.open") return this.open(action, deadline, signal)
    if (typeof action.tabID === "string" && (action.tabID !== this.id || !this.target))
      return failure("operation_failed", "This tab is no longer shown. Call browser.tabs.list({}) or browser.tabs.open({ url }).")
    if (generation !== undefined && generation !== this.generation)
      return failure("document_changed", "The page changed before this action ran; take a new snapshot.")
    try {
      return await this.perform(action, this.target!, deadline, signal)
    } catch (error) {
      return failed(error)
    }
  }

  private async perform(action: Record<string, unknown> & { type: string }, target: string, deadline: number, signal: AbortSignal): Promise<BrowserOutcome> {
      switch (action.type) {
        case "tabs.focus": return this.success(this.tab())
        case "navigate": {
          const { url } = await this.host.navigate(this.sessionID, String(action.url), target, deadline)
          return this.loaded(url, deadline, signal)
        }
        case "back": {
          const { url } = await this.host.back(this.sessionID, target, deadline)
          return this.loaded(url, deadline, signal)
        }
        case "forward": {
          const { url } = await this.host.forward(this.sessionID, target, deadline)
          return this.loaded(url, deadline, signal)
        }
        case "reload": {
          const { url } = await this.host.reload(this.sessionID, target, deadline)
          return this.loaded(url, deadline, signal)
        }
        case "snapshot":
        case "find": {
          if (action.frameID !== undefined) return unsupported(`${action.type} with frameID`)
          const query = action.type === "find" ? String(action.text) : undefined
          const result = await this.page({ action: "snapshot", ...(action.ref ? { ref: ref(action.ref) } : {}), ...(query ? { query } : {}) }, deadline, signal)
          const text = String(result.snapshot ?? ""), limit = Math.min(MAX_TEXT, Number(action.maxChars) || MAX_TEXT)
          return this.success({ tab: this.tab(), content: text.slice(0, limit), truncated: Boolean(result.collapsed) || text.length > limit })
        }
        case "click": {
          if (action.button === "middle" || action.count === 2 || (Array.isArray(action.modifiers) && action.modifiers.length))
            return unsupported("click with middle button, double click or modifiers")
          return this.act({ action: "click", ref: ref(action.ref), ...(action.button === "right" ? { button: "right" as const } : {}) }, deadline, signal)
        }
        case "hover": return this.act({ action: "hover", ref: ref(action.ref) }, deadline, signal)
        case "drag": return this.act({ action: "drag", ref: ref(action.from), to: ref(action.to) }, deadline, signal)
        case "fill": return this.act({ action: "type", ref: ref(action.ref), text: String(action.text), clear: true }, deadline, signal)
        case "fill_form": {
          for (const field of action.fields as Array<Record<string, unknown>>) {
            if (field.type === "text") await this.page({ action: "type", ref: ref(field.ref), text: String(field.value), clear: true }, deadline, signal)
            else if (field.type === "select") await this.page({ action: "select", ref: ref(field.ref), values: (field.values as unknown[]).map(String) }, deadline, signal)
            else if (field.type === "check") {
              const outcome = await this.check(ref(field.ref), Boolean(field.checked), deadline, signal)
              if (outcome.type === "failure") return outcome
            }
          }
          return this.success(this.tab())
        }
        case "select": return this.act({ action: "select", ref: ref(action.ref), values: (action.values as unknown[]).map(String) }, deadline, signal)
        case "check": return this.check(ref(action.ref), Boolean(action.checked), deadline, signal)
        case "press": return this.act({ action: "press", key: String(action.key) }, deadline, signal)
        case "scroll": {
          const y = Number(action.deltaY ?? 0), x = Number(action.deltaX ?? 0)
          if (y) await this.page({ action: "scroll", direction: y > 0 ? "down" : "up", amount: Math.abs(y) }, deadline, signal)
          if (x) await this.page({ action: "scroll", direction: x > 0 ? "right" : "left", amount: Math.abs(x) }, deadline, signal)
          return this.success(this.tab())
        }
        case "wait": return this.wait(action, deadline, signal)
        case "screenshot": {
          if (action.ref !== undefined || action.fullPage || (action.format !== undefined && action.format !== "png"))
            return unsupported("screenshot of an element, of the full page or in another format than PNG")
          const { image } = await this.host.screenshot(this.sessionID, target, deadline)
          return this.success({ tab: this.tab() }, [{ id: `file_${randomUUID()}`, name: "screenshot.png", mime: image.mime, data: image.data }])
        }
        default: return unsupported(action.type)
      }
  }

  private async open(action: Record<string, unknown>, deadline: number, signal: AbortSignal): Promise<BrowserOutcome> {
    const url = typeof action.url === "string" ? action.url : "about:blank"
    if (!/^https?:/i.test(url)) return failure("unsupported", "The CodeNomad browser opens http:// and https:// addresses only.")
    try {
      const opened = await this.host.open(this.sessionID, url, deadline)
      // A new guest or document: refs from the previous one expire.
      this.target = undefined
      await this.refresh(deadline, signal)
      if (!this.target) return failure("operation_failed", "The page opened, but its preview is not visible to the agent.")
      this.url = opened.url
      return this.success(this.tab())
    } catch (error) { return failed(error) }
  }

  private async loaded(url: string, deadline: number, signal: AbortSignal) {
    this.target = undefined
    await this.refresh(deadline, signal)
    this.url = url
    return this.success(this.tab())
  }

  private async wait(action: Record<string, unknown>, deadline: number, signal: AbortSignal): Promise<BrowserOutcome> {
    const timeout = Math.min(MAX_WAIT_MS, Number(action.timeoutMs) || 10_000)
    if (action.condition === "load") return this.success(this.tab())
    if (action.condition === "delay") {
      await new Promise(resolve => setTimeout(resolve, timeout))
      return this.success(this.tab())
    }
    if (action.condition !== "text" && action.condition !== "textGone") return unsupported(`wait for ${String(action.condition)}`)
    const started = Date.now()
    for (;;) {
      const remaining = timeout - (Date.now() - started)
      try {
        await this.page({ action: "wait", text: String(action.text), gone: action.condition === "textGone", timeout: Math.max(0, Math.min(PAGE_WAIT_MS, remaining)) }, deadline, signal)
        return this.success(this.tab())
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/did not appear within|is still shown after/.test(message)) return failed(error)
        if (Date.now() - started >= timeout) return failure("condition_unmet", message)
      }
    }
  }

  private async check(targetRef: string, wanted: boolean, deadline: number, signal: AbortSignal): Promise<BrowserOutcome> {
    const result = await this.page({ action: "snapshot", ref: targetRef }, deadline, signal)
    const line = String(result.snapshot ?? "").split("\n", 1)[0] ?? ""
    const state = /\s(checked(?:=mixed)?|unchecked)(?:\s|$)/.exec(line)?.[1]
    if (!state) return failure("operation_failed", `${targetRef} is not a checkbox or radio control`)
    const current = state === "checked"
    if (current === wanted) return this.success(this.tab())
    if (/^-\s+radio\b/.test(line) && !wanted) {
      return failure("operation_failed", "A selected radio button cannot be unchecked; check another option in its group.")
    }
    return this.act({ action: "click", ref: targetRef }, deadline, signal)
  }

  private async act(action: BrowserPageAction, deadline: number, signal: AbortSignal) {
    await this.page(action, deadline, signal)
    return this.success(this.tab())
  }

  private page(action: BrowserPageAction, deadline: number, signal: AbortSignal) {
    return this.host.page(this.sessionID, action, this.target!, deadline, signal)
  }

  private tab(): BrowserTab {
    return { id: this.id, url: this.url.slice(0, 16_384), title: "", loading: false, canGoBack: false, canGoForward: false, generation: this.generation }
  }

  private success(value: unknown, files: { id: string; name: string; mime: string; data: string }[] = []): BrowserOutcome {
    return { type: "success", result: { value, files } }
  }
}

/** OpenCode refs may carry a leading `@`. */
const ref = (value: unknown) => String(value).replace(/^@/, "")

function failed(error: unknown): BrowserOutcome {
  const message = error instanceof Error ? error.message : String(error)
  if (/Unknown or stale ref/.test(message)) return failure("stale_ref", message)
  if (/changed|navigation|replaced|stale/i.test(message)) return failure("document_changed", message)
  return failure("operation_failed", message)
}
