import { renderSnapshot, type AxNode, type Snapshot, type SnapshotOptions } from "./snapshot"

/** One page's protocol connection, whatever carries it (DevTools socket or a native pipe). */
export interface PageChannel {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
}

export interface PageSession {
  channel: PageChannel
  /** Throws once the page changed since the operation began; runs between protocol steps. */
  checkpoint(): Promise<void>
  /** The trusted CodeNomad window: page-side automation is marked so it never counts as a
   * human answer (`form-answer-interaction.ts`). Never set this in a user's web page. */
  markAutomation: boolean
}

export type PageAction =
  | { kind: "click"; ref: string; backendNodeId: number }
  | { kind: "type"; ref: string; backendNodeId: number; text: string; clear: boolean }
  | { kind: "select"; ref: string; backendNodeId: number; values: string[] }

export interface PageActionResult {
  /** The field's value after typing; passwords are masked. */
  value?: string
  /** The select's chosen option labels. */
  selected?: string[]
}

const OBJECT_GROUP = "codenomad-automation"
const VALUE_LIMIT = 200

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
  const { channel } = session
  try {
    await channel.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: action.backendNodeId }).catch(() => undefined)
    await session.checkpoint()
    const element = await resolve(session, action)
    if (action.kind === "click") {
      const selected = await call(session, action, element, CLICK, [])
      return Array.isArray(selected) ? { selected: selected.map(String) } : {}
    }
    if (action.kind === "select") {
      return { selected: (await call(session, action, element, SELECT, [action.values]) as unknown[]).map(String) }
    }
    const field = await call(session, action, element, FIELD, [], false) as string
    const mode = await call(session, action, field, PREPARE, [action.clear])
    if (mode === "value" || mode === "append") await call(session, action, field, SET_VALUE, [action.text, mode === "append"])
    else if (action.text) {
      await channel.send("Input.insertText", { text: action.text })
      await session.checkpoint()
    } else if (action.clear) await call(session, action, field, DELETE_SELECTION, [])
    return { value: String(await call(session, action, field, READ_VALUE, [])) }
  } finally {
    await channel.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => undefined)
  }
}

async function resolve(session: PageSession, action: PageAction): Promise<string> {
  let result: Record<string, unknown>
  try {
    result = await session.channel.send("DOM.resolveNode", { backendNodeId: action.backendNodeId, objectGroup: OBJECT_GROUP })
  } catch {
    throw new Error(`${action.ref} is no longer in the page; inspect again`)
  }
  await session.checkpoint()
  const objectId = (result.object as { objectId?: unknown } | undefined)?.objectId
  if (typeof objectId !== "string") throw new Error(`${action.ref} is no longer in the page; inspect again`)
  return objectId
}

/** Runs a fixed page function on an element; `byValue: false` returns another element handle. */
async function call(session: PageSession, action: PageAction, objectId: string, body: string, args: unknown[], byValue = true): Promise<unknown> {
  const result = await session.channel.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: pageFunction(body, session.markAutomation),
    arguments: args.map(value => ({ value })),
    returnByValue: byValue,
    objectGroup: OBJECT_GROUP,
  })
  await session.checkpoint()
  const failure = result.exceptionDetails as { exception?: { description?: unknown }; text?: unknown } | undefined
  if (failure) throw pageError(action, String(failure.exception?.description ?? failure.text ?? ""))
  const value = result.result as { value?: unknown; objectId?: unknown } | undefined
  if (!byValue) {
    if (typeof value?.objectId !== "string") throw new Error(`${action.ref} is no longer in the page; inspect again`)
    return value.objectId
  }
  return value?.value
}

function pageFunction(body: string, mark: boolean): string {
  const element = `const element = this.nodeType === Node.ELEMENT_NODE ? this : this.parentElement;
    if (!(element instanceof Element) || !element.isConnected) throw new Error("codenomad:gone");`
  return mark
    ? `function (...args) { ${element} globalThis.__codenomadAutomationDepth = (globalThis.__codenomadAutomationDepth || 0) + 1;
      try { return (() => { ${body} })(); } finally { globalThis.__codenomadAutomationDepth--; } }`
    : `function (...args) { ${element} ${body} }`
}

function pageError(action: PageAction, description: string): Error {
  const [code, detail = ""] = /codenomad:([a-z-]+)(?::(.*))?/.exec(description.split("\n", 1)[0])?.slice(1) ?? []
  const quoted = JSON.stringify(detail.slice(0, VALUE_LIMIT))
  switch (code) {
    case "gone": return new Error(`${action.ref} is no longer in the page; inspect again`)
    case "not-select": return new Error(`${action.ref} is not a native select; click it to open its menu, then click the option`)
    case "no-option": return new Error(`No option ${quoted} in ${action.ref}; inspect it to see its options`)
    case "option-disabled": return new Error(`Option ${quoted} of ${action.ref} is disabled`)
    case "single": return new Error(`${action.ref} takes exactly one value`)
    case "disabled": return new Error(`${action.ref} is disabled`)
    case "readonly": return new Error(`${action.ref} is read-only`)
    case "not-editable": return new Error(`${action.ref} is not a text field`)
    case "not-text": return new Error(`${action.ref} is not a text field; use click`)
    case "unfocusable": return new Error(`${action.ref} cannot take focus (hidden, disabled or behind a dialog); reveal it, then inspect again`)
    case "invalid-value": return new Error(`${quoted} is not a valid value for ${action.ref}`)
    default: return new Error(`The page rejected the action on ${action.ref}: ${description.split("\n", 1)[0].slice(0, VALUE_LIMIT)}`)
  }
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

/** Clicking an option of a native select picks that exact option, since its popup is not part of the page. */
const CLICK = `${CHOOSE}
  const option = element.closest("option"), select = option && option.closest("select");
  if (option && select) return apply(select, [option]);
  if (element instanceof HTMLElement) element.click();
  else element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
  return null;`

const SELECT = `${CHOOSE}
  const control = element instanceof HTMLLabelElement ? element.control : element;
  const select = control instanceof HTMLSelectElement ? control : control && control.closest("select");
  if (!select) throw new Error("codenomad:not-select");
  return choose(select, args[0]);`

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
