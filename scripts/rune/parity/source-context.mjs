import assert from 'node:assert/strict'
import {readFile,realpath} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {borrowFixture} from '../../../packages/ui/tests/browser/fixture-borrow.ts'
import {startRunDaemon} from '../../../packages/ui/tests/browser/fixture-daemon/run.ts'
import {fixtureEventStream} from '../../../packages/ui/tests/browser/fixture-event-stream.ts'
import {armFixtureNavigationBudget} from '../../../packages/ui/tests/browser/fixture-navigation-budget.ts'
import {prepareGitPrototypeAssets} from '../../../packages/ui/tests/browser/fixtures/git-history-assets.mjs'
export const root=fileURLToPath(new URL('../../../',import.meta.url))
export async function prepareSourceAssets(){
 const renderer=await realpath(path.join(root,'packages/ui/src/renderer'))
 assert(renderer.toLowerCase().startsWith((await realpath(root)).toLowerCase()+path.sep),'Assets must belong to the executing worktree')
 prepareGitPrototypeAssets()
}
export const contextInputs=['packages/ui/src/lib/theme.tsx','packages/ui/src/stores/preferences.tsx','packages/ui/src/lib/appearance-preferences.ts','packages/ui/src/lib/theme-scheme.ts','packages/ui/src/lib/soft-color-schemes.ts','packages/ui/src/lib/classic-light-surfaces.ts','packages/ui/src/lib/classic-dark-surfaces.ts','packages/ui/src/lib/high-contrast.ts','scripts/rune/parity/source-context.fixture.tsx','scripts/rune/parity/source-context.mjs','package-lock.json']
export async function sourceDependencies(){
 const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8')),require=createRequire(import.meta.url),packages={}
 for(const name of ['solid-js','lucide-solid','@kobalte/core','@suid/material','@mermaid-js/tiny','typescript','@suid/system','@suid/base','vite','vite-plugin-solid','playwright']){
  let directory=path.dirname(require.resolve(name)),manifest
  for(;;){try{manifest=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));if(manifest.name===name)break}catch{}const parent=path.dirname(directory);assert.notEqual(parent,directory,'Package manifest missing: '+name);directory=parent}
  const expected=lock.packages['node_modules/'+name]?.version
  assert.equal(manifest.version,expected,'Installed Source dependency differs from lock: '+name)
  packages[name]={version:manifest.version,lock:expected}
 }
 return {node:process.version,packages}
}
const merge=(old,patch)=>{const value={...old};for(const [key,next] of Object.entries(patch)){if(next===null)delete value[key];else value[key]=next&&typeof next==='object'&&!Array.isArray(next)?merge(value[key]||{},next):next}return value}
export async function createSourceFixture(entry,name='rune-source-context',markup=''){
 const dependencies=await sourceDependencies(),provenance=Object.fromEntries(await Promise.all(contextInputs.map(async file=>[file,createHash('sha256').update((await readFile(path.join(root,file),'utf8')).replaceAll('\r\n','\n')).digest('hex')])))
 const daemon=await startRunDaemon({uiRoot:path.join(root,'packages/ui'),warmup:false,logPrefix:'codenomad-rune-source-context-'})
 const fixture=await borrowFixture({name,routes:[{path:'/fixture',html:'<html><body style="margin:0"><div id="root"></div><template id="source-contract">'+markup+'</template><script type="module" src="/@fs/'+path.resolve(root,entry).replaceAll('\\','/')+'"></script></body></html>'}]},{endpoint:daemon})
 const origin=new URL(fixture.url).origin,events=await fixtureEventStream(origin),pages=new Set()
 return {url:fixture.url,dependencies,provenance,logDirectory:daemon.logDirectory,
  async open(browser,query={},viewport={width:960,height:640},{hasTouch=false,isMobile=false}={}){
   armFixtureNavigationBudget(browser)
   const page=await browser.newPage({viewport,hasTouch,isMobile,deviceScaleFactor:1,locale:query.locale==='he'?'he-IL':'en-US'}),storage=new Map(),diagnostics={page:[],console:[],network:[],rejected:[],api:[],resources:[]}
   pages.add(page);page.once('close',()=>pages.delete(page))
   page.on('pageerror',error=>diagnostics.page.push(error.message));page.on('console',message=>{if(message.type()==='error')diagnostics.console.push(message.text())});page.on('requestfailed',request=>diagnostics.network.push({url:request.url(),error:request.failure()?.errorText}))
   page.on('response',response=>{if(response.status()>=400)diagnostics.resources.push({url:response.url(),status:response.status()})})
   await page.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url())
    if(url.origin!==origin){diagnostics.rejected.push(request.url());return route.abort()}
    if(url.pathname.startsWith('/monaco/')||url.pathname==='/monaco.worker.js'){
     const asset=path.resolve(root,'packages/ui/src/renderer/public','.'+decodeURIComponent(url.pathname))
     assert(asset.startsWith(path.resolve(root,'packages/ui/src/renderer/public')+path.sep))
     return route.fulfill({path:asset})
    }
    if(!url.pathname.startsWith('/api/'))return route.continue()
    const method=request.method();diagnostics.api.push({path:url.pathname,method})
    if(url.pathname==='/api/events'&&method==='GET')return route.continue({url:events.url})
    if(/^\/api\/storage\/(config|state)\/(ui|server)$/.test(url.pathname)&&['GET','PATCH'].includes(method)){
     if(method==='PATCH')storage.set(url.pathname,merge(storage.get(url.pathname)||{},request.postDataJSON()))
     return route.fulfill({json:storage.get(url.pathname)||{}})
    }
    if(method==='GET'&&url.pathname==='/api/workspaces')return route.fulfill({json:[]})
    if(method==='GET'&&url.pathname==='/api/auth/status')return route.fulfill({json:{authenticated:true,required:false}})
    if(method==='GET'&&['/api/meta','/api/speech/capabilities'].includes(url.pathname))return route.fulfill({json:{}})
    diagnostics.rejected.push({path:url.pathname,method});return route.fulfill({status:501,json:{error:'Unknown synthetic endpoint'}})
   })
   await page.addInitScript(()=>Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}}))
   await page.emulateMedia({colorScheme:query.theme==='dark'?'dark':'light',reducedMotion:'reduce'})
   try{await page.goto(fixture.url+'?'+new URLSearchParams(query),{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.runeSourceContext?.ready,undefined,{timeout:30000});return {page,diagnostics}}
   catch(error){await page.close();throw Object.assign(error,{diagnostics})}
  },
  async close(){for(const page of pages)await page.close();await events.close();await fixture.close();await daemon.stop()}
 }
}
export function assertSourceDiagnostics(diagnostics){for(const key of ['page','console','network','rejected','resources'])assert.deepEqual(diagnostics[key],[],key)}
