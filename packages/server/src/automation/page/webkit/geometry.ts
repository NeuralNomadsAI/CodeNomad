import { shadowRoot } from "./shadow"
type Roots=WeakMap<Element,WeakRef<ShadowRoot>>
const element=(node:Node)=>node.nodeType === 1 ? node as Element : node.parentElement
function frame(doc:Document): HTMLIFrameElement | undefined { return doc === document ? undefined : doc.defaultView?.frameElement as HTMLIFrameElement ?? undefined }
export class GeometryUnsupportedError extends Error {}
const parent=(item:Element): Element | null => item.assignedSlot ?? item.parentElement ?? (item.getRootNode() as ShadowRoot).host ?? null
function linearTransform(item:Element): DOMMatrix {
  let matrix=new DOMMatrix()
  for(let current:Element|null=item;current;current=parent(current)) {
    const style=current.ownerDocument.defaultView!.getComputedStyle(current)
    const transform=new DOMMatrix(style.transform === "none" ? undefined : style.transform)
    // Independent transforms and motion paths need their own composition order.
    if(!transform.is2D || style.perspective !== "none" || [style.rotate,style.scale,style.translate,style.offsetPath].some(value=>value && value !== "none"))
      throw new GeometryUnsupportedError("WebKit aiming requires an invertible 2D CSS transform; perspective, independent transforms and motion paths are unsupported")
    const zoom=Number(style.getPropertyValue("zoom")) || 1
    matrix=transform.scale(zoom).multiply(matrix)
  }
  if(!Number.isFinite(matrix.a*matrix.d-matrix.b*matrix.c) || Math.abs(matrix.a*matrix.d-matrix.b*matrix.c)<1e-10)
    throw new GeometryUnsupportedError("WebKit aiming requires an invertible 2D CSS transform")
  return matrix
}
function frameTransform(owner:HTMLIFrameElement): DOMMatrix {
  const matrix=linearTransform(owner),style=owner.ownerDocument.defaultView!.getComputedStyle(owner)
  const px=(name:string)=>parseFloat(style.getPropertyValue(name)) || 0
  const width=px("width")+(style.boxSizing === "border-box" ? 0 : px("padding-left")+px("padding-right")+px("border-left-width")+px("border-right-width"))
  const height=px("height")+(style.boxSizing === "border-box" ? 0 : px("padding-top")+px("padding-bottom")+px("border-top-width")+px("border-bottom-width"))
  const corners=[[0,0],[width,0],[width,height],[0,height]].map(([x,y])=>matrix.transformPoint({x,y}))
  const box=owner.getBoundingClientRect(),xs=corners.map(p=>p.x),ys=corners.map(p=>p.y)
  if(Math.abs(Math.max(...xs)-Math.min(...xs)-box.width)>0.5 || Math.abs(Math.max(...ys)-Math.min(...ys)-box.height)>0.5)
    throw new GeometryUnsupportedError("WebKit cannot map this frame's transformed content box exactly")
  // The bounding box fixes the translation, including layout, scrolling and every
  // transform-origin. Only the composed linear part affects corner differences.
  matrix.e+=box.left-Math.min(...xs);matrix.f+=box.top-Math.min(...ys)
  return matrix.translate(px("border-left-width")+px("padding-left"),px("border-top-width")+px("padding-top"))
}
type Point={x:number;y:number}
function clip(points:Point[],width:number,height:number): Point[] {
  for(const [axis,limit,sign] of [["x",0,1],["x",width,-1],["y",0,1],["y",height,-1]] as const) {
    const output:Point[]=[]
    for(let i=0;i<points.length;i++) {
      const a=points[i],b=points[(i+1)%points.length],insideA=(a[axis]-limit)*sign>=0,insideB=(b[axis]-limit)*sign>=0
      if(insideA) output.push(a)
      if(insideA !== insideB) {const t=(limit-a[axis])/(b[axis]-a[axis]);output.push({x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y)})}
    }
    points=output
  }
  return points
}
function validate(item:Element): void {
  linearTransform(item)
  for(let doc=item.ownerDocument,owner=frame(doc);owner;owner=frame(doc)) {frameTransform(owner);doc=owner.ownerDocument}
}
export function geometry(node:Node): number[][] {
  const item=element(node)
  if(!item) return []
  validate(item)
  return Array.from(item.getClientRects()).filter(rect=>rect.width>0 && rect.height>0).flatMap(rect=>{
    let points:Point[]=[{x:rect.left,y:rect.top},{x:rect.right,y:rect.top},{x:rect.right,y:rect.bottom},{x:rect.left,y:rect.bottom}],doc=item.ownerDocument
    for(let owner=frame(doc);owner;owner=frame(doc)) {
      points=clip(points,doc.defaultView!.innerWidth,doc.defaultView!.innerHeight)
      if(!points.length) return []
      const matrix=frameTransform(owner)
      points=points.map(point=>matrix.transformPoint(point))
      doc=owner.ownerDocument
    }
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y)
    const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys)
    return [[left,top,right,top,right,bottom,left,bottom]]
  })
}
export function scrollIntoView(node:Node): void {
  const item=element(node)
  if(!item) return
  validate(item)
  item.scrollIntoView({block:"center",inline:"center",behavior:"instant"})
  for(let doc=item.ownerDocument,owner=frame(doc);owner;owner=frame(doc)) {owner.scrollIntoView({block:"nearest",inline:"nearest",behavior:"instant"});doc=owner.ownerDocument}
}
export function hitTest(x:number,y:number,roots:Roots): Element | undefined {
  let root:Document|ShadowRoot=document,hit:Element|null=null
  const seen=new Set<Element>()
  for(;;) {
    const item:Element|null=root.elementFromPoint(x,y)
    if(!item || seen.has(item)) break
    validate(item)
    hit=item;seen.add(item)
    const shadow=shadowRoot(item,roots)
    if(shadow) {root=shadow;continue}
    if(item.localName === "iframe" || item.localName === "frame") {
      let doc:Document|null=null
      try {doc=(item as HTMLIFrameElement).contentDocument} catch { /* opaque frame */ }
      if(doc) {const point=frameTransform(item as HTMLIFrameElement).inverse().transformPoint({x,y});x=point.x;y=point.y;root=doc;continue}
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
