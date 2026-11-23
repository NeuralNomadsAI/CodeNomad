import {createMemo,createSignal,Show} from "solid-js"
import {render} from "solid-js/web"
import {Eye,Copy,ExternalLink,Trash} from "lucide-solid"
import FileRowActions from "../../../src/components/instance/shell/right-panel/FileRowActions"
import ActionOverflowMenu from "../../../src/components/action-overflow-menu"
import {ConfigProvider} from "../../../src/stores/preferences"
import {I18nProvider,preloadLocaleMessages} from "../../../src/lib/i18n"
import "../../../src/index.css"

const query=new URL(location.href).searchParams
const [width,setWidth]=createSignal(360),[checked,setChecked]=createSignal(false),[count,setCount]=createSignal(3)
const [disabled,setDisabled]=createSignal(false),[label,setLabel]=createSignal("example.rs")
const trace:{event:string,focus?:string}[]=[]
const log=(event:string)=>trace.push({event,focus:document.activeElement?.getAttribute("aria-label")||undefined})
const items=createMemo(()=>[
  {key:"preview",label:"Preview",checked:checked(),get icon(){return <Eye/>},onSelect:()=>{log("preview");setChecked(!checked())}},
  ...[
    {key:"open",label:"Open",disabled:disabled(),get icon(){return <ExternalLink/>},onSelect:()=>log("open")},
    {key:"disabled",label:"Disabled",disabled:true,get icon(){return <Trash/>},onSelect:()=>log("disabled")},
    {key:"copy",label:"Copy",disabled:disabled(),get icon(){return <Copy/>},onSelect:()=>log("copy")},
  ].slice(0,count())
])
Object.assign(window,{runeFileActions:{ready:false,resize:setWidth,checked:setChecked,count:setCount,disabled:setDisabled,label:setLabel,state:()=>({trace:[...trace],checked:checked(),width:width(),compact:document.querySelector('.file-row-actions')?.getAttribute('data-compact'),active:document.activeElement?.getAttribute('aria-label')})}})
render(()=><ConfigProvider><I18nProvider><div id="frame" style={{width:`${width()}px`,"background-color":"var(--surface-canvas)"}}>
  <div class="workspace-tree-row" role="treeitem" tabIndex={0} aria-label="Synthetic row" onClick={()=>log("row")} onPointerDown={()=>log("row-down")}>
    <span class="workspace-tree-label">{label()}</span><Show when={query.get("mode")==="standalone"} fallback={<FileRowActions items={items()} label="Actions"/>}>
      <span class="file-row-actions" data-compact="true"><ActionOverflowMenu items={items().slice(1)} label="Actions" triggerClass="file-row-icon-button"/></span>
    </Show>
  </div>
</div><button id="outside" onClick={()=>log("outside")}>Outside</button></I18nProvider></ConfigProvider>,document.getElementById("root")!)
await preloadLocaleMessages("en")
document.documentElement.dataset.theme=query.get("theme")==="dark"?"dark":"light"
document.documentElement.dir=query.get("rtl")==="true"?"rtl":"ltr"
;(window as any).runeFileActions.ready=true
