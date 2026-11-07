/** Fixed page-world annotation only; identity, traversal and handles stay isolated. */
export const CLOSED_SHADOW_HOOK = `(() => {
  const original = Element.prototype.attachShadow;
  const apply = Reflect.apply;
  const setAttribute = Element.prototype.setAttribute;
  const wrapped = function (options) {
    const root = apply(original, this, [options]);
    if (root.mode === "closed") apply(setAttribute, this, ["data-codenomad-shadow-boundary", "closed"]);
    return root;
  };
  Object.defineProperty(Element.prototype, "attachShadow", { ...Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow"), value: wrapped });
})()`
