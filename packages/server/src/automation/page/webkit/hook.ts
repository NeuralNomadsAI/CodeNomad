/** Fixed weak capture bridge; identity, traversal and handles stay isolated. */
export const CLOSED_SHADOW_HOOK = `(() => {
  const original = Element.prototype.attachShadow;
  const apply = Reflect.apply;
  const setAttribute = Element.prototype.setAttribute;
  const roots = new WeakMap();
  const Reply = PointerEvent;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const listen = EventTarget.prototype.addEventListener;
  const reply = function (host) {
    const root = roots.get(host);
    if (root) {
      // The nested carrier is never dispatched, preserving its native Node
      // reference without shadow retargeting or cross-world JS serialization.
      const carrier = new Reply("__codenomad_reference_v1", {relatedTarget:root});
      apply(dispatch,host,[new Reply("__codenomad_shadow_v1",{predictedEvents:[carrier]})]);
    }
  };
  const wrapped = function (options) {
    const root = apply(original, this, [options]);
    if (root.mode === "closed") {
      const host = this;
      roots.set(host, root);
      apply(listen,host,["__codenomad_request_shadow_v1",()=>reply(host)]);
      apply(setAttribute, this, ["data-codenomad-shadow-boundary", "closed"]);
    }
    return root;
  };
  Object.defineProperty(Element.prototype, "attachShadow", { ...Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow"), value: wrapped });
})()`
