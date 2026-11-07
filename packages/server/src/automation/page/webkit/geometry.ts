import { shadowRoot } from "./shadow"
type Roots=WeakMap<Element,WeakRef<ShadowRoot>>
const element=(node:Node)=>node.nodeType === 1 ? node as Element : node.parentElement
function frame(doc:Document): HTMLIFrameElement | undefined { return doc === document ? undefined : doc.defaultView?.frameElement as HTMLIFrameElement ?? undefined }
export function geometry(node:Node): number[][] {
  const item=element(node)
  if(!item) return []
  return Array.from(item.getClientRects()).filter(rect=>rect.width>0 && rect.height>0).flatMap(rect=>{
    let left=rect.left,top=rect.top,right=rect.right,bottom=rect.bottom,doc=item.ownerDocument
    for(let owner=frame(doc);owner;owner=frame(doc)) {
      const box=owner.getBoundingClientRect(),sx=box.width/owner.offsetWidth,sy=box.height/owner.offsetHeight
      if(Math.min(owner.clientWidth,right)<=Math.max(0,left) || Math.min(owner.clientHeight,bottom)<=Math.max(0,top)) return []
      left=box.left+(owner.clientLeft+Math.max(0,left))*sx
      right=box.left+(owner.clientLeft+Math.min(owner.clientWidth,right))*sx
      top=box.top+(owner.clientTop+Math.max(0,top))*sy
      bottom=box.top+(owner.clientTop+Math.min(owner.clientHeight,bottom))*sy
      doc=owner.ownerDocument
    }
    return [[left,top,right,top,right,bottom,left,bottom]]
  })
}
export function scrollIntoView(node:Node): void {
  const item=element(node)
  if(!item) return
  item.scrollIntoView({block:"center",inline:"center",behavior:"instant"})
  for(let doc=item.ownerDocument,owner=frame(doc);owner;owner=frame(doc)) {owner.scrollIntoView({block:"nearest",inline:"nearest",behavior:"instant"});doc=owner.ownerDocument}
}
export function hitTest(x:number,y:number,roots:Roots): Element | undefined {
  let root:Document|ShadowRoot=document,hit:Element|null=null
  const seen=new Set<Element>()
  for(;;) {
    const item=root.elementFromPoint(x,y)
    if(!item || seen.has(item)) break
    hit=item;seen.add(item)
    const shadow=shadowRoot(item,roots)
    if(shadow) {root=shadow;continue}
    if(item.localName === "iframe" || item.localName === "frame") {
      try {
        const owner=item as HTMLIFrameElement,doc=owner.contentDocument
        if(doc) {const box=owner.getBoundingClientRect();x=(x-box.left)*owner.offsetWidth/box.width-owner.clientLeft;y=(y-box.top)*owner.offsetHeight/box.height-owner.clientTop;root=doc;continue}
      } catch { /* opaque frame */ }
    }
    break
  }
  return hit ?? undefined
}
export function activeElement(roots:Roots): Element | null {
  let item=document.activeElement
  const seen=new Set<Element>()
  while(item && !seen.has(item)) {
    seen.add(item)
    const nested=shadowRoot(item,roots)?.activeElement ?? ((item as HTMLIFrameElement).contentDocument?.activeElement)
    if(!nested || nested === item) break
    item=nested
  }
  return item
}
