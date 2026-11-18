import { keyChord } from "./keys"
import { callOn, Handle, markedInput, resolveElement, PageDriverUnsupportedError, type PageSession } from "./protocol"

/** Trusted pointer, wheel and keyboard input through DevTools, aimed like a user would:
 * at the element's visible centre, only when that point actually reaches the element. */

export interface Point { x: number; y: number }

/** The point a user would click, or undefined for an element without a visible box. */
export async function aim(session: PageSession, ref: string, backendNodeId: number, options: { hitTest?: boolean; scroll?: boolean } = {}): Promise<Point | undefined> {
  if (options.scroll !== false) await session.driver.scrollIntoView(backendNodeId).catch(error => { if (error instanceof PageDriverUnsupportedError) throw error })
  await session.checkpoint()
  const quads = await session.driver.geometry(backendNodeId).catch(error => { if (error instanceof PageDriverUnsupportedError) throw error; return [] })
  await session.checkpoint()
  const viewport = await layoutViewport(session)
  const quad = quads.find(item => item.length === 8 && area(item) >= 1)
  if (!quad) return undefined
  // The visible part of the box, so a half-clipped element is aimed where it shows.
  const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]]
  const left = Math.max(0, Math.min(...xs)), right = Math.min(viewport.width, Math.max(...xs))
  const top = Math.max(0, Math.min(...ys)), bottom = Math.min(viewport.height, Math.max(...ys))
  if (right - left < 1 || bottom - top < 1) return undefined
  const point = { x: (left + right) / 2, y: (top + bottom) / 2 }
  if (options.hitTest !== false) await assertReceives(session, ref, backendNodeId, point)
  return point
}

/** Refuses a point that another element covers, instead of acting on whatever is on top. */
async function assertReceives(session: PageSession, ref: string, backendNodeId: number, point: Point): Promise<void> {
  // Like real events, hit testing passes through `pointer-events: none` layers (toasts, overlays' gaps).
  const hitNode = await session.driver.hitTest(Math.floor(point.x), Math.floor(point.y)).catch(error => { if (error instanceof PageDriverUnsupportedError) throw error; return undefined })
  await session.checkpoint()
  if (typeof hitNode !== "number" || hitNode === backendNodeId) return
  const target = await resolveElement(session, ref, backendNodeId)
  const other = await resolveElement(session, ref, hitNode).catch(() => undefined)
  if (!other) return
  const covered = await callOn(session, ref, target, "receives", [new Handle(other)])
  if (typeof covered === "string") throw new Error(`${ref} is covered by ${covered}; close or move it first, then inspect again`)
}

async function layoutViewport(session: PageSession): Promise<{ width: number; height: number }> {
  return session.driver.viewport().catch(error => { if (error instanceof PageDriverUnsupportedError) throw error; return { width: Infinity, height: Infinity } })
}

function area(quad: number[]): number {
  let sum = 0
  for (let index = 0; index < 4; index++) {
    const next = (index + 1) % 4
    sum += quad[index * 2] * quad[next * 2 + 1] - quad[next * 2] * quad[index * 2 + 1]
  }
  return Math.abs(sum) / 2
}

const BUTTONS = { left: 1, right: 2, middle: 4 } as const
export type MouseButton = keyof typeof BUTTONS

export async function clickAt(session: PageSession, point: Point, button: MouseButton = "left"): Promise<void> {
  await markedInput(session, async dispatch => {
    await dispatch("pointer", { type: "mouseMoved", ...point })
    await dispatch("pointer", { type: "mousePressed", ...point, button, buttons: BUTTONS[button], clickCount: 1 })
    await dispatch("pointer", { type: "mouseReleased", ...point, button, buttons: 0, clickCount: 1 })
  })
}

export async function hoverAt(session: PageSession, point: Point): Promise<void> {
  await markedInput(session, dispatch => dispatch("pointer", { type: "mouseMoved", ...point }))
}

export async function wheelAt(session: PageSession, point: Point | undefined, delta: { x: number; y: number }): Promise<void> {
  const at = point ?? await viewportCentre(session)
  await markedInput(session, async dispatch => {
    await dispatch("pointer", { type: "mouseMoved", ...at })
    await dispatch("wheel", { type: "mouseWheel", ...at, deltaX: delta.x, deltaY: delta.y })
  })
}

/** A pointer drag in small steps, so pointer-based drag libraries pass their activation distance. */
export async function dragBetween(session: PageSession, from: Point, to: Point): Promise<void> {
  await markedInput(session, async dispatch => {
    await dispatch("pointer", { type: "mouseMoved", ...from })
    await dispatch("pointer", { type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 })
    const steps = 10
    for (let step = 1; step <= steps; step++) {
      await dispatch("pointer", { type: "mouseMoved", x: from.x + (to.x - from.x) * step / steps,
        y: from.y + (to.y - from.y) * step / steps, button: "left", buttons: 1 })
    }
    await dispatch("pointer", { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 })
  })
}

export async function pressKeys(session: PageSession, chord: string): Promise<void> {
  const events = keyChord(chord)
  await markedInput(session, async dispatch => {
    for (const event of events) await dispatch("keyboard", event)
  })
}

async function viewportCentre(session: PageSession): Promise<Point> {
  const { width, height } = await layoutViewport(session)
  return { x: Number.isFinite(width) ? width / 2 : 400, y: Number.isFinite(height) ? height / 2 : 300 }
}

/** Polls the page for text, in its rendered text or in labels, titles, placeholders and values. */
export async function waitForText(session: PageSession, text: string, gone: boolean, timeoutMs: number): Promise<{ found: boolean; waitedMs: number }> {
  const started = Date.now()
  for (;;) {
    const root = await session.driver.call("document-root", undefined, [])
    await session.checkpoint()
    const objectId = root.handle
    const found = typeof objectId === "string" && await callOn(session, "the page", objectId, "contains", [text]) === true
    const waitedMs = Date.now() - started
    if (found !== gone) return { found, waitedMs }
    if (waitedMs >= timeoutMs) {
      throw new Error(gone ? `${JSON.stringify(text)} is still shown after ${timeoutMs} ms` : `${JSON.stringify(text)} did not appear within ${timeoutMs} ms`)
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(200, timeoutMs - waitedMs)))
  }
}
