/** Page-world responses are hints: native DOM getters enforce brand/host/document. */
export function shadowRoot(host: Element, roots: WeakMap<Element, WeakRef<ShadowRoot>>): ShadowRoot | undefined {
  if (host.shadowRoot) return host.shadowRoot
  const validate = (candidate: unknown): ShadowRoot | undefined => {
    try {
      const get = (prototype: object, key: string, value: unknown) => Object.getOwnPropertyDescriptor(prototype,key)!.get!.call(value)
      if (get(ShadowRoot.prototype,"host",candidate) !== host || get(ShadowRoot.prototype,"mode",candidate) !== "closed"
        || get(Node.prototype,"ownerDocument",candidate) !== host.ownerDocument) return
      // Rewrap the native object in this isolated realm before consuming it.
      return Node.prototype.getRootNode.call(candidate) as ShadowRoot
    } catch { return undefined }
  }
  const cached=validate(roots.get(host)?.deref())
  if(cached) return cached
  if(host.getAttribute("data-codenomad-shadow-boundary") !== "closed") return
  let root: ShadowRoot | undefined
  const receive=(event: Event)=>{
    try {
      const ranges=InputEvent.prototype.getTargetRanges.call(event)
      if(ranges.length !== 1) return
      const candidate=ranges[0].startContainer
      root=validate(candidate)
    } catch { /* A page can dispatch arbitrary events; none grants a DOM identity. */ }
  }
  host.addEventListener("__codenomad_shadow_v1",receive)
  try { host.dispatchEvent(new Event("__codenomad_request_shadow_v1",{bubbles:true,composed:true})) }
  finally { host.removeEventListener("__codenomad_shadow_v1",receive) }
  if(root) roots.set(host,new WeakRef(root))
  return root
}
