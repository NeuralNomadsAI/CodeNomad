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
  const receive=(event:Event)=>{
    try {
      const carriers=PointerEvent.prototype.getPredictedEvents.call(event)
      if(carriers.length!==1) return
      const candidate=Object.getOwnPropertyDescriptor(MouseEvent.prototype,"relatedTarget")!.get!.call(carriers[0])
      const validated=validate(candidate)
      if(validated) root=validated
    } catch { /* Native brands reject arbitrary page replies. */ }
  }
  host.addEventListener("__codenomad_shadow_v1",receive)
  try { host.dispatchEvent(new Event("__codenomad_request_shadow_v1")) }
  finally { host.removeEventListener("__codenomad_shadow_v1",receive) }
  if(root) roots.set(host,new WeakRef(root))
  return root
}
