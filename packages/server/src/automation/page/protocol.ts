import { VALUE_LIMIT, type PageFunctionId } from "./functions"
export { VALUE_LIMIT, INPUT_MARK_LEASE_MS } from "./functions"

/** Low-level CDP transport, used only by the CDP adapter. */
export interface PageChannel { send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> }
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
export interface PageSession { driver: PageDriver; checkpoint(): Promise<void>; markAutomation: boolean }
export class Handle { constructor(readonly objectId: string) {} }
export function gone(ref: string): Error { return new Error(`${ref} is no longer in the page; inspect again`) }

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
  const result = await session.driver.call(functionId, handle, args.map(value => value instanceof Handle ? { handle: value.objectId } : value))
  await session.checkpoint()
  if (result.exception !== undefined) throw pageError(ref, result.exception)
  if (!byValue) { if (typeof result.handle !== "string") throw gone(ref); return result.handle }
  return result.value
}
export async function releaseObjects(session: PageSession): Promise<void> { await session.driver.releaseHandles().catch(() => undefined) }

function pageError(ref: string, description: string): Error {
  const [code, detail = ""] = /codenomad:([a-z-]+)(?::(.*))?/.exec(description.split("\n", 1)[0])?.slice(1) ?? []
  const quoted = JSON.stringify(detail.slice(0, VALUE_LIMIT))
  switch (code) {
    case "gone": return gone(ref)
    case "not-select": return new Error(`${ref} is not a native select; click it to open its menu, then click the option`)
    case "is-select": return new Error(`${ref} is a native select; use select with its option labels`)
    case "no-option": return new Error(`No option ${quoted} in ${ref}; inspect it to see its options`)
    case "option-disabled": return new Error(`Option ${quoted} of ${ref} is disabled`)
    case "single": return new Error(`${ref} takes exactly one value`)
    case "disabled": return new Error(`${ref} is disabled`)
    case "readonly": return new Error(`${ref} is read-only`)
    case "not-editable": return new Error(`${ref} is not a text field`)
    case "not-text": return new Error(`${ref} is not a text field; use click`)
    case "unfocusable": return new Error(`${ref} cannot take focus (hidden, disabled or behind a dialog); reveal it, then inspect again`)
    case "invalid-value": return new Error(`${quoted} is not a valid value for ${ref}`)
    default: return new Error(`The page rejected the action on ${ref}: ${description.split("\n", 1)[0].slice(0, VALUE_LIMIT)}`)
  }
}

type InputKind = "pointer" | "wheel" | "keyboard" | "insert-text"
async function sendInput(session: PageSession, kind: InputKind, params: Record<string, unknown>): Promise<void> {
  switch (kind) {
    case "pointer": return session.driver.pointer(params as unknown as PointerInput)
    case "wheel": return session.driver.wheel(params as unknown as WheelInput)
    case "keyboard": return session.driver.keyboard(params as unknown as KeyboardInput)
    case "insert-text": return session.driver.insertText(params.text as string)
  }
}
/** Provenance marking belongs only to the trusted application window. */
export async function markedInput<T>(session: PageSession, run: (dispatch: (kind: InputKind, params: Record<string, unknown>) => Promise<void>) => Promise<T>): Promise<T> {
  const held = new Map<string, { kind: InputKind; params: Record<string, unknown> }>()
  let point = { x: 0, y: 0 }
  let attempted = false
  const dispatch = async (kind: InputKind, params: Record<string, unknown>) => {
    let timestamp: number | undefined
    if (session.markAutomation) {
      const stamp = (await session.driver.call("mark-input", undefined, [])).value
      if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0) throw new Error("Cannot establish automation input provenance")
      timestamp = stamp
    }
    const mouse = kind === "pointer" || kind === "wheel"
    if (mouse && typeof params.x === "number" && typeof params.y === "number") point = { x: params.x, y: params.y }
    const id = mouse ? `mouse:${params.button}` : `key:${params.code}`
    const down = mouse ? params.type === "mousePressed" : params.type === "keyDown" || params.type === "rawKeyDown"
    const up = mouse ? params.type === "mouseReleased" : params.type === "keyUp"
    if (down) held.set(id, { kind, params: { ...params, type: mouse ? "mouseReleased" : "keyUp", buttons: 0, modifiers: 0,
      ...(timestamp === undefined ? {} : { timestamp }) } })
    attempted = true
    await sendInput(session, kind, { ...params, ...(timestamp === undefined || kind === "insert-text" ? {} : { timestamp }) })
    if (up) held.delete(id)
    await session.checkpoint()
  }
  await awaitInputAcceptance(session)
  try { return await run(dispatch) }
  catch (error) {
    if (attempted && error instanceof Error && /timed out|timeout/i.test(error.message)) throw new Error("Input timed out: its outcome is unknown. The page was busy and the input may still be delivered; inspect before retrying.")
    throw error
  } finally {
    for (const release of [...held.values()].reverse()) {
      try {
        if (session.markAutomation) await session.driver.call("mark-input", undefined, []).catch(() => undefined)
        const { text: _text, unmodifiedText: _unmodified, ...params } = release.params
        await sendInput(session, release.kind, { ...params, ...(release.kind === "pointer" ? point : {}) })
      } catch { /* Exact original driver, best effort; never replay a press. */ }
    }
    if (session.markAutomation) await session.driver.call("unmark-input", undefined, []).catch(() => undefined)
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
