import { VALUE_LIMIT, type PageFunctionId } from "./functions"
export { VALUE_LIMIT, INPUT_MARK_LEASE_MS } from "./functions"

/** Low-level CDP transport, used only by the CDP adapter. A native preview also serves its diagnostic event buffer. */
export interface PageChannel {
  /** `sessionId` reaches an out-of-process frame's protocol session. */
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>
  diagnostics?(after: number): Promise<Record<string, unknown>>
}
export const PAGE_DRIVER_VERSION = 1
export const OBJECT_GROUP = "codenomad-automation"
export type DriverKind = "cdp" | "webkit"
export interface SemanticNode {
  id?: string; parent?: string; children?: string[]; ignored?: boolean; node?: number
  role?: unknown; name?: unknown; description?: unknown; value?: unknown
  properties?: Array<{ name?: string; value?: unknown }>
}
export interface PointerInput { type: "mouseMoved" | "mousePressed" | "mouseReleased"; x: number; y: number; button?: "left" | "right" | "middle" | "none"; buttons?: number; clickCount?: number; modifiers?: number; timestamp?: number }
export interface WheelInput { type: "mouseWheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number; timestamp?: number }
export interface KeyboardInput { type: "keyDown" | "rawKeyDown" | "keyUp"; key?: string; code?: string; windowsVirtualKeyCode?: number; modifiers?: number; text?: string; unmodifiedText?: string; location?: number; timestamp?: number; buttons?: number }
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type PageArgument = JsonValue
export interface CallResult { value?: unknown; handle?: string; exception?: string }
export type PageOperation =
  | { op: "tree" | "viewport" | "release-handles" | "checkpoint" }
  | { op: "resolve" | "scroll-into-view" | "geometry"; node: number }
  | { op: "hit-test"; x: number; y: number }
  | { op: "call"; function: PageFunctionId; handle?: string; args: PageArgument[] }
  | { op: "pointer"; event: PointerInput }
  | { op: "wheel"; event: WheelInput }
  | { op: "keyboard"; event: KeyboardInput }
  | { op: "insert-text"; text: string }
  /** The document's title and whether its tab can go back or forward (`{ title, canGoBack, canGoForward }`). */
  | { op: "history" }
  /** The preview's console and network events after a sequence number (`DiagnosticRead`). */
  | { op: "diagnostics"; after: number }
  /** A retained response's body by its protocol request ID, in its frame's session when it has one. */
  | { op: "response-body"; request: string; session?: string }

/** One semantic page; drivers own protocol/native adaptation, never arbitrary evaluation. */
export interface PageDriver {
  readonly kind: DriverKind
  readonly version: typeof PAGE_DRIVER_VERSION
  tree(): Promise<SemanticNode[]>
  resolve(node: number): Promise<string | undefined>
  call(functionId: PageFunctionId, handle: string | undefined, args: PageArgument[]): Promise<CallResult>
  scrollIntoView(node: number): Promise<void>
  geometry(node: number): Promise<number[][]>
  viewport(): Promise<{ width: number; height: number }>
  hitTest(x: number, y: number): Promise<number | undefined>
  pointer(event: PointerInput): Promise<void>
  wheel(event: WheelInput): Promise<void>
  keyboard(event: KeyboardInput): Promise<void>
  insertText(text: string): Promise<void>
  releaseHandles(): Promise<void>
  checkpoint(): Promise<void>
}
export class PageDriverUnsupportedError extends Error {
  readonly code = "unsupported"
  constructor(readonly driver: DriverKind, readonly operation: string) { super(`${driver} page driver does not support ${operation}`) }
}
export interface InputTarget { ref: string; handle: string; dragSource?: string }
export interface PageSession {
  driver: PageDriver
  checkpoint(): Promise<void>
  guardInput?(): void
  markAutomation: boolean
  /** Expected ref for the current native dispatch, scoped to the serialized page operation. */
  inputTarget?: InputTarget
  /** The current input sequence handed the host a press, wheel or text event that it accepted. */
  inputDelivered?: boolean
}
export class Handle { constructor(readonly objectId: string) {} }
export function gone(ref: string): Error { return new Error(`${ref} is no longer in the page; inspect again`) }
const MUTATIONS: Partial<Record<PageFunctionId, string>> = {
  "programmatic-click": "click", "option-click": "option selection", select: "selection", "select-values": "selection",
  "set-value": "field update", "delete-selection": "text deletion", focus: "focus change", prepare: "field preparation",
}

export async function resolveElement(session: PageSession, ref: string, node: number): Promise<string> {
  let handle: string | undefined
  try { handle = await session.driver.resolve(node) } catch (error) {
    if (error instanceof PageDriverUnsupportedError) throw error
    throw gone(ref)
  }
  await session.checkpoint()
  if (typeof handle !== "string") throw gone(ref)
  return handle
}
export async function callOn(session: PageSession, ref: string, handle: string, functionId: PageFunctionId, args: Array<PageArgument | Handle>, byValue = true): Promise<unknown> {
  const mutation = MUTATIONS[functionId]
  const unknown = (cause?: unknown) => new Error(`The ${mutation} outcome is unknown; inspect before retrying.`, { cause })
  const result = await session.driver.call(functionId, handle, args.map(value => value instanceof Handle ? { handle: value.objectId } : value))
    .catch(error => {
      if (mutation && lostMutationReply(error)) throw unknown(error)
      throw error
    })
  if (result.exception !== undefined) {
    if (mutation && !/^(?:Error: )?codenomad:/.test(result.exception)) throw unknown(pageError(ref, result.exception))
    throw pageError(ref, result.exception)
  }
  if (mutation && !isMutationResult(functionId, result.value)) throw unknown()
  const mayHaveRun = mutation && (functionId !== "option-click" || result.value !== null)
  try { await session.checkpoint() }
  catch (error) {
    if (mayHaveRun) throw new Error(`The ${mutation} was sent, but its result could not be confirmed; inspect before retrying.`, { cause: error })
    throw error
  }
  if (!byValue) { if (typeof result.handle !== "string") throw gone(ref); return result.handle }
  return result.value
}
export async function releaseObjects(session: PageSession): Promise<void> { await session.driver.releaseHandles().catch(() => undefined) }

function isMutationResult(id: PageFunctionId, value: unknown): boolean {
  if (id === "prepare") return value === "insert" || value === "value" || value === "append"
  if (id === "option-click" && value === null) return true
  if (id === "select" || id === "select-values" || id === "option-click") return Array.isArray(value) && value.every(item => typeof item === "string")
  return value === null
}

function lostMutationReply(error: unknown): boolean {
  // The transports currently report lost replies and explicit rejections as plain errors.
  return error instanceof Error && !(error instanceof PageTargetChangedError) &&
    (/^(?:CDP (?:command Runtime\.callFunctionOn timed out|WebSocket (?:closed|connection failed))|Developer (?:CDP controller closed|target retired))$/.test(error.message) ||
      /^(?:Native request timed out: browser\.page\.send|(?:Native|WebView2) browser command timed out|Native parent is shutting down|Browser page (?:document changed; inspect again|lease is no longer current|response is too large))$/.test(error.message))
}

function pageError(ref: string, description: string): Error {
  const [code, detail = ""] = /codenomad:([a-z-]+)(?::(.*))?/.exec(description.split("\n", 1)[0])?.slice(1) ?? []
  const quoted = JSON.stringify(detail.slice(0, VALUE_LIMIT))
  switch (code) {
    case "gone": return gone(ref)
    case "not-select": return new Error(`${ref} is not a native select; click it to open its menu, then click the option`)
    case "is-select": return new Error(`${ref} is a native select; use select with its option labels`)
    case "no-option": return new Error(`No option ${quoted} in ${ref}; inspect it to see its options`)
    case "options-changed": return new Error(`The options of ${ref} changed during focus; inspect again`)
    case "option-disabled": return new Error(`Option ${quoted} of ${ref} is disabled`)
    case "single": return new Error(`${ref} takes exactly one value`)
    case "disabled": return new Error(`${ref} is disabled`)
    case "readonly": return new Error(`${ref} is read-only`)
    case "delete-refused": return new Error(`The page refused to delete the selection in ${ref}`)
    case "not-editable": return new Error(`${ref} is not a text field`)
    case "not-text": return new Error(`${ref} is not a text field; use click`)
    case "unfocusable": return new Error(`${ref} cannot take focus (hidden, disabled or behind a dialog); reveal it, then inspect again`)
    case "invalid-value": return new Error(`${quoted} is not a valid value for ${ref}`)
    case "action-root": return new PageTargetChangedError("Page changed during action; inspect again")
    case "action-tab": return new PageTargetChangedError("The active tab changed during the action; inspect again", true)
    case "has-box": return new Error(`${ref} now has a box; inspect before clicking`)
    default: return new Error(`The page rejected the action on ${ref}: ${description.split("\n", 1)[0].slice(0, VALUE_LIMIT)}`)
  }
}

type InputKind = "pointer" | "wheel" | "keyboard" | "insert-text"
async function sendInput(session: PageSession, kind: InputKind, params: Record<string, unknown>, target?: InputTarget): Promise<void> {
  session.inputTarget = target
  try {
    switch (kind) {
      case "pointer": return await session.driver.pointer(params as unknown as PointerInput)
      case "wheel": return await session.driver.wheel(params as unknown as WheelInput)
      case "keyboard": return await session.driver.keyboard(params as unknown as KeyboardInput)
      case "insert-text": return await session.driver.insertText(params.text as string)
    }
  } finally {
    session.inputTarget = undefined
  }
}
export class PageTargetChangedError extends Error {
  constructor(message: string, readonly sameDocument = false) { super(message) }
}
/** Native dispatch was never attempted; cleanup may recheck the same destination once. */
export class InputCheckTimeout extends PageTargetChangedError {}

/** Provenance marking belongs only to the trusted application window. */
export async function markedInput<T>(session: PageSession, run: (dispatch: (kind: InputKind, params: Record<string, unknown>, target?: InputTarget) => Promise<void>) => Promise<T>): Promise<T> {
  const held = new Map<string, { kind: InputKind; params: Record<string, unknown>; target?: InputTarget }>()
  let point: { x: number; y: number; target?: InputTarget } | undefined
  let attempted = false
  let marked = false
  let targetLost: PageTargetChangedError | undefined
  const checkInput = () => session.guardInput ? session.guardInput() : session.checkpoint()
  const dispatch = async (kind: InputKind, params: Record<string, unknown>, target?: InputTarget) => {
    let timestamp: number | undefined
    const mouse = kind === "pointer" || kind === "wheel"
    const id = mouse ? `mouse:${params.button}` : `key:${params.code}`
    const up = mouse ? params.type === "mouseReleased" : params.type === "keyUp"
    if (session.markAutomation) {
      await checkInput()
      marked = true
      const stamp = (await session.driver.call("mark-input", undefined, [])).value
      if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0) throw new Error("Cannot establish automation input provenance")
      timestamp = stamp
      await checkInput()
    }
    const down = mouse ? params.type === "mousePressed" : params.type === "keyDown" || params.type === "rawKeyDown"
    let failure: { error: unknown } | undefined
    try {
      await sendInput(session, kind, { ...params, ...(timestamp === undefined || kind === "insert-text" ? {} : { timestamp }) }, target)
    } catch (error) {
      // The application channel throws this only before handing input to CDP.
      if (error instanceof PageTargetChangedError) {
        if (up) {
          if (!(error instanceof InputCheckTimeout)) held.delete(id)
          else if (mouse && typeof params.x === "number" && typeof params.y === "number")
            point = { x: params.x, y: params.y, target }
        }
        throw error
      }
      failure = { error }
    }
    if (up) held.delete(id)
    attempted = true
    if (mouse && typeof params.x === "number" && typeof params.y === "number") point = { x: params.x, y: params.y, target }
    if (down) held.set(id, { kind, target, params: { ...params, type: mouse ? "mouseReleased" : "keyUp", buttons: 0, modifiers: 0,
      ...(timestamp === undefined ? {} : { timestamp }) } })
    if (failure) throw failure.error
    if (params.type !== "mouseMoved") session.inputDelivered = true
    await session.checkpoint()
  }
  session.inputDelivered = false
  await awaitInputAcceptance(session)
  try { return await run(dispatch) }
  catch (error) {
    if (error instanceof PageTargetChangedError) targetLost = error
    if (attempted && !(error instanceof PageTargetChangedError) && error instanceof Error && /timed out|timeout/i.test(error.message)) throw new Error("Input timed out: its outcome is unknown. The page was busy and the input may still be delivered; inspect before retrying.")
    if (attempted && session.markAutomation && error instanceof Error) {
      throw new Error(`${error.message}. Input already sent may still be delivered; inspect before retrying.`, { cause: error })
    }
    throw error
  } finally {
    for (const release of targetLost && !targetLost.sameDocument ? [] : [...held.values()].reverse()) {
      try {
        if (release.kind === "pointer" && (!point || (session.guardInput && !point.target))) continue
        await checkInput()
        if (session.markAutomation) await session.driver.call("mark-input", undefined, []).catch(error => {
          if (error instanceof PageTargetChangedError && !(error instanceof InputCheckTimeout)) throw error
        })
        await checkInput()
        const { text: _text, unmodifiedText: _unmodified, ...params } = release.params
        if (release.kind === "pointer" && point) await sendInput(session, release.kind, { ...params, x: point.x, y: point.y }, point.target)
        else await sendInput(session, release.kind, params, release.target)
      } catch (error) {
        if (error instanceof PageTargetChangedError) { targetLost = error; break }
        // Cleanup cannot replay a press or dispatch without a current context.
      }
    }
    if (marked && (!targetLost || targetLost.sameDocument)) {
      await session.driver.call("unmark-input", undefined, []).catch(() => undefined)
    }
  }
}
async function awaitInputAcceptance(session: PageSession): Promise<void> {
  const started = Date.now()
  for (;;) {
    const result = await session.driver.call("input-acceptance", undefined, []).catch(error => {
      if (error instanceof PageDriverUnsupportedError) throw error
      return undefined
    })
    await session.checkpoint()
    const delay = (result?.value as { inputDelayMs?: unknown } | undefined)?.inputDelayMs
    const remaining = 1_000 - (Date.now() - started)
    if (typeof delay !== "number" || !(delay > 0) || remaining <= 0) return
    await new Promise(resolve => setTimeout(resolve, Math.min(delay, remaining, 50)))
  }
}
