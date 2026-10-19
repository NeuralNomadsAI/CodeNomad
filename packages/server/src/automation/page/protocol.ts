/** Protocol primitives shared by the page engine's actions. */

/** One page's protocol connection, whatever carries it (DevTools socket or a native pipe). */
export interface PageChannel {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
}

export interface PageSession {
  channel: PageChannel
  /** Throws once the page changed since the operation began; runs between protocol steps. */
  checkpoint(): Promise<void>
  /** The trusted CodeNomad window: page-side automation and trusted input are marked so they
   * never count as a human answer (`form-answer-interaction.ts`). Never set this in a user's web page. */
  markAutomation: boolean
}

/** An element handle passed to a page function, as opposed to a plain value. */
export class Handle {
  constructor(readonly objectId: string) {}
}

export const OBJECT_GROUP = "codenomad-automation"
export const VALUE_LIMIT = 200

export function gone(ref: string): Error {
  return new Error(`${ref} is no longer in the page; inspect again`)
}

export async function resolveElement(session: PageSession, ref: string, backendNodeId: number): Promise<string> {
  let result: Record<string, unknown>
  try {
    result = await session.channel.send("DOM.resolveNode", { backendNodeId, objectGroup: OBJECT_GROUP })
  } catch {
    throw gone(ref)
  }
  await session.checkpoint()
  const objectId = (result.object as { objectId?: unknown } | undefined)?.objectId
  if (typeof objectId !== "string") throw gone(ref)
  return objectId
}

/** Runs a fixed page function on an element; inputs travel as protocol arguments, never as source.
 * `byValue: false` returns another element handle. */
export async function callOn(session: PageSession, ref: string, objectId: string, body: string, args: unknown[], byValue = true): Promise<unknown> {
  const result = await session.channel.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: pageFunction(body, session.markAutomation),
    arguments: args.map(value => value instanceof Handle ? { objectId: value.objectId } : { value }),
    returnByValue: byValue,
    objectGroup: OBJECT_GROUP,
  })
  await session.checkpoint()
  const failure = result.exceptionDetails as { exception?: { description?: unknown }; text?: unknown } | undefined
  if (failure) throw pageError(ref, String(failure.exception?.description ?? failure.text ?? ""))
  const value = result.result as { value?: unknown; objectId?: unknown } | undefined
  if (!byValue) {
    if (typeof value?.objectId !== "string") throw gone(ref)
    return value.objectId
  }
  return value?.value
}

export async function releaseObjects(session: PageSession): Promise<void> {
  await session.channel.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => undefined)
}

function pageFunction(body: string, mark: boolean): string {
  const element = `const element = this.nodeType === Node.ELEMENT_NODE ? this : this.parentElement;
    if (!(element instanceof Element) || !element.isConnected) throw new Error("codenomad:gone");`
  return mark
    ? `function (...args) { ${element} globalThis.__codenomadAutomationDepth = (globalThis.__codenomadAutomationDepth || 0) + 1;
      try { return (() => { ${body} })(); } finally { globalThis.__codenomadAutomationDepth--; } }`
    : `function (...args) { ${element} ${body} }`
}

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

/** Marks trusted input (DevTools mouse/keyboard events) in the CodeNomad window. A lease, not a
 * counter: if the clearing call is lost with the connection, the mark still expires. */
export async function markedInput<T>(session: PageSession, run: (dispatch: (method: string, params: Record<string, unknown>) => Promise<void>) => Promise<T>): Promise<T> {
  const held = new Map<string, { method: string; params: Record<string, unknown> }>()
  let point = { x: 0, y: 0 }
  const dispatch = async (method: string, params: Record<string, unknown>) => {
    if (session.markAutomation) await session.channel.send("Runtime.evaluate", { expression: MARK_INPUT, returnByValue: true })
    const mouse = method === "Input.dispatchMouseEvent"
    if (mouse && typeof params.x === "number" && typeof params.y === "number") point = { x: params.x, y: params.y }
    const id = mouse ? `mouse:${params.button}` : `key:${params.code}`
    const down = mouse ? params.type === "mousePressed" : params.type === "keyDown" || params.type === "rawKeyDown"
    const up = mouse ? params.type === "mouseReleased" : params.type === "keyUp"
    if (down) held.set(id, { method, params: { ...params, type: mouse ? "mouseReleased" : "keyUp", buttons: 0, modifiers: 0 } })
    await session.channel.send(method, params)
    if (up) held.delete(id)
    await session.checkpoint()
  }
  try {
    return await run(dispatch)
  } finally {
    // Failure may be after admission but before acknowledgement/checkpoint. Release
    // anything potentially held, without a failed checkpoint suppressing cleanup.
    for (const release of [...held.values()].reverse()) {
      try {
        if (session.markAutomation) await session.channel.send("Runtime.evaluate", { expression: MARK_INPUT, returnByValue: true })
        const { text: _text, unmodifiedText: _unmodified, ...params } = release.params
        await session.channel.send(release.method, { ...params, ...(release.method === "Input.dispatchMouseEvent" ? point : {}) })
      } catch { /* Best effort, exact original channel only; never retry the action. */ }
    }
    if (session.markAutomation) await session.channel.send("Runtime.evaluate", { expression: UNMARK_INPUT, returnByValue: true }).catch(() => undefined)
  }
}

export const INPUT_MARK_LEASE_MS = 15_000
const MARK_INPUT = `globalThis.__codenomadAutomationInputUntil = performance.now() + ${INPUT_MARK_LEASE_MS}; true`
// Keep the interval's end for events queued before a stalled renderer recovered.
const UNMARK_INPUT = "globalThis.__codenomadAutomationInputUntil = Math.min(globalThis.__codenomadAutomationInputUntil || 0, performance.now()); true"
