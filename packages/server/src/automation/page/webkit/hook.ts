/** Fixed page-world annotation only; identity, traversal and handles stay isolated. */
export const CLOSED_SHADOW_HOOK = `(() => {
  const original = Element.prototype.attachShadow;
  const wrapped = function (options) {
    const root = Reflect.apply(original, this, [options]);
    if (root.mode === "closed") this.setAttribute("data-codenomad-shadow-boundary", "closed");
    return root;
  };
  Object.defineProperty(Element.prototype, "attachShadow", { ...Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow"), value: wrapped });
})()`
