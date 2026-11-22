import {Show,createSignal} from 'solid-js'
import {render} from 'solid-js/web'
import {FilesPreviewView} from '../../../packages/ui/src/components/files-preview-view'
import AlertDialog from '../../../packages/ui/src/components/alert-dialog'
import {ConfigProvider,updatePreferences,setThemePreference} from '../../../packages/ui/src/stores/preferences'
import {I18nProvider,preloadLocaleMessages} from '../../../packages/ui/src/lib/i18n'
import {ThemeProvider} from '../../../packages/ui/src/lib/theme'
import {serverApi} from '../../../packages/ui/src/lib/api-client'
import {initializeClientState,writeClientLayoutValue} from '../../../packages/ui/src/stores/client-state'
import {RIGHT_PANEL_FILES_WORD_WRAP_KEY} from '../../../packages/ui/src/components/instance/shell/storage'
import {decodeWorkspaceText} from '../../../packages/ui/src/components/workspace-file-editor'
import {readerScenes,sceneBytes} from './workspace-reader-scenes.mjs'
import '../../../packages/ui/src/index.css'

const query=new URL(location.href).searchParams,id='rune-reader-source',directory='/trial-rune-reader'
const calls:unknown[]=[],disk=new Map<string,{bytes:Uint8Array,version:string}>()
for(const scene of Object.values(readerScenes))disk.set(scene.path,{bytes:sceneBytes(scene),version:'v1'})
let failure=false,release:undefined|(()=>void),held=false,closed=false
const [target,setTarget]=createSignal({kind:'workspace' as const,sessionId:'trial-session',slug:'root',directory,path:readerScenes[query.get('scene')||'utf8'].path})
const [active,setActive]=createSignal(true),[opened,setOpened]=createSignal(true)
const base64=(bytes:Uint8Array)=>{let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value)}
serverApi.previewWorkspaceFile=async(_id,path,scope,signal)=>{
  calls.push({kind:'read',id:_id,path,directory:scope})
  if(held)await new Promise<void>((resolve,reject)=>{release=resolve;signal?.addEventListener('abort',()=>reject(new DOMException('fixture cancelled','AbortError')),{once:true})})
  if(failure){failure=false;throw Error('Synthetic preview failure')}
  const data=disk.get(path);if(!data)throw Error('Unknown synthetic file')
  return {workspaceId:_id,relativePath:path,encoding:'base64',contents:base64(data.bytes),version:data.version}
}
serverApi.writeWorkspaceFile=async(_id,path,text,options)=>{
  const old=disk.get(path);if(old?.version!==options?.expectedVersion)throw Error('Synthetic version conflict')
  calls.push({kind:'write',id:_id,path,directory:options?.directory,expectedVersion:options?.expectedVersion,text})
  disk.set(path,{bytes:new TextEncoder().encode(text),version:'v'+(Number(old.version.slice(1))+1)})
}
const scene=readerScenes[query.get('scene')||'utf8'];held=!!scene.hold;failure=!!scene.fail
Object.assign(window,{runeWorkspaceReader:{ready:false,open:(name:string)=>{const scene=readerScenes[name];held=!!scene.hold;failure=!!scene.fail;setTarget({kind:'workspace',sessionId:'trial-session',slug:'root',directory,path:scene.path});setOpened(true)},
  decoded:()=>Object.fromEntries(['bom','doublebom','malformed','nul','empty','utf8'].map(name=>{try{return [name,{text:decodeWorkspaceText({encoding:'base64',contents:base64(sceneBytes(readerScenes[name]))})}]}catch(error){return [name,{error:error instanceof Error?error.name:'UnknownError'}]}})),
  release:()=>{held=false;release?.();release=undefined},active:setActive,
  external:(text:string)=>{const path=target().path,old=disk.get(path)!;disk.set(path,{bytes:new TextEncoder().encode(text),version:'v'+(Number(old.version.slice(1))+1)})},
  state:()=>({target:target().path,opened:opened(),active:active(),closed,calls:[...calls],disk:Object.fromEntries([...disk].map(([path,data])=>[path,{version:data.version,length:data.bytes.length,...(path===target().path?{base64:base64(data.bytes)}:{})}]))})}})
await initializeClientState()
writeClientLayoutValue(RIGHT_PANEL_FILES_WORD_WRAP_KEY,'off')
await updatePreferences({locale:query.get('rtl')==='true'?'he':'en'})
await preloadLocaleMessages(query.get('rtl')==='true'?'he':'en')
await setThemePreference(query.get('theme')==='dark'?'dark':'light')
render(()=><ConfigProvider><I18nProvider><ThemeProvider>
  <AlertDialog/><main id="fixture" style={{height:'100vh',display:'flex','flex-direction':'column','min-width':'0'}}>
  <Show when={opened()}><FilesPreviewView instanceId={id} target={target()} active={active()} onClose={()=>{closed=true;setOpened(false)}}/></Show>
  </main>
</ThemeProvider></I18nProvider></ConfigProvider>,document.getElementById('root')!)
;(window as any).runeWorkspaceReader.ready=true
