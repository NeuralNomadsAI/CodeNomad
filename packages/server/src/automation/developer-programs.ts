import { declaration, FOCUS_MISMATCH, GLOBAL_FUNCTIONS, INPUT_MARK_LEASE_MS, POINTER_COVER, WHEEL_COVER } from "./page/functions"

// Fixed programs for the trusted main document, shared by the WebSocket and native WebView2 adapters.
export const CONTEXT_FUNCTION = `(session) => {
  const root = document.querySelector('[data-tab-visible="true"][data-tab-id]');
  const pane = root?.querySelector('.session-cache-pane[data-session-active="true"][data-session-id]');
  return {
    windowId: window.__CODENOMAD_WINDOW_ID__ ?? null,
    windowInstance: window.__CODENOMAD_WINDOW_INSTANCE__ ?? null,
    instanceId: root?.getAttribute('data-instance-id') ?? null,
    sessionId: pane?.getAttribute('data-session-id') ?? null,
    tabId: root?.getAttribute('data-tab-id') ?? null,
    sessionOpen: session !== null && Array.prototype.some.call(document.querySelectorAll('[data-tab-id][data-instance-id]'),
      tab => tab.getAttribute('data-tab-session-id') === session && !tab.getAttribute('data-instance-id').includes('~')),
  };
}`
const FOREGROUND = `const current = (${CONTEXT_FUNCTION})(null);
  const sameWindow = current.windowId === expected.windowId && current.windowInstance === (expected.windowInstance ?? null);
  const sameTab = current.tabId === (expected.tabId ?? null) && current.instanceId === expected.instanceId && current.sessionId === expected.sessionId;`
export const INPUT_STATE = "({ root: document.documentElement })"
export const GUARDED_CALLS = new Map((["option-click", "programmatic-click", "select", "set-value", "delete-selection"] as const).map(id => {
  const program = declaration(id, true)
  return [program, `function (handle, expected, ...args) {
    const check = () => {
      ${FOREGROUND}
      if (this.root !== document.documentElement || window !== window.top || handle?.ownerDocument !== document || !sameWindow)
        throw new Error("codenomad:action-root");
      if (!sameTab) throw new Error("codenomad:action-tab");
    };
    check();
    return (${program}).call(handle, ...args, check);
  }`]
}))
export const INPUT_DESTINATION = (wheel: boolean) => `function (point, expected, release, handle, insertText, dragSource, track, confirmReceiver, confirmed, observeDrag) {
  if (this.root !== document.documentElement || window !== window.top) return "root";
  let target = point ? document.elementFromPoint(point.x, point.y) : document.activeElement;
  while (target?.shadowRoot) {
    const root = target.shadowRoot;
    const inner = point ? root.elementFromPoint(point.x, point.y) : root.activeElement;
    if (!inner || inner === target || (!root.contains(inner) && !target.contains(inner))) break;
    target = inner;
  }
  ${FOREGROUND}
  if (!sameWindow) return "root";
  if (!release && !sameTab) return "tab";
  if (!target || /^(iframe|frame|fencedframe|object|embed|portal|webview)$/.test(target.localName)) return "frame";
  let capture;
  if (point && this.dragPress) {
    const { id, path } = this.dragPress;
    const holds = node => node.isConnected && node.ownerDocument === document &&
      Element.prototype.hasPointerCapture.call(node, id);
    capture = this.dragCapture;
    if (capture && !holds(capture)) return "receiver";
    if (!capture) this.dragCapture = capture = path.find(holds);
  }
  if (handle && (point || !release)) {
    const element = handle.nodeType === Node.ELEMENT_NODE ? handle : handle.parentElement;
    if (!element?.isConnected || element.ownerDocument !== document) return "element";
    if (point) {
      const cover = (element, ...args) => { ${wheel ? WHEEL_COVER : POINTER_COVER} };
      const blocked = cover(element, target);
      // The source can follow the pointer without capture. In that case retain the exact hit.
      const moved = capture ?? (this.dragPress && dragSource?.isConnected ? dragSource : null);
      if (blocked !== null && !(moved && cover(moved, target) === null)) return "cover:" + blocked;
    } else {
      const field = element, active = target;
      const editable = insertText && !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement);
      if (${FOCUS_MISMATCH}) return "focus";
    }
  }
  const receiver = capture ?? target;
  if (confirmReceiver && (this.hit?.id !== confirmReceiver || this.hit.receiver !== receiver)) return "receiver";
  // A hit retargeted out of a closed shadow root looks like any other host.
  const canHostShadow = /-|^(article|aside|blockquote|body|div|footer|h[1-6]|header|main|nav|p|section|span)$/;
  if (!target.shadowRoot && canHostShadow.test(target.localName) && target !== confirmed) return target;
  if (track) this.hit = { id: track, receiver };
  // Only a recipient from this trusted press path can become the drag's capture owner.
  if (observeDrag) window.addEventListener("pointerdown", event => {
    if (event.isTrusted && event.pointerType === "mouse" && event.button === 0 &&
        event.clientX === point.x && event.clientY === point.y && event.composedPath()[0] === target)
      this.dragPress = { id: event.pointerId, path: event.composedPath().filter(node => node instanceof Element) };
  }, { capture: true, once: true, signal: AbortSignal.timeout(${INPUT_MARK_LEASE_MS}) });
  return "ready";
}`

export const PROVENANCE = (expression: string) =>
  `function () { if (this.root !== document.documentElement) return "root"; return ${expression} }`

export function nativeDeveloperPrograms() {
  return {
    context: CONTEXT_FUNCTION, inputState: INPUT_STATE,
    destination: INPUT_DESTINATION(false), wheelDestination: INPUT_DESTINATION(true),
    guardedCalls: Object.fromEntries(GUARDED_CALLS),
    markInput: PROVENANCE(GLOBAL_FUNCTIONS["mark-input"]), unmarkInput: PROVENANCE(GLOBAL_FUNCTIONS["unmark-input"]),
  }
}
