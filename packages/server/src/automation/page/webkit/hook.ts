/** Fixed page-world annotation only; identity, traversal and handles stay isolated. */
export const CLOSED_SHADOW_HOOK = `(() => {
  const original = Element.prototype.attachShadow;
  const apply = Reflect.apply;
  const setAttribute = Element.prototype.setAttribute;
  const roots = new WeakMap();
  const Event = InputEvent;
  const Range = StaticRange;
  const dispatch = EventTarget.prototype.dispatchEvent;
  document.addEventListener("__codenomad_request_shadow_v1", event => {
    const root = roots.get(event.target)?.deref();
    if (root) apply(dispatch, event.target, [new Event("__codenomad_shadow_v1", { targetRanges: [new Range({startContainer:root,startOffset:0,endContainer:root,endOffset:0})] })]);
  }, true);
  const wrapped = function (options) {
    const root = apply(original, this, [options]);
    if (root.mode === "closed") {
      roots.set(this, new WeakRef(root));
      apply(setAttribute, this, ["data-codenomad-shadow-boundary", "closed"]);
    }
    return root;
  };
  Object.defineProperty(Element.prototype, "attachShadow", { ...Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow"), value: wrapped });
})()`
