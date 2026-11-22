import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'
import {borrowFixture} from '../../../packages/ui/tests/browser/fixture-borrow.ts'
import {startRunDaemon} from '../../../packages/ui/tests/browser/fixture-daemon/run.ts'
import {armFixtureNavigationBudget} from '../../../packages/ui/tests/browser/fixture-navigation-budget.ts'
import {fixtureEventStream} from '../../../packages/ui/tests/browser/fixture-event-stream.ts'
import {prepareGitPrototypeAssets} from '../../../packages/ui/tests/browser/fixtures/git-history-assets.mjs'
import {readerScenes} from './workspace-reader-scenes.mjs'

const root=fileURLToPath(new URL('../../../',import.meta.url)),out=path.join(root,'target/rune-parity/workspace-reader')
await mkdir(out,{recursive:true})
prepareGitPrototypeAssets()
const sources=['packages/ui/src/components/files-preview-view.tsx','packages/ui/src/components/workspace-file-view.tsx','packages/ui/src/components/workspace-file-editor.ts','packages/ui/src/components/file-viewer/monaco-file-viewer.tsx','packages/ui/src/styles/tokens.css','packages/ui/src/styles/panels/workspace-tree.css','packages/ui/src/styles/panels/git-history.css','packages/ui/src/styles/panels/right-panel.css','packages/ui/src/styles/panels/file-row-actions.css','packages/ui/src/styles/components/window.css','packages/ui/src/styles/utilities.css','scripts/rune/parity/workspace-reader.fixture.tsx','scripts/rune/parity/workspace-reader-scenes.mjs','scripts/rune/parity/workspace-reader.mjs','node_modules/@mermaid-js/tiny/LICENSE','node_modules/@mermaid-js/tiny/dist/mermaid.tiny.js']
const provenance=Object.fromEntries(await Promise.all(sources.map(async source=>[source,createHash('sha256').update(await readFile(path.join(root,source))).digest('hex')])))
const daemon=await startRunDaemon({uiRoot:path.join(root,'packages/ui'),warmup:false,logPrefix:'codenomad-rune-reader-'})
const fixture=await borrowFixture({name:'rune-workspace-reader',routes:[{path:'/reader',html:'<html><body style="margin:0"><div id="root"></div><script type="module" src="/@fs/'+path.join(root,'scripts/rune/parity/workspace-reader.fixture.tsx').replaceAll('\\','/')+'"></script></body></html>'}]},{endpoint:daemon})
const events=await fixtureEventStream(fixture.url)
const origin=new URL(fixture.url).origin,records=[],interactions=[],startup=[],forbidden=[]
let browser,failure,decoding
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined})
  armFixtureNavigationBudget(browser)
  async function setup(theme,rtl,width,scene='utf8'){
    const page=await browser.newPage({viewport:{width,height:640},deviceScaleFactor:1,locale:rtl?'he-IL':'en-US'})
    page.setDefaultTimeout(20000)
    const diagnostics={page:[],console:[],network:[],api:[],modules:[],rawAssets:[]},storage=new Map()
    page.on('pageerror',e=>diagnostics.page.push(e.message))
    page.on('console',message=>{if(message.type()==='error')diagnostics.console.push({text:message.text(),location:message.location()})})
    page.on('response',response=>{if(/mermaid|LICENSE/.test(response.url()))diagnostics.modules.push({url:response.url(),status:response.status(),headers:response.headers()})})
    page.on('requestfailed',request=>diagnostics.network.push({url:request.url(),error:request.failure()?.errorText}))
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url())
      if(url.origin!==origin){forbidden.push(request.url());return route.abort()}
      // Vite serves junction-resolved dependencies outside its root statically; retain ?raw's exact byte-to-export contract.
      const raw=/\/@mermaid-js\/tiny\/(LICENSE|dist\/mermaid\.tiny\.js)$/.exec(url.pathname)
      if(raw&&url.searchParams.has('raw')){
        const source=await readFile(path.join(root,'node_modules/@mermaid-js/tiny',raw[1]),'utf8')
        diagnostics.rawAssets.push(raw[1])
        return route.fulfill({contentType:'text/javascript',body:'export default '+JSON.stringify(source)+';\n'})
      }
      if(url.pathname.startsWith('/monaco/')||url.pathname==='/monaco.worker.js'){
        const asset=path.resolve(root,'packages/ui/src/renderer/public','.'+decodeURIComponent(url.pathname))
        assert(asset.startsWith(path.resolve(root,'packages/ui/src/renderer/public')+path.sep))
        return route.fulfill({path:asset})
      }
      if(!url.pathname.startsWith('/api/'))return route.continue()
      diagnostics.api.push({method:request.method(),path:url.pathname})
      if(url.pathname==='/api/events')return route.continue({url:events.url})
      if(url.pathname.startsWith('/api/storage/')){
        const previous=storage.get(url.pathname)||{}
        const merge=(a,b)=>Object.fromEntries([...new Set([...Object.keys(a),...Object.keys(b)])].map(k=>[k,b[k]&&typeof b[k]==='object'&&!Array.isArray(b[k])?merge(a[k]||{},b[k]):k in b?b[k]:a[k]]))
        if(request.method()==='PATCH')storage.set(url.pathname,merge(previous,request.postDataJSON()))
        return route.fulfill({json:storage.get(url.pathname)||{}})
      }
      if(url.pathname==='/api/panel-extensions'||url.pathname==='/api/workspaces')return route.fulfill({json:[]})
      if(url.pathname==='/api/auth/status')return route.fulfill({json:{authenticated:true,required:false}})
      return route.fulfill({json:{}})
    })
    await page.addInitScript(()=>Object.assign(window,{__CODENOMAD_RUNTIME_HOST__:'electron',__CODENOMAD_WINDOW_CONTEXT__:'local',electronAPI:{claimClientStateAccess:async()=>true,loadClientState:async()=>({isPrimary:true,restoreEnabled:true,snapshot:null}),saveClientState:async()=>true}}))
    await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'})
    await page.goto(fixture.url+'?'+new URLSearchParams({theme,rtl:String(rtl),scene}),{waitUntil:'domcontentloaded'})
    await page.waitForFunction(()=>window.runeWorkspaceReader?.ready)
    await page.evaluate(()=>document.fonts.ready)
    assert.equal(await page.locator('html').getAttribute('dir'),rtl?'rtl':'ltr')
    return {page,diagnostics}
  }
  async function ready(page,scene){
    const reader=page.locator('.workspace-file-view')
    await reader.locator('strong').filter({hasText:readerScenes[scene].path}).waitFor()
    if(scene==='loading')return
    if(scene==='error'){await reader.getByRole('alert').waitFor();return}
    if(['nul','malformed'].includes(scene)){await reader.locator('div.text-secondary').filter({hasText:/./}).waitFor();assert.equal(await reader.locator('.monaco-editor').count(),0);return}
    if(['png','svg'].includes(scene)){await page.waitForFunction(()=>{const image=document.querySelector('.workspace-image img');return image?.complete&&image.naturalWidth>0});return}
    if(scene.startsWith('mermaid')){await reader.locator(scene==='mermaid'?'.mermaid-diagram img':'.mermaid-error').waitFor();if(scene==='mermaid')await page.waitForFunction(()=>{const image=document.querySelector('.mermaid-diagram img');return image?.complete&&image.naturalWidth>0});return}
    if(scene.startsWith('markdown')){await reader.locator('.workspace-markdown h1').waitFor();return}
    await page.waitForFunction(path=>{const e=window.monaco?.editor.getEditors().find(e=>e.getModel()?.uri.toString().includes('workspace-editor'));return e&&decodeURIComponent(e.getModel().uri.toString()).endsWith(path)},readerScenes[scene].path)
    await reader.locator('.view-lines').waitFor()
  }
  async function capture(page,id,scene,theme,rtl,width){
    try{await ready(page,scene)}catch(error){await writeFile(path.join(out,'failed-dom.html'),await page.content());await writeFile(path.join(out,'failed-state.json'),JSON.stringify(await page.evaluate(()=>({fixture:window.runeWorkspaceReader.state(),editors:window.monaco?.editor.getEditors().map(e=>({uri:e.getModel()?.uri.toString(),text:e.getValue()}))})),null,2));await page.screenshot({path:path.join(out,'failed.png')});throw error}
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    const reader=page.locator('.workspace-file-view'),record={id,scene,theme,rtl,width}
    records.push(record)
    record.a11y=await reader.ariaSnapshot()
    record.geometry=await reader.evaluate(el=>({reader:el.getBoundingClientRect().toJSON(),header:el.querySelector('header').getBoundingClientRect().toJSON(),theme:document.documentElement.dataset.theme,dir:document.documentElement.dir,font:getComputedStyle(el).font,background:getComputedStyle(el).backgroundColor,buttons:[...el.querySelectorAll('header button')].map(e=>({name:e.getAttribute('aria-label')||e.textContent,disabled:e.disabled,pressed:e.getAttribute('aria-pressed'),bounds:e.getBoundingClientRect().toJSON()}))}))
    record.metrics=await reader.evaluate(el=>{
      const measure=node=>{if(!node)return null;const style=getComputedStyle(node),properties=['font','fontFamily','fontSize','fontWeight','lineHeight','padding','paddingInlineStart','paddingInlineEnd','gap','rowGap','columnGap','border','borderBottom','color','backgroundColor','display','alignItems','justifyContent','flexWrap','minWidth','minHeight','width','height','overflow','overflowX','overflowY','borderRadius'];return {bounds:node.getBoundingClientRect().toJSON(),css:Object.fromEntries(properties.map(key=>[key,style[key]]))}}
      return {reader:measure(el),header:measure(el.querySelector('header')),heading:measure(el.querySelector('.git-diff-heading')),title:measure(el.querySelector('.git-diff-heading strong')),path:measure(el.querySelector('.git-diff-heading > span')),toolbarButtons:[...el.querySelectorAll('.file-viewer-toolbar-button')].map(measure),iconButtons:[...el.querySelectorAll('.files-header-icon-button')].map(measure),content:measure(el.querySelector('.git-diff-content')),editor:measure(el.querySelector('.monaco-editor')),icons:[...el.querySelectorAll('header svg')].map(svg=>({geometry:measure(svg),markup:svg.outerHTML}))}
    })
    record.model=await page.evaluate(()=>{const e=window.monaco?.editor.getEditors().find(e=>e.getModel()?.uri.toString().includes('workspace-editor'));return e?{text:e.getValue(),eol:e.getModel().getEOL(),language:e.getModel().getLanguageId(),selection:e.getSelection(),scrollTop:e.getScrollTop(),scrollLeft:e.getScrollLeft(),wrap:e.getRawOptions().wordWrap}:null})
    record.state=await page.evaluate(()=>window.runeWorkspaceReader.state())
    decoding??=await page.evaluate(()=>window.runeWorkspaceReader.decoded())
    if(['utf8','empty','longline'].includes(scene))assert.equal(record.model.text,readerScenes[scene].text)
    if(['bom','doublebom'].includes(scene))assert.equal(record.model.text,'A','Monaco projection treats its leading FEFF as model BOM')
    record.ax=await(await page.context().newCDPSession(page)).send('Accessibility.getFullAXTree')
    await reader.screenshot({path:path.join(out,'solid-'+id+'.png'),animations:'disabled'})
    await writeFile(path.join(out,'solid-'+id+'.aria.yml'),record.a11y)
    return record
  }
  const smoke=process.argv.includes('--smoke'),one=process.argv.indexOf('--scene'),core=one>=0?[process.argv[one+1]]:smoke?['utf8','empty']:['utf8','empty','longline','loading','error','nul']
  for(const theme of smoke?['light']:['light','dark'])for(const rtl of smoke?[false]:[false,true])for(const width of smoke?[960]:[960,360]){
    const {page,diagnostics}=await setup(theme,rtl,width)
    try{
      for(const scene of core){if(scene!=='utf8')await page.evaluate(scene=>window.runeWorkspaceReader.open(scene),scene);await capture(page,`${theme}-${rtl?'rtl':'ltr'}-${width}-${scene}`,scene,theme,rtl,width)}
      assert.deepEqual(diagnostics.page,[])
      assert.deepEqual(diagnostics.console,[])
      assert.deepEqual(diagnostics.network,[])
    }finally{startup.push({theme,rtl,width,diagnostics});await page.close()}
  }
  if(!smoke){
    for(const theme of ['light','dark']){
      const {page,diagnostics}=await setup(theme,false,960)
      try{for(const scene of ['bom','doublebom','malformed','markdown','markdownAlias','mermaid','mermaidError','svg','png']){await page.evaluate(scene=>window.runeWorkspaceReader.open(scene),scene);await capture(page,`${theme}-ltr-960-${scene}`,scene,theme,false,960)}assert.deepEqual(diagnostics.page,[]);assert.deepEqual(diagnostics.console,[]);assert.deepEqual(diagnostics.network,[])}finally{startup.push({theme,diagnostics});await page.close()}
    }
    const {page,diagnostics}=await setup('light',false,960,'conflict')
    try{
      await ready(page,'conflict')
      await page.locator('.monaco-editor textarea').focus();await page.keyboard.press('Control+Home');await page.keyboard.type('local ')
      const save=page.locator('header button[aria-label="Save"]');await save.waitFor();assert(await save.isEnabled())
      await page.evaluate(()=>window.runeWorkspaceReader.external('external\n'))
      await save.click();await page.getByRole('dialog').waitFor();await page.screenshot({path:path.join(out,'solid-conflict-dialog.png')})
      interactions.push({case:'conflict-before-cancel',a11y:await page.getByRole('dialog').ariaSnapshot(),state:await page.evaluate(()=>window.runeWorkspaceReader.state())})
      await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await page.evaluate(()=>window.runeWorkspaceReader.state())).calls.filter(c=>c.kind==='write').length,0)
      await save.click();await page.getByRole('button',{name:'Overwrite',exact:true}).click()
      await page.waitForFunction(()=>window.runeWorkspaceReader.state().calls.some(c=>c.kind==='write'))
      const state=await page.evaluate(()=>window.runeWorkspaceReader.state()),write=state.calls.find(c=>c.kind==='write');assert.equal(write.expectedVersion,'v2');assert.equal(write.text,'local baseline\n');assert.equal(write.directory,'/trial-rune-reader')
      interactions.push({case:'conflict-overwrite',write})
      await page.evaluate(()=>window.runeWorkspaceReader.open('longline'));await ready(page,'longline')
      const wrap=page.locator('header button[aria-pressed]');assert.equal(await wrap.getAttribute('aria-pressed'),'false');await wrap.click()
      assert.equal(await wrap.getAttribute('aria-pressed'),'true')
      interactions.push({case:'wrap-on',model:await page.evaluate(()=>window.monaco.editor.getEditors().at(-1).getRawOptions().wordWrap)})
      assert.equal(interactions.at(-1).model,'on')
      await page.evaluate(()=>window.runeWorkspaceReader.open('utf8'));await ready(page,'utf8')
      await page.locator('.monaco-editor textarea').focus();await page.keyboard.press('Control+End');await page.keyboard.press('Shift+Home')
      const selected=await page.evaluate(()=>{const e=window.monaco.editor.getEditors().at(-1);return {selection:e.getSelection(),text:e.getModel().getValueInRange(e.getSelection()),scroll:e.getScrollTop()}});assert(selected.text.length>0);assert(selected.scroll>0)
      interactions.push({case:'keyboard-scroll-selection',selected,clipboardUsed:false})
      await page.evaluate(()=>window.runeWorkspaceReader.open('loading'));await ready(page,'loading');await page.evaluate(()=>window.runeWorkspaceReader.release())
      await page.waitForFunction(()=>window.monaco.editor.getEditors().some(e=>e.getValue()==='held content\n'))
      interactions.push({case:'held-read-release',state:await page.evaluate(()=>window.runeWorkspaceReader.state())})
      await page.evaluate(()=>window.runeWorkspaceReader.open('error'));await ready(page,'error');await page.locator('.workspace-file-view > [role="alert"] button').click()
      await page.waitForFunction(()=>window.monaco.editor.getEditors().some(e=>e.getValue()==='recovered\n'))
      assert.equal(await page.locator('.workspace-file-view > [role="alert"]').count(),0)
      interactions.push({case:'error-retry',state:await page.evaluate(()=>window.runeWorkspaceReader.state())})
      await page.locator('header button').last().click();assert.equal(await page.locator('.workspace-file-view').count(),0)
      interactions.push({case:'close',state:await page.evaluate(()=>window.runeWorkspaceReader.state())})
      assert.deepEqual(diagnostics.page,[]);assert.deepEqual(diagnostics.console,[])
    }finally{startup.push({interactions:true,diagnostics});await page.close()}
  }
  assert.deepEqual(forbidden,[])
}catch(error){failure={message:error.message,stack:error.stack};throw error}
finally{await browser?.close();await events.close();await fixture.close();await daemon.stop();await writeFile(path.join(out,'solid-evidence.json'),JSON.stringify({provenance,records,decoding,interactions,startup,forbidden,failure,limits:['No Rune comparison in this runner','No OS clipboard usage','Synthetic in-memory Files API; no real backend']},null,2)+'\n')}
console.log(`Workspace Source: ${records.length} captures, ${interactions.length} interactions; ${out}`)
