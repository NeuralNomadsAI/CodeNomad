import { aim, clickAt, dragBetween, hoverAt, pressKeys, waitForText, wheelAt, type MouseButton } from "./input"
import { callOn, markedInput, releaseObjects, resolveElement, PageDriverUnsupportedError, type PageSession } from "./protocol"
import { snapshotTree } from "./semantic-tree"
import type { RefAction } from "./parse"
import { renderSnapshot, type AxNode, type Snapshot, type SnapshotOptions } from "./snapshot"
export type { PageChannel, PageSession } from "./protocol"

interface Target { ref: string; backendNodeId: number }
export type PageAction =
  | Target & { kind: "click"; button?: MouseButton }
  | Target & { kind: "type"; text: string; clear: boolean }
  | Target & { kind: "select"; values: string[] }
  | Target & { kind: "hover" }
  | Target & { kind: "drag"; to: Target }
  | { kind: "scroll"; target?: Target; direction: "up" | "down" | "left" | "right"; amount: number }
  | { kind: "press"; key: string; target?: Target }
  | { kind: "wait"; text: string; gone: boolean; timeoutMs: number }
export interface PageActionResult { value?: string; selected?: string[]; focused?: string; found?: boolean; waitedMs?: number }

export function bindRefs(action: RefAction, resolve: (ref: string) => number): PageAction {
  const target = (ref: string): Target => ({ ref, backendNodeId: resolve(ref) })
  switch (action.action) {
    case "click": return { kind: "click", ...target(action.ref), ...(action.button ? { button: action.button } : {}) }
    case "type": return { kind: "type", ...target(action.ref), text: action.text, clear: action.clear }
    case "select": return { kind: "select", ...target(action.ref), values: action.values }
    case "hover": return { kind: "hover", ...target(action.ref) }
    case "drag": return { kind: "drag", ...target(action.ref), to: target(action.to) }
    case "scroll": return { kind: "scroll", direction: action.direction, amount: action.amount, ...(action.ref ? { target: target(action.ref) } : {}) }
    case "press": return { kind: "press", key: action.key, ...(action.ref ? { target: target(action.ref) } : {}) }
    case "wait": return { kind: "wait", text: action.text, gone: action.gone, timeoutMs: action.timeout }
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
        return { selected: (await callOn(session, action.ref, element, "select", [action.values]) as unknown[]).map(String) }
      }
      case "hover": {
        const point = await aim(session, action.ref, action.backendNodeId)
        if (!point) throw new Error(`${action.ref} has no visible box to hover`)
        await hoverAt(session, point)
        return {}
      }
      case "drag": {
        const from = await aim(session, action.ref, action.backendNodeId, { scroll: false })
        const to = await aim(session, action.to.ref, action.to.backendNodeId, { scroll: false })
        if (!from || !to) throw new Error(`${!from ? action.ref : action.to.ref} has no visible box to drag ${!from ? "from" : "to"}`)
        await dragBetween(session, from, to)
        return {}
      }
      case "scroll": {
        const point = action.target ? await aim(session, action.target.ref, action.target.backendNodeId) : undefined
        if (action.target && !point) throw new Error(`${action.target.ref} has no visible box to scroll`)
        const sign = action.direction === "up" || action.direction === "left" ? -1 : 1
        const vertical = action.direction === "up" || action.direction === "down"
        await wheelAt(session, point, { x: vertical ? 0 : sign * action.amount, y: vertical ? sign * action.amount : 0 })
        return {}
      }
      case "press": {
        if (action.target) {
          const element = await resolveElement(session, action.target.ref, action.target.backendNodeId)
          await callOn(session, action.target.ref, element, "focus", [])
        }
        await pressKeys(session, action.key)
        return { focused: await focusedElement(session) }
      }
      case "wait": return await waitForText(session, action.text, action.gone, action.timeoutMs)
    }
  } finally { await releaseObjects(session) }
}
async function click(session: PageSession, action: Target & { button?: MouseButton }): Promise<PageActionResult> {
  const element = await resolveElement(session, action.ref, action.backendNodeId)
  const selected = await callOn(session, action.ref, element, "option-click", [])
  if (Array.isArray(selected)) return { selected: selected.map(String) }
  const point = await aim(session, action.ref, action.backendNodeId)
  if (!point) {
    if (action.button && action.button !== "left") throw new Error(`${action.ref} has no visible box to ${action.button}-click`)
    await callOn(session, action.ref, element, "programmatic-click", [])
  } else await clickAt(session, point, action.button)
  return {}
}
async function type(session: PageSession, action: Target & { text: string; clear: boolean }): Promise<PageActionResult> {
  const element = await resolveElement(session, action.ref, action.backendNodeId)
  await session.driver.scrollIntoView(action.backendNodeId).catch(error => { if (error instanceof PageDriverUnsupportedError) throw error })
  await session.checkpoint()
  const field = await callOn(session, action.ref, element, "field", [], false) as string
  const mode = await callOn(session, action.ref, field, "prepare", [action.clear])
  if (mode === "value" || mode === "append") await callOn(session, action.ref, field, "set-value", [action.text, mode === "append"])
  else if (action.text) await markedInput(session, dispatch => dispatch("insert-text", { text: action.text }))
  else if (action.clear) await callOn(session, action.ref, field, "delete-selection", [])
  return { value: String(await callOn(session, action.ref, field, "read-value", [])) }
}
async function focusedElement(session: PageSession): Promise<string | undefined> {
  const active = await session.driver.call("active-element", undefined, [])
  await session.checkpoint()
  if (typeof active.handle !== "string") return undefined
  const described = await callOn(session, "the focused element", active.handle, "describe", [])
  return typeof described === "string" ? described : undefined
}
