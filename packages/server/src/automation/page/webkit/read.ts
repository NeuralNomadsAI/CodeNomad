import { computeAccessibleName, computeAccessibleDescription, getRole, isInaccessible } from "dom-accessibility-api"
import { readCalls } from "./calls.generated"
import type { SemanticNode, PageOperation } from "../protocol"
import { shadowRoot } from "./shadow"
import { geometry, scrollIntoView, hitTest, activeElement } from "./geometry"

type State = {
  document: Document; token: string; next: number; ids: WeakMap<Node,number>; nodes: Map<number,WeakRef<Node>>
  observers: Set<{observer: MutationObserver; root: WeakRef<Node>}>; observed: WeakSet<Node>
  roots: WeakMap<Element,WeakRef<ShadowRoot>>
  hides: WeakMap<Document,()=>void>
}
const MAX_NODES = 20_000
const KEY = "__codenomadWebkitReadV1"
const token = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const globalState = globalThis as typeof globalThis & { [KEY]?: State }
function makeState(): State { return {document,token:token(),next:0,ids:new WeakMap(),nodes:new Map(),observers:new Set(),observed:new WeakSet(),roots:new WeakMap(),hides:new WeakMap()} }
function parent(node: Node): Node | null { return node.parentNode ?? (node.nodeType === 11 ? (node as ShadowRoot).host : null) }
function live(node: Node): boolean {
  const doc = node.nodeType === 9 ? node as Document : node.ownerDocument
  if (!doc || (node.nodeType !== 9 && !node.isConnected)) return false
  if (doc === document) return true
  try { const frame = doc.defaultView?.frameElement as HTMLIFrameElement | null; return !!frame && frame.contentDocument === doc && live(frame) } catch { return false }
}
function retire(state: State, node: Node) {
  const id = state.ids.get(node)
  if (id !== undefined) { state.nodes.delete(id); state.ids.delete(node) }
  for (const child of Array.from(node.childNodes)) retire(state, child)
  if (node.nodeType === 1) { const root=shadowRoot(node as Element,state.roots); if(root) retire(state,root) }
  if (node.nodeType === 1 && ["iframe","frame"].includes((node as Element).localName)) {
    try { const doc=(node as HTMLIFrameElement).contentDocument; if(doc) retire(state,doc) } catch { /* opaque frame */ }
  }
}
function watchDocument(state:State,doc:Document) {
  let hide=state.hides.get(doc)
  if(!hide) {hide=()=>{if(doc===state.document)state.token=token();else retire(state,doc)};state.hides.set(doc,hide)}
  doc.defaultView?.addEventListener('pagehide',hide)
}
function watch(state: State, root: Node) {
  if(root.nodeType===9) watchDocument(state,root as Document)
  if (state.observed.has(root)) return
  state.observed.add(root)
  const observer = new MutationObserver(records => retireRecords(state,records))
  observer.observe(root,{childList:true,subtree:true})
  state.observers.add({observer,root:new WeakRef(root)})
}
function retireRecords(state: State, records: MutationRecord[]) {
  for (const record of records) for (const removed of Array.from(record.removedNodes)) {
    if (removed.nodeType === 1 && (removed as Element).localName === "html" && record.target === document) {
      for (const {observer} of state.observers) observer.disconnect()
      Object.assign(state,makeState(),{hides:state.hides})
      watch(state,document)
      return
    }
    retire(state,removed)
    if (removed.nodeType === 1 && (removed as Element).localName === "html" && record.target.nodeType === 9) retire(state,record.target)
  }
}
function flush(state: State) {
  for (const entry of state.observers) {
    retireRecords(state,entry.observer.takeRecords())
    const root=entry.root.deref()
    if(root?.nodeType===9 && live(root)) watchDocument(state,root as Document)
    if (!root || !live(root)) {entry.observer.disconnect();state.observers.delete(entry);if(root)state.observed.delete(root)}
  }
  for (const [id, reference] of state.nodes) { const node = reference.deref(); if (!node || !live(node)) { if (node) state.ids.delete(node); state.nodes.delete(id) } }
}
function id(state: State,node: Node): number {
  const existing=state.ids.get(node)
  if (existing !== undefined) return existing
  if (state.nodes.size >= MAX_NODES) throw new Error("WebKit semantic identity table exceeds 20000 nodes")
  const value=++state.next; state.ids.set(node,value); state.nodes.set(value,new WeakRef(node)); return value
}
function lookup(state: State,value: number): Node | undefined { const node=state.nodes.get(value)?.deref(); return node && live(node) && state.ids.get(node) === value ? node : undefined }
function handle(state: State,node: Node): string { return `${state.token}:${id(state,node)}` }
function fromHandle(state: State,value: string): Node | undefined { const prefix=`${state.token}:`; return value.startsWith(prefix) ? lookup(state,Number(value.slice(prefix.length))) : undefined }
function hidden(element: Element): boolean {
  if (isInaccessible(element)) return true
  for (let node: Node | null=element; node; node=parent(node)) {
    if (node.nodeType !== 1) continue
    const item=node as Element
    if (item.ownerDocument.defaultView!.getComputedStyle(item).display === "none") return true
    if (item.hasAttribute("inert") || item.getAttribute("aria-hidden") === "true") return true
    if (item.localName === "details" && !item.hasAttribute("open")) {
      const summary=Array.from(item.children).find(child=>child.localName === "summary")
      if (element !== item && (!summary || (element !== summary && !summary.contains(element)))) return true
    }
  }
  return false
}
const collapse=(text: string)=>text.replace(/\s+/g," ").trim()
function composedText(root: Node,state:State): string {
  if (root.nodeType === 3) return root.textContent ?? ""
   if (root.nodeType === 1 && (["script","style","template","noscript","head"].includes((root as Element).localName) || hidden(root as Element))) return ""
  const element=root.nodeType === 1 ? root as Element : undefined
  if (element?.localName === "slot") { const nodes=(element as HTMLSlotElement).assignedNodes({flatten:true}); if (nodes.length) return nodes.map(node=>composedText(node,state)).join(" ") }
  return Array.from((element && shadowRoot(element,state.roots))?.childNodes ?? root.childNodes).map(node=>composedText(node,state)).join(" ")
}
function role(element: Element): string {
  const tag=element.localName, type=(element as HTMLInputElement).type
  if (element.getAttribute("role")?.trim()) return getRole(element) ?? "generic"
  if (tag === "input") {
    if (type === "password") return "textbox"
    if (type === "date" || type === "month" || type === "week") return "Date"
    if (type === "datetime-local") return "DateTime"
    if (type === "time") return "InputTime"
    if (type === "color") return "ColorWell"
  }
  if (tag === "summary") return "DisclosureTriangle"
  if (tag === "iframe" || tag === "frame") return "Iframe"
  let value=getRole(element) ?? "generic"
  if (["html","body","label","legend"].includes(tag)) value=tag === "label" ? "LabelText" : "generic"
  if (value === "region" && !computeAccessibleName(element)) value="generic"
  if ((tag === "header" || tag === "footer") && element.parentElement?.closest("article,aside,main,nav,section")) value="generic"
  return value
}
function ariaDisabled(element: Element): boolean {
  for (let node: Node | null=element; node; node=parent(node)) {
    if (node.nodeType === 1 && (node as Element).getAttribute("aria-disabled") === "true") return true
  }
  return false
}
function semanticTree(state: State): SemanticNode[] {
  const nodes: SemanticNode[]=[], seen=new Set<Node>()
  const add=(node: Node, parentId?: string): SemanticNode => {
    const key=id(state,node), result: SemanticNode={id:String(key),node:key,...(parentId ? {parent:parentId}:{}),children:[]}
    nodes.push(result); return result
  }
  const boundary=(owner: SemanticNode,name: string,description: string) => {
    const key=`boundary-${owner.id}`
    owner.children!.push(key)
    nodes.push({id:key,parent:owner.id,role:"note",name,description})
  }
  const visit=(node: Node,parentId?: string): SemanticNode | undefined => {
    if (seen.has(node)) return
    seen.add(node)
    if (node.nodeType === 3) {
      if (!collapse(node.textContent ?? "")) return
      const result=add(node,parentId); result.role="StaticText"; result.name=node.textContent ?? ""; return result
    }
    if (node.nodeType === 9) {
      const doc=node as Document; watch(state,doc)
      const result=add(node,parentId); result.role="RootWebArea"; result.name=doc.title
      if (doc.body) { const child=visit(doc.body,result.id); if (child) result.children!.push(child.id!) }
      return result
    }
    if (node.nodeType !== 1) return
    const element=node as Element
    if (["script","style","template","noscript","head"].includes(element.localName) || hidden(element)) return
    const result=add(node,parentId), currentRole=role(element)
    result.role=currentRole
    let name=computeAccessibleName(element)
    const shadow=shadowRoot(element,state.roots)
    if (!name && shadow && ["button","link","checkbox","tab","heading"].includes(currentRole)) name=collapse(composedText(element,state))
    result.name=name
    result.description=computeAccessibleDescription(element)
    const properties: NonNullable<SemanticNode['properties']>=[]
    const property=(name: string,value: unknown)=>properties.push({name,value})
    const attr=(name: string)=>element.getAttribute(`aria-${name}`)
    const input=element as HTMLInputElement, tag=element.localName
    if (["checkbox","radio","switch","menuitemcheckbox","menuitemradio"].includes(currentRole)) property("checked", attr("checked") ?? (input.indeterminate ? "mixed" : !!input.checked))
    if (attr("pressed") !== null) property("pressed",attr("pressed"))
    if (attr("expanded") !== null) property("expanded",attr("expanded") === "true")
    else if (tag === "select" && !(element as HTMLSelectElement).multiple && (element as HTMLSelectElement).size <= 1) property("expanded",false)
    else if (tag === "summary" && element.parentElement?.localName === "details") property("expanded",element.parentElement.hasAttribute("open"))
    if (attr("selected") !== null || tag === "option") property("selected",attr("selected") !== null ? attr("selected") === "true" : (element as HTMLOptionElement).selected)
    if (element.matches(":disabled") || ariaDisabled(element)) property("disabled",true)
    if (input.required || attr("required") === "true") property("required",true)
    if (input.readOnly || attr("readonly") === "true") property("readonly",true)
    if (tag === "select" && (element as HTMLSelectElement).multiple || attr("multiselectable") === "true") property("multiselectable",true)
    if ((element as HTMLElement).tabIndex >= 0) property("focusable",true)
    for (const state of ["busy","modal"]) if(attr(state) === "true") property(state,true)
    const root=element.getRootNode()
    if (element.ownerDocument.activeElement === element || root.nodeType === 11 && (root as ShadowRoot).activeElement === element) property("focused",true)
    if (attr("invalid") && attr("invalid") !== "false") property("invalid",attr("invalid"))
    else if (attr("invalid") === null && input.validity && !input.validity.valid) property("invalid","true")
    if (currentRole === "heading") property("level",Number(attr("level") ?? /^h([1-6])$/.exec(tag)?.[1] ?? 2))
    if (tag === "a" && element.hasAttribute("href")) property("url",(element as HTMLAnchorElement).href)
    const editable=(element as HTMLElement).isContentEditable
    if (editable) property("editable","richtext")
    if ((tag === "input" && !["checkbox","radio","button","submit","reset","image","file"].includes(input.type)) || tag === "textarea") result.value=input.type === "password" ? "•".repeat(Math.min(input.value.length,16)) : input.value
    else if (tag === "select" && !(element as HTMLSelectElement).multiple) result.value=Array.from((element as HTMLSelectElement).selectedOptions).map(option=>option.label||option.textContent||"").join(" ")
    else if (editable) result.value=(element as HTMLElement).innerText
    else if (attr("valuetext") !== null || attr("valuenow") !== null) result.value=attr("valuetext") ?? attr("valuenow")
    result.properties=properties
    if (tag === "iframe" || tag === "frame") {
      try {
        const child=(element as HTMLIFrameElement).contentDocument
        if (!child) throw new Error("cross-origin")
        const nested=visit(child,result.id); if (nested) result.children!.push(nested.id!)
      } catch { delete result.node; boundary(result,"Cross-origin frame (unavailable)","Frame contents cannot be traversed") }
      return result
    }
    if (!shadow && element.getAttribute("data-codenomad-shadow-boundary") === "closed") { boundary(result,"Closed shadow root (unavailable)","Closed shadow capture could not be validated"); return result }
    if (shadow) watch(state,shadow)
    const children=tag === "slot" && (element as HTMLSlotElement).assignedNodes({flatten:true}).length ? (element as HTMLSlotElement).assignedNodes({flatten:true}) : Array.from(shadow?.childNodes ?? element.childNodes)
    for (const child of children) { const nested=visit(child,result.id); if (nested) result.children!.push(nested.id!) }
    return result
  }
  visit(document)
  return nodes
}

export function read(operation: PageOperation): {document: string; result: Record<string,unknown>} {
  if (globalState[KEY]?.document !== document) {
    globalState[KEY]=makeState()
  }
  const state=globalState[KEY]!
  watch(state,document); flush(state)
  let result: Record<string,unknown>
  switch (operation.op) {
    case "tree": result={nodes:semanticTree(state)}; break
    case "checkpoint": result={}; break
    case "release-handles": result={}; break // All entries are weak; numeric document identity remains stable.
    case "resolve": { const node=lookup(state,operation.node); result=node ? {handle:handle(state,node)} : {}; break }
    case "viewport": result={width:innerWidth,height:innerHeight}; break
    case "geometry": {const node=lookup(state,operation.node);result=node ? {quads:geometry(node)} : {};break}
    case "scroll-into-view": {const node=lookup(state,operation.node);if(node)scrollIntoView(node);result={};break}
    case "hit-test": {const node=hitTest(operation.x,operation.y,state.roots);result=node ? {node:id(state,node)} : {};break}
    case "call": {
      if (operation.function === "document-root" || operation.function === "active-element") {
        const node=operation.function === "document-root" ? document.documentElement : activeElement(state.roots)
        result=node ? {handle:handle(state,node)} : {}; break
      }
      if (operation.function === "input-acceptance") { result={value:{inputDelayMs:0}}; break }
      if (!Object.hasOwn(readCalls,operation.function)) { result={error:{code:"unsupported",driver:"webkit",operation:`call:${operation.function}`}}; break }
      const node=operation.handle ? fromHandle(state,operation.handle) : undefined
      if (!node) { result={exception:"codenomad:gone"}; break }
      if(operation.function === "contains") {
        const needle=collapse(String(operation.args[0])).toLowerCase()
        result={value:semanticTree(state).some(item=>{
          const target=item.node ? lookup(state,item.node) : undefined
          const element=target?.nodeType === 1 ? target as Element : undefined
          const attributes=element ? ['aria-label','title','placeholder'].map(name=>element.getAttribute(name)) : []
          if(element && ['input','textarea'].includes(element.localName)) attributes.push((element as HTMLInputElement).value)
           const text=target?.nodeType === 9 && (target as Document).body ? composedText((target as Document).body,state) : undefined
           return [text,item.name,item.value,item.description,...attributes].some(value=>typeof value === "string" && collapse(value).toLowerCase().includes(needle))
        })}
        break
      }
      try {
        const args=operation.args.map(arg=>arg && typeof arg === "object" && Object.hasOwn(arg,"handle") ? fromHandle(state,(arg as {handle:string}).handle) : arg)
        const value=readCalls[operation.function as keyof typeof readCalls].call(node,...args)
        result=operation.function === "field" ? {handle:handle(state,value as Node)} : {value}
      } catch (error) { result={exception:String(error)} }
      break
    }
    default: result={error:{code:"unsupported",driver:"webkit",operation:operation.op}}
  }
  return {document:state.token,result}
}
