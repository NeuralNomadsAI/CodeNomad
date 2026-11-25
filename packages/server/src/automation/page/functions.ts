/** Fixed page programs. Arguments are values/handles, never interpolated source. */
export const VALUE_LIMIT = 200
export const INPUT_MARK_LEASE_MS = 15_000
const LABEL = `const label = option => (option.label || option.textContent || "").replace(/\\s+/g, " ").trim();`
const CHOOSE = `${LABEL}
  const apply = (select, picked, options, guard) => {
    const validate = () => {
      if (select.matches(":disabled")) throw new Error("codenomad:disabled");
      for (const option of picked) if (option.matches(":disabled")) throw new Error("codenomad:option-disabled:" + label(option));
      if (!select.multiple && picked.length !== 1) throw new Error("codenomad:single");
    };
    validate();
    select.focus();
    guard?.();
    const current = select.options;
    if (!select.isConnected || current.length !== options.length || options.some((option, index) => current[index] !== option))
      throw new Error("codenomad:options-changed");
    validate();
    if (options.some(option => option.selected !== picked.includes(option))) {
      for (const option of options) option.selected = picked.includes(option);
      select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return Array.from(select.selectedOptions).map(label);
  };
  const choose = (select, wanted, guard) => {
    if (select.matches(":disabled")) throw new Error("codenomad:disabled");
    const options = Array.from(select.options), picked = [];
    for (const raw of wanted) {
      const target = String(raw).replace(/\\s+/g, " ").trim();
      const option = options.find(item => label(item) === target) || options.find(item => item.value === String(raw));
      if (!option) throw new Error("codenomad:no-option:" + target);
      if (!picked.includes(option)) picked.push(option);
    }
    return apply(select, picked, options, guard);
  };`
const NOT_TEXT = ["checkbox", "radio", "button", "submit", "reset", "file", "image", "hidden"]
const VALUE_TYPES = ["date", "time", "datetime-local", "month", "week", "range", "color"]
const PROBED_TYPES = ["date", "time", "datetime-local", "month", "week", "number"]
const TEXT_FIELD = `const textField = item => item instanceof HTMLInputElement || item instanceof HTMLTextAreaElement
  || (item instanceof HTMLElement && item.isContentEditable);`

const HIT_ANCESTRY = `const hit = args[0] && (args[0].nodeType === Node.ELEMENT_NODE ? args[0] : args[0].parentElement);
   if (!hit) return null;
   const parent = node => {
     if (node.nodeType === 9) { try { return node.defaultView && node.defaultView.frameElement; } catch { return null; } }
     return node.assignedSlot || node.parentNode || (node.nodeType === 11 ? node.host : null);
   };`
const DESCRIBE_BLOCKER = `const name = (blocker.getAttribute("aria-label") || blocker.getAttribute("title") || blocker.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 60);
   return blocker.tagName.toLowerCase() + (name ? " " + JSON.stringify(name) : "");`
export const POINTER_COVER = `${HIT_ANCESTRY}
    const nativeInteractive = 'a[href], audio[controls], button, details, embed, iframe, img[usemap], input:not([type="hidden"]), select, textarea, video[controls]';
    const interactive = nativeInteractive + ', [tabindex], [contenteditable]:not([contenteditable="false"]), [role~="button"], [role~="link"], [role~="checkbox"], [role~="radio"], [role~="switch"], [role~="tab"], [role~="menuitem"]';
    const label = hit.closest("label");
    const foreignLabel = label?.control && label !== element && label.control !== element && !label.contains(hit.closest(nativeInteractive));
    for (let node = hit; !foreignLabel && node; node = parent(node)) {
      if (node === element) return null;
      if (node.nodeType !== 1) continue;
      if (node.localName === "label" && node.control) {
        if (node.control === element) return null;
        break;
      }
      if (node.matches(interactive)) break;
   }
   const blocker = foreignLabel ? label : hit;
   ${DESCRIBE_BLOCKER}`
export const WHEEL_COVER = `${HIT_ANCESTRY}
   for (let node = hit; node; node = parent(node)) {
     if (node === element) return null;
     if (node.nodeType === 1 && /^(iframe|frame|fencedframe|object|embed|portal|webview)$/.test(node.localName)) break;
   }
   const blocker = hit;
   ${DESCRIBE_BLOCKER}`
export const FOCUS_MISMATCH = `active !== field && !(editable && active instanceof HTMLElement && active.isContentEditable && active.contains(field))`

export const ELEMENT_FUNCTIONS = {
  "option-click": `${CHOOSE}
  const option = element.closest("option"), select = option && option.closest("select");
  if (option && select) return apply(select, [option], Array.from(select.options), args[0]);
  if (element instanceof HTMLSelectElement) throw new Error("codenomad:is-select");
  return null;`,
  "programmatic-click": `if (element.getClientRects().length) throw new Error("codenomad:has-box");
   if (element instanceof HTMLElement) element.click();
  else element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
  return null;`,
  select: `${CHOOSE}
  const control = element instanceof HTMLLabelElement ? element.control : element;
  const select = control instanceof HTMLSelectElement ? control : control && control.closest("select");
  if (!select) throw new Error("codenomad:not-select");
  return choose(select, args[0], args[1]);`,
  "select-values": `${CHOOSE}
  const control = element instanceof HTMLLabelElement ? element.control : element;
  const select = control instanceof HTMLSelectElement ? control : control && control.closest("select");
  if (!select) throw new Error("codenomad:not-select");
  if (select.matches(":disabled")) throw new Error("codenomad:disabled");
  const options = Array.from(select.options), picked = [];
  for (const raw of args[0]) {
    const option = options.find(item => item.value === String(raw));
    if (!option) throw new Error("codenomad:no-option:" + String(raw));
    if (!picked.includes(option)) picked.push(option);
  }
  return apply(select, picked, options);`,
  "file-input": `const label = element instanceof HTMLLabelElement ? element : element.closest && element.closest("label");
  const control = element instanceof HTMLInputElement ? element : label && label.control;
  return control instanceof HTMLInputElement && control.type === "file";`,
  focus: `if (element.matches(":disabled")) throw new Error("codenomad:disabled");
  if (element instanceof HTMLElement || element instanceof SVGElement) element.focus();
  if (element.getRootNode().activeElement !== element) throw new Error("codenomad:unfocusable");
  return null;`,
  describe: `const role = element.getAttribute("role") || element.tagName.toLowerCase();
  const name = (element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder")
    || (element.labels && element.labels[0] && element.labels[0].textContent) || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  return role + (name ? " " + JSON.stringify(name) : "");`,
  field: `${TEXT_FIELD}
  const control = element instanceof HTMLLabelElement ? element.control : element;
  const field = control && textField(control) ? control
    : element.querySelector('input:not([type="hidden"]), textarea, [contenteditable]:not([contenteditable="false"])');
  if (!field || !textField(field)) throw new Error("codenomad:not-editable");
  return field;`,
  prepare: `const field = element, clear = args[0];
  if (field.matches(":disabled")) throw new Error("codenomad:disabled");
  if (field.readOnly) throw new Error("codenomad:readonly");
  if (field instanceof HTMLInputElement && ${JSON.stringify(NOT_TEXT)}.includes(field.type)) throw new Error("codenomad:not-text");
  field.focus();
  const active = field.getRootNode().activeElement;
  const editable = !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement);
  if (${FOCUS_MISMATCH}) {
    throw new Error("codenomad:unfocusable");
  }
  if (field instanceof HTMLInputElement && ${JSON.stringify(VALUE_TYPES)}.includes(field.type)) return "value";
  if (editable) {
    const selection = getSelection();
    selection.setBaseAndExtent(field, clear ? 0 : field.childNodes.length, field, field.childNodes.length);
  } else if (clear) field.select();
  // Email and number inputs have no caret API: their text is appended as a value.
  else { try { field.setSelectionRange(field.value.length, field.value.length); } catch { return "append"; } }
  return "insert";`,
  "set-value": `if (element.matches(":disabled")) throw new Error("codenomad:disabled");
  if (element.readOnly) throw new Error("codenomad:readonly");
  if (element.getRootNode().activeElement !== element) throw new Error("codenomad:unfocusable");
  const [text, append] = args, next = append ? element.value + text : text;
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
  return null;`,
  "delete-selection": `const field = element, active = field.getRootNode().activeElement;
   const editable = !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement);
   if (field.matches(":disabled")) throw new Error("codenomad:disabled");
   if (field.readOnly) throw new Error("codenomad:readonly");
   if (${FOCUS_MISMATCH}) throw new Error("codenomad:unfocusable");
   args[0]?.();
   if (!document.execCommand("delete")) throw new Error("codenomad:delete-refused");
   return null;`,
  "read-value": `const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.innerText || element.textContent || "";
  if (element instanceof HTMLInputElement && element.type === "password") return "•".repeat(Math.min(value.length, 16));
  return value.length > ${VALUE_LIMIT} ? value.slice(0, ${VALUE_LIMIT - 1}) + "…" : value;`,
    receives: POINTER_COVER,
  "receives-wheel": WHEEL_COVER,
  contains: `const needle = String(args[0]).replace(/\\s+/g, " ").trim().toLowerCase();
  const root = element;
  const text = value => String(value || "").replace(/\\s+/g, " ").toLowerCase();
  if (text(root.innerText || root.textContent).includes(needle)) return true;
  for (const item of root.querySelectorAll("[aria-label], [title], [placeholder], input, textarea")) {
    if ([item.getAttribute("aria-label"), item.getAttribute("title"), item.getAttribute("placeholder"), item.value].some(value => text(value).includes(needle))) return true;
  }
  return false;`,
  "checked-state": `return element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio") ? element.checked : null;`,
  "body-text-includes": `const body = element.ownerDocument.body;
  return !!body && body.innerText.includes(String(args[0]));`,
} as const

export const GLOBAL_FUNCTIONS = {
  "active-element": "document.activeElement",
  "document-root": "document.documentElement",
  "input-acceptance": `({ inputDelayMs: (() => {
  if (!/^https?:$/.test(location.protocol) || performance.getEntriesByType("paint").length > 0) return 0;
  const navigation = performance.getEntriesByType("navigation")[0];
  if (!navigation || !(navigation.domInteractive > 0)) return 50;
  return Math.max(0, Math.ceil(navigation.domInteractive + 500 - performance.now()));
})() })`,
  "mark-input": `(() => { globalThis.__codenomadAutomationInputUntil = performance.now() + ${INPUT_MARK_LEASE_MS}; return Date.now() / 1000 })()`,
  "unmark-input": "(() => { globalThis.__codenomadAutomationInputUntil = Math.min(globalThis.__codenomadAutomationInputUntil || 0, performance.now()); return true })()",
} as const
export type PageFunctionId = keyof typeof ELEMENT_FUNCTIONS | keyof typeof GLOBAL_FUNCTIONS
export const FUNCTION_ARGS: Record<PageFunctionId, readonly string[]> = {
  "option-click": [], "programmatic-click": [], select: ["strings"], "select-values": ["strings"], "file-input": [], focus: [], describe: [], field: [], prepare: ["boolean"],
  "set-value": ["string", "boolean"], "delete-selection": [], "read-value": [], receives: ["handle"], "receives-wheel": ["handle"], contains: ["string"], "body-text-includes": ["string"], "checked-state": [],
  "active-element": [], "document-root": [], "input-acceptance": [], "mark-input": [], "unmark-input": [],
}
export const handleResult = (id: PageFunctionId) => ["field", "active-element", "document-root"].includes(id)
export const applicationOnly = (id: PageFunctionId) => id === "mark-input" || id === "unmark-input"
export function declaration(id: keyof typeof ELEMENT_FUNCTIONS, mark: boolean): string {
  const body = ELEMENT_FUNCTIONS[id]
  const element = `const element = this.nodeType === Node.ELEMENT_NODE ? this : this.parentElement;
    if (!(element instanceof Element) || !element.isConnected) throw new Error("codenomad:gone");`
  return mark
    ? `function (...args) { ${element} globalThis.__codenomadAutomationDepth = (globalThis.__codenomadAutomationDepth || 0) + 1;
      try { return (() => { ${body} })(); } finally { globalThis.__codenomadAutomationDepth--; } }`
    : `function (...args) { ${element} ${body} }`
}

/** Compile-time native resource; generation is checked by the contract tests. */
export function nativeFunctionRegistry() {
  return Object.fromEntries((Object.keys(FUNCTION_ARGS) as PageFunctionId[]).filter(id => !applicationOnly(id)).map(id => [id, {
    scope: Object.hasOwn(ELEMENT_FUNCTIONS, id) ? "element" : "global", args: FUNCTION_ARGS[id], handle: handleResult(id),
    source: Object.hasOwn(ELEMENT_FUNCTIONS, id) ? declaration(id as keyof typeof ELEMENT_FUNCTIONS, false) : GLOBAL_FUNCTIONS[id as keyof typeof GLOBAL_FUNCTIONS],
  }]))
}
