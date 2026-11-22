import {render} from 'solid-js/web'
import WindowCloseButton from '../../../packages/ui/src/components/window-close-button'
import InstanceTab from '../../../packages/ui/src/components/instance-tab'
import ActionOverflowMenu from '../../../packages/ui/src/components/action-overflow-menu'
import FileRowActions from '../../../packages/ui/src/components/instance/shell/right-panel/FileRowActions'
import {WorkspaceTree} from '../../../packages/ui/src/components/instance/shell/right-panel/components/WorkspaceTree'
import {WorkspaceFileView} from '../../../packages/ui/src/components/workspace-file-view'
import {serverApi} from '../../../packages/ui/src/lib/api-client'
import {SourceContext,prepareSourceContext,sourceContextSettled,sourceOptions} from './source-context.fixture'
const noop=()=>{},tree={rows:()=>[{path:'src',name:'src',depth:1,type:'directory',parent:'.'}],state:()=>({selected:'',expanded:new Set()}),busy:()=>new Set(),errors:()=>new Map(),load:async()=>{},select:noop,toggle:noop}
const items=[{key:'open',label:'Open',onSelect:noop},{key:'disabled',label:'Disabled',disabled:true,onSelect:noop}]
serverApi.previewWorkspaceFile=async(_id,path)=>({workspaceId:_id,relativePath:path,encoding:'base64',contents:btoa('A\0B')})
await prepareSourceContext()
render(()=><SourceContext>
 <div class="window-shell"><header class="window-header"><span class="window-title">Context</span><WindowCloseButton onClose={noop}/></header></div>
 <div class="tab-bar-instance"><div class="tab-draggable" style={{height:'var(--chrome-height)',display:'flex'}}><InstanceTab instance={{id:'synthetic',folder:'/trial/alpha',projectName:'Alpha',status:'ready',client:null,port:0,pid:0,proxyPath:'/synthetic-only'}} active onSelect={noop} onClose={noop} onRename={noop}/></div></div>
 <WorkspaceTree tree={tree as any} t={key=>key} directory="Synthetic" instanceId="synthetic" worktreeSlug="root" canOpen={false} onOpen={noop}/>
 <div class="file-row-actions" data-compact="true"><ActionOverflowMenu items={items} label="Context actions" triggerClass="file-row-icon-button" minItems={1}/></div>
 <div id="file-actions"><FileRowActions items={items} label="File actions"/></div>
 {sourceOptions().provider&&<div style={{display:'flex',height:'160px'}}><WorkspaceFileView instanceId="synthetic" target={{kind:'workspace',sessionId:'trial-session',slug:'root',directory:'/trial',path:'nul.bin'}} active onClose={noop}/></div>}
</SourceContext>,document.getElementById('root')!)
await sourceContextSettled()
