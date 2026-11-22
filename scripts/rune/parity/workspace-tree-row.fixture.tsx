import {createSignal} from "solid-js"
import {render} from "solid-js/web"
import {WorkspaceTree} from "../../../packages/ui/src/components/instance/shell/right-panel/components/WorkspaceTree"
import {SourceContext,prepareSourceContext,sourceContextSettled} from './source-context.fixture'
import "../../../packages/ui/src/index.css"

const query=new URL(location.href).searchParams
const rtl=query.get("rtl")==="true",open=query.get("open")==="true",file=query.get("file")==="true"
document.documentElement.dataset.theme=query.get("theme")||"light"
document.documentElement.dir=rtl?"rtl":"ltr"
const label=file?"example.rs":"src",path=label,depth=Number(query.get("depth")||1)
const [state,setState]=createSignal({selected:query.get("selected")==="true"?path:"",expanded:new Set(open?[path]:[])})
const events:string[]=[]
const tree={rows:()=>[{path,name:label,depth,type:file?"file":"directory",parent:"."}],state,
  busy:()=>new Set(query.get("busy")==="true"?[path]:[]),errors:()=>new Map(),load:async()=>{},
  select:(value:string)=>{events.push("select");setState(s=>({...s,selected:value}))},
  toggle:(value:string)=>{events.push("toggle");setState(s=>({...s,expanded:s.expanded.has(value)?new Set():new Set([value])}))}}
Object.assign(window,{runeWorkspaceRow:{ready:false,state:()=>({events,selected:state().selected,expanded:[...state().expanded]})}})
await prepareSourceContext()
render(()=><SourceContext><div id="fixture" style={{width:"360px"}}>
  <WorkspaceTree tree={tree as any} t={key=>key} directory="Synthetic" instanceId="synthetic" worktreeSlug="root" canOpen={false} onOpen={()=>events.push("preview")} />
</div></SourceContext>,document.getElementById("root")!)
await sourceContextSettled()
document.documentElement.dir=rtl?"rtl":"ltr"
;(window as any).runeWorkspaceRow.ready=true
