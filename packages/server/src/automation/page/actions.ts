import { aim, clickAt, dragBetween, hoverAt, pressKeys, waitForText, wheelAt, type MouseButton } from "./input"
import { callOn, markedInput, releaseObjects, resolveElement, PageDriverUnsupportedError, type InputTarget, type PageSession } from "./protocol"
import { snapshotTree } from "./semantic-tree"
import type { RefAction } from "./parse"
import { renderSnapshot, type AxNode, type Snapshot, type SnapshotOptions } from "./snapshot"
export type { PageChannel, PageSession } from "./protocol"

interface Target { ref: string; backendNodeId: number }
export type PageAction =
  | Target & { kind: "click"; button?: MouseButton; noFilePicker?: true }
  | Target & { kind: "type"; text: string; clear: boolean }
  | Target & { kind: "select"; values: string[]; byValue?: true }
  | Target & { kind: "hover" }
  | Target & { kind: "drag"; to: Target }
  | { kind: "scroll"; target?: Target; delta: { x: number; y: number } }
  | { kind: "press"; key: string; target?: Target }
  | { kind: "wait"; text: string; gone: boolean; timeoutMs: number; literal?: true }
  | Target & { kind: "checked" }
export interface PageActionResult { value?: string; selected?: string[]; focused?: string; found?: boolean; waitedMs?: number; checked?: boolean | null }

export function bindRefs(action: RefAction, resolve: (ref: string) => number): PageAction {
  const target = (ref: string): Target => ({ ref, backendNodeId: resolve(ref) })
  switch (action.action) {
    case "click": return { kind: "click", ...target(action.ref), ...(action.button ? { button: action.button } : {}), ...(action.noFilePicker ? { noFilePicker: true as const } : {}) }
    case "type": return { kind: "type", ...target(action.ref), text: action.text, clear: action.clear }
    case "select": return { kind: "select", ...target(action.ref), values: action.values, ...(action.byValue ? { byValue: true as const } : {}) }
    case "hover": return { kind: "hover", ...target(action.ref) }
    case "drag": return { kind: "drag", ...target(action.ref), to: target(action.to) }
    case "scroll": {
      const sign = "delta" in action ? 0 : action.direction === "up" || action.direction === "left" ? -1 : 1
      const delta = "delta" in action ? action.delta : action.direction === "up" || action.direction === "down"
        ? { x: 0, y: sign * action.amount } : { x: sign * action.amount, y: 0 }
      return { kind: "scroll", delta, ...(action.ref ? { target: target(action.ref) } : {}) }
    }
    case "press": return { kind: "press", key: action.key, ...(action.ref ? { target: target(action.ref) } : {}) }
    case "wait": return { kind: "wait", text: action.text, gone: action.gone, timeoutMs: action.timeout, ...(action.literal ? { literal: true as const } : {}) }
    case "checked": return { kind: "checked", ...target(action.ref) }
  }
}
export async function readAccessibilityTree(session: PageSession): Promise<AxNode[]> {
  const nodes = await session.driver.tree()
  await session.checkpoint()
  return snapshotTree(nodes)
}
export async function snapshotPage(session: PageSession, issue: () => (backendNodeId: number) => string, options: SnapshotOptions = {}): Promise<Snapshot> {
  const nodes = await readAccessibilityTree(session)
  return renderSnapshot(nodes, issue(), options)
}
export async function performAction(session: PageSession, action: PageAction): Promise<PageActionResult> {
  try {
    switch (action.kind) {
      case "click": return await click(session, action)
      case "type": return await type(session, action)
      case "select": {
        const element = await resolveElement(session, action.ref, action.backendNodeId)
        return { selected: (await callOn(session, action.ref, element, action.byValue ? "select-values" : "select", [action.values]) as unknown[]).map(String) }
      }
      case "hover": {
        const point = await aim(session, action.ref, action.backendNodeId)
        if (!point) throw new Error(`${action.ref} has no visible box to hover`)
        await hoverAt(session, point, await pointerTarget(session, action))
        return {}
      }
      case "drag": {
        const from = await aim(session, action.ref, action.backendNodeId, { scroll: false })
        const to = await aim(session, action.to.ref, action.to.backendNodeId, { scroll: false })
        if (!from || !to) throw new Error(`${!from ? action.ref : action.to.ref} has no visible box to drag ${!from ? "from" : "to"}`)
        await dragBetween(session, from, to, await pointerTarget(session, action), await pointerTarget(session, action.to))
        return {}
      }
      case "scroll": {
        const point = action.target ? await aim(session, action.target.ref, action.target.backendNodeId, { wheel: true }) : undefined
        if (action.target && !point) throw new Error(`${action.target.ref} has no visible box to scroll`)
        await wheelAt(session, point ?? undefined, action.delta, action.target && await pointerTarget(session, action.target))
        return {}
      }
      case "press": {
        let target: InputTarget | undefined
        if (action.target) {
          const element = await resolveElement(session, action.target.ref, action.target.backendNodeId)
          await callOn(session, action.target.ref, element, "focus", [])
          target = { ref: action.target.ref, handle: element }
        }
        await pressKeys(session, action.key, target)
        try { return { focused: await focusedElement(session) } }
        catch (error) { throw new Error("Key input was sent, but the current focus could not be read; inspect before retrying.", { cause: error }) }
      }
      case "wait": return await waitForText(session, action.text, action.gone, action.timeoutMs, action.literal)
      case "checked": {
        const element = await resolveElement(session, action.ref, action.backendNodeId)
        const checked = await callOn(session, action.ref, element, "checked-state", [])
        return { checked: typeof checked === "boolean" ? checked : null }
      }
    }
  } finally { await releaseObjects(session) }
}
async function pointerTarget(session: PageSession, { ref, backendNodeId }: Target): Promise<InputTarget | undefined> {
  if (session.guardInput) return { ref, handle: await resolveElement(session, ref, backendNodeId) }
}
async function click(session: PageSession, action: Target & { button?: MouseButton; noFilePicker?: true }): Promise<PageActionResult> {
  const element = await resolveElement(session, action.ref, action.backendNodeId)
  if (action.noFilePicker && await callOn(session, action.ref, element, "file-input", []) === true)
    throw new Error(`${action.ref} opens a native file picker, which agent actions cannot use`)
  const selected = await callOn(session, action.ref, element, "option-click", [])
  if (Array.isArray(selected)) return { selected: selected.map(String) }
  const point = await aim(session, action.ref, action.backendNodeId)
  if (point === null) {
    if (action.button && action.button !== "left") throw new Error(`${action.ref} has no visible box to ${action.button}-click`)
    await callOn(session, action.ref, element, "programmatic-click", [])
  } else if (point) await clickAt(session, point, action.button, { ref: action.ref, handle: element })
  else throw new Error(`${action.ref} has no visible box to click`)
  return {}
}
async function type(session: PageSession, action: Target & { text: string; clear: boolean }): Promise<PageActionResult> {
  const element = await resolveElement(session, action.ref, action.backendNodeId)
  await session.driver.scrollIntoView(action.backendNodeId).catch(error => { if (error instanceof PageDriverUnsupportedError) throw error })
  await session.checkpoint()
  const field = await callOn(session, action.ref, element, "field", [], false) as string
  const mode = await callOn(session, action.ref, field, "prepare", [action.clear])
  if (mode === "value" || mode === "append") await callOn(session, action.ref, field, "set-value", [action.text, mode === "append"])
  else if (action.text) await markedInput(session, dispatch => dispatch("insert-text", { text: action.text },
    { ref: action.ref, handle: field }))
  else if (action.clear) await callOn(session, action.ref, field, "delete-selection", [])
  try {
    const value = await callOn(session, action.ref, field, "read-value", [])
    if (typeof value !== "string") throw new Error("Invalid field value")
    return { value }
  }
  catch (error) {
    if (!action.text && !action.clear && mode !== "value" && mode !== "append") throw error
    throw new Error("Text input was sent, but the field value could not be read; inspect before retrying.", { cause: error })
  }
}
async function focusedElement(session: PageSession): Promise<string> {
  const active = await session.driver.call("active-element", undefined, [])
  await session.checkpoint()
  if (active.exception !== undefined || typeof active.handle !== "string")
    throw new Error(active.exception ?? "Missing focused element")
  const described = await callOn(session, "the focused element", active.handle, "describe", [])
  if (typeof described !== "string") throw new Error("Invalid focus description")
  return described
}
