import { aim, clickAt, dragBetween, hoverAt, pressKeys, waitForText, wheelAt, type MouseButton } from "./input"
import { callOn, OBJECT_GROUP, releaseObjects, resolveElement, VALUE_LIMIT, type PageSession } from "./protocol"
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

export interface PageActionResult {
  /** The field's value after typing; passwords are masked. */
  value?: string
  /** The select's chosen option labels. */
  selected?: string[]
  /** The element focused after a key press. */
  focused?: string
  /** Whether wait found its text, and after how long. */
  found?: boolean
  waitedMs?: number
}

/** Resolves a tool's refs to DOM nodes before any page access; a stale ref fails the whole action. */
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
  const result = await session.channel.send("Accessibility.getFullAXTree")
  await session.checkpoint()
  return Array.isArray(result.nodes) ? result.nodes as AxNode[] : []
}

export async function snapshotPage(session: PageSession, issue: () => (backendNodeId: number) => string,
  options: SnapshotOptions = {}): Promise<Snapshot> {
  const nodes = await readAccessibilityTree(session)
  // Refs are issued only after the tree was confirmed current.
  return renderSnapshot(nodes, issue(), options)
}

export async function performAction(session: PageSession, action: PageAction): Promise<PageActionResult> {
  try {
    switch (action.kind) {
      case "click": return await click(session, action)
      case "type": return await type(session, action)
      case "select": {
        const element = await resolveElement(session, action.ref, action.backendNodeId)
        return { selected: (await callOn(session, action.ref, element, SELECT, [action.values]) as unknown[]).map(String) }
      }
      case "hover": {
        const point = await aim(session, action.ref, action.backendNodeId)
        if (!point) throw new Error(`${action.ref} has no visible box to hover`)
        await hoverAt(session, point)
        return {}
      }
      case "drag": {
        const from = await aim(session, action.ref, action.backendNodeId)
        // The drop target may lie under the dragged element; only its position matters.
        const to = await aim(session, action.to.ref, action.to.backendNodeId, { hitTest: false })
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
          await callOn(session, action.target.ref, element, FOCUS, [])
        }
        await pressKeys(session, action.key)
        return { focused: await focusedElement(session) }
      }
      case "wait": return await waitForText(session, action.text, action.gone, action.timeoutMs)
    }
  } finally {
    await releaseObjects(session)
  }
}

async function click(session: PageSession, action: Target & { button?: MouseButton }): Promise<PageActionResult> {
  const element = await resolveElement(session, action.ref, action.backendNodeId)
  const selected = await callOn(session, action.ref, element, OPTION_CLICK, [])
  if (Array.isArray(selected)) return { selected: selected.map(String) }
  const point = await aim(session, action.ref, action.backendNodeId)
  // An element without a visible box (zero-size or offscreen-only) is activated programmatically.
  if (!point) {
    if (action.button && action.button !== "left") throw new Error(`${action.ref} has no visible box to ${action.button}-click`)
    await callOn(session, action.ref, element, PROGRAMMATIC_CLICK, [])
  } else await clickAt(session, point, action.button)
  return {}
}

async function type(session: PageSession, action: Target & { text: string; clear: boolean }): Promise<PageActionResult> {
  const element = await resolveElement(session, action.ref, action.backendNodeId)
  await session.channel.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: action.backendNodeId }).catch(() => undefined)
  await session.checkpoint()
  const field = await callOn(session, action.ref, element, FIELD, [], false) as string
  const mode = await callOn(session, action.ref, field, PREPARE, [action.clear])
  if (mode === "value" || mode === "append") await callOn(session, action.ref, field, SET_VALUE, [action.text, mode === "append"])
  else if (action.text) {
    await session.channel.send("Input.insertText", { text: action.text })
    await session.checkpoint()
  } else if (action.clear) await callOn(session, action.ref, field, DELETE_SELECTION, [])
  return { value: String(await callOn(session, action.ref, field, READ_VALUE, [])) }
}

async function focusedElement(session: PageSession): Promise<string | undefined> {
  const active = await session.channel.send("Runtime.evaluate", { expression: "document.activeElement", objectGroup: OBJECT_GROUP })
  await session.checkpoint()
  const objectId = (active.result as { objectId?: unknown } | undefined)?.objectId
  if (typeof objectId !== "string") return undefined
  const described = await callOn(session, "the focused element", objectId, DESCRIBE, [])
  return typeof described === "string" ? described : undefined
}

const LABEL = `const label = option => (option.label || option.textContent || "").replace(/\\s+/g, " ").trim();`

/** Picks options like a user would: by visible label, else by value; change fires only on a change.
 * `:disabled` also covers disabled fieldsets and optgroups. */
const CHOOSE = `${LABEL}
  const apply = (select, picked) => {
    if (select.matches(":disabled")) throw new Error("codenomad:disabled");
    for (const option of picked) if (option.matches(":disabled")) throw new Error("codenomad:option-disabled:" + label(option));
    if (!select.multiple && picked.length !== 1) throw new Error("codenomad:single");
    select.focus();
    const options = Array.from(select.options);
    if (options.some(option => option.selected !== picked.includes(option))) {
      for (const option of options) option.selected = picked.includes(option);
      select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return Array.from(select.selectedOptions).map(label);
  };
  const choose = (select, wanted) => {
    if (select.matches(":disabled")) throw new Error("codenomad:disabled");
    const options = Array.from(select.options), picked = [];
    for (const raw of wanted) {
      const target = String(raw).replace(/\\s+/g, " ").trim();
      const option = options.find(item => label(item) === target) || options.find(item => item.value === String(raw));
      if (!option) throw new Error("codenomad:no-option:" + target);
      if (!picked.includes(option)) picked.push(option);
    }
    return apply(select, picked);
  };`

/** A native select's popup is not part of the page: clicking an option picks that exact option,
 * and the select itself is changed with `select` rather than opened. */
const OPTION_CLICK = `${CHOOSE}
  const option = element.closest("option"), select = option && option.closest("select");
  if (option && select) return apply(select, [option]);
  if (element instanceof HTMLSelectElement) throw new Error("codenomad:is-select");
  return null;`

const PROGRAMMATIC_CLICK = `if (element instanceof HTMLElement) element.click();
  else element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
  return null;`

const SELECT = `${CHOOSE}
  const control = element instanceof HTMLLabelElement ? element.control : element;
  const select = control instanceof HTMLSelectElement ? control : control && control.closest("select");
  if (!select) throw new Error("codenomad:not-select");
  return choose(select, args[0]);`

const FOCUS = `if (element instanceof HTMLElement || element instanceof SVGElement) element.focus(); return null;`

const DESCRIBE = `const role = element.getAttribute("role") || element.tagName.toLowerCase();
  const name = (element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder")
    || (element.labels && element.labels[0] && element.labels[0].textContent) || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  return role + (name ? " " + JSON.stringify(name) : "");`

const NOT_TEXT = ["checkbox", "radio", "button", "submit", "reset", "file", "image", "hidden"]
const VALUE_TYPES = ["date", "time", "datetime-local", "month", "week", "range", "color"]
/** Types whose value sanitization empties an invalid value. */
const PROBED_TYPES = ["date", "time", "datetime-local", "month", "week", "number"]
const TEXT_FIELD = `const textField = item => item instanceof HTMLInputElement || item instanceof HTMLTextAreaElement
  || (item instanceof HTMLElement && item.isContentEditable);`

/** The field a ref designates: itself, its labelled control, or its first editable descendant. */
const FIELD = `${TEXT_FIELD}
  const control = element instanceof HTMLLabelElement ? element.control : element;
  const field = control && textField(control) ? control
    : element.querySelector('input:not([type="hidden"]), textarea, [contenteditable]:not([contenteditable="false"])');
  if (!field || !textField(field)) throw new Error("codenomad:not-editable");
  return field;`

/** Native text insertion goes to the focused element, so a field that cannot take focus
 * (hidden, disabled, behind a modal dialog) fails here instead of typing into another one. */
const PREPARE = `const field = element, clear = args[0];
  if (field.matches(":disabled")) throw new Error("codenomad:disabled");
  if (field.readOnly) throw new Error("codenomad:readonly");
  if (field instanceof HTMLInputElement && ${JSON.stringify(NOT_TEXT)}.includes(field.type)) throw new Error("codenomad:not-text");
  field.focus();
  const active = field.getRootNode().activeElement;
  const editable = !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement);
  if (active !== field && !(editable && active instanceof HTMLElement && active.isContentEditable && active.contains(field))) {
    throw new Error("codenomad:unfocusable");
  }
  if (field instanceof HTMLInputElement && ${JSON.stringify(VALUE_TYPES)}.includes(field.type)) return "value";
  if (editable) {
    const range = document.createRange();
    range.selectNodeContents(field);
    if (!clear) range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } else if (clear) field.select();
  // Email and number inputs have no caret API: their text is appended as a value.
  else { try { field.setSelectionRange(field.value.length, field.value.length); } catch { return "append"; } }
  return "insert";`

/** Sets an input's value like a picker would. An invalid value is refused before anything changes;
 * a valid one keeps the browser's normalization (lowercase colors, snapped ranges). */
const SET_VALUE = `const [text, append] = args, next = append ? element.value + text : text;
  // Ranges and colors have no empty value: the browser would substitute its default.
  const valid = element.type === "color" ? /^#[0-9a-f]{6}$/i.test(next)
    : element.type === "range" ? /^-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?$/.test(next)
    : next !== "" && ${JSON.stringify(PROBED_TYPES)}.includes(element.type) ? (() => { const probe = document.createElement("input"); probe.type = element.type; probe.value = next; return probe.value !== ""; })()
    : true;
  if (!valid) throw new Error("codenomad:invalid-value:" + next);
  if (next === element.value) return null;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, next);
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return null;`

const DELETE_SELECTION = `document.execCommand("delete"); return null;`

const READ_VALUE = `const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.innerText || element.textContent || "";
  if (element instanceof HTMLInputElement && element.type === "password") return "•".repeat(Math.min(value.length, 16));
  return value.length > ${VALUE_LIMIT} ? value.slice(0, ${VALUE_LIMIT - 1}) + "…" : value;`
