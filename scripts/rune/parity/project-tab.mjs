// Actual standalone Solid InstanceTab versus the public shared Rune primitive.
import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import path from 'node:path'
import {chromium} from 'playwright'
import {createServer} from 'vite'
import solid from 'vite-plugin-solid'
import {createFixtureCache} from '../../../packages/ui/tests/browser/fixture-cache.ts'
import {createFixtureShutdown} from '../../../packages/ui/tests/browser/fixture-shutdown.ts'
import {buildInventory} from '../component-inventory.mjs'
import {privateEnvironment} from '../../../packages/rune-app/fixtures/private-profile.mjs'

const root=fileURLToPath(new URL('../../../',import.meta.url)),require=createRequire(import.meta.url)
const {values}=parseArgs({options:{binary:{type:'string'},'reuse-solid':{type:'boolean'}}})
if(values.binary)assert(path.isAbsolute(values.binary),'--binary requires an absolute gallery path')
assert(!values['reuse-solid']||values.binary,'--reuse-solid requires a native gallery')
const out=path.join(root,'target/rune-parity/project-tab');await mkdir(out,{recursive:true})
const entry=path.join(root,'scripts/rune/parity/project-tab.fixture.tsx')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const themeBytes=await readFile(path.join(root,'crates/rune-theme-codenomad/assets/theme.json')),theme=JSON.parse(themeBytes)
const inventory=await buildInventory(root),sheet=inventory.get('target/rune-inventory/components__instance-tab.json')
await writeFile(path.join(out,'instance-tab.sheet.json'),JSON.stringify(sheet,null,2)+'\n')
const provenance={source:sheet.source,sha256:sheet.sha256,fixtureSha256:hash(await readFile(entry)),themeSha256:hash(themeBytes)}
const nativeBinary=values.binary?{path:values.binary,sha256:hash(await readFile(values.binary))}:undefined
const long='Alpha · synthetic project with a deliberately long folder label that exceeds the active and inactive tab maxima'
const cases=[{name:'active',locale:'en',active:true},{name:'inactive',locale:'en',active:false},{name:'rtl',locale:'he',active:true},{name:'rtl-inactive',locale:'he',active:false},{name:'long',locale:'en',active:true,title:long},{name:'long-inactive',locale:'en',active:false,title:long},{name:'long-rtl',locale:'he',active:true,title:long}]
const records=[];let browser,server
async function execute(args,env){
  return new Promise((resolve,reject)=>{
    const child=spawn(values.binary,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log=''
    const timer=setTimeout(()=>{child.kill();reject(Error('Owned gallery exceeded 60 seconds'))},60000)
    child.on('error',error=>{clearTimeout(timer);reject(error)})
    for(const pipe of [child.stdout,child.stderr])pipe.on('data',bytes=>log=(log+bytes).slice(-1048576))
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(log):reject(Error(log))})
  })
}
function focus(tree){assert(tree.elements.some(e=>e.key==='t-tab-0'&&e.focused&&e.focusVisible),'Native real keyboard focus-visible required')}
async function capture(args,env,tree){
  // These are deterministic scene checkpoints, never wall-clock latency measurements.
  for(const at of [0.5,1,2,4]){
    const log=await execute([...args,'--at',String(at)],env),data=JSON.parse(await readFile(tree,'utf8'))
    if(!data.animating&&!data.elements.some(e=>e.moving||e.exiting))return {log,data,simulatedSceneSeconds:at}
  }
  throw Error('Native primitive failed to reach rest at the bounded scene checkpoints')
}
try{
  if(values['reuse-solid']){
    const previous=JSON.parse(await readFile(path.join(out,'evidence.json'),'utf8'))
    assert.deepEqual(previous.provenance,provenance,'Regenerate references after source/fixture/theme changes')
    assert.equal(previous.records.length,cases.length*2)
    for(const record of previous.records){assert(record.fontsReady);assert.deepEqual(record.errors,[]);assert.equal(record.states.length,4);for(const state of record.states){await readFile(path.join(out,state.alpha.file));await readFile(path.join(out,state.alpha.halo.file))}records.push({...record,priorFailure:record.failure,failure:undefined})}
  }else{
    const cache=await createFixtureCache(),shutdown=createFixtureShutdown(cache)
    const dependencyRoot=path.dirname(path.dirname(require.resolve('playwright/package.json')))
    server=await createServer({root:path.join(root,'packages/ui'),configFile:false,cacheDir:cache.cacheDir,
      plugins:[shutdown.plugin,solid(),{name:'actual-instance-tab',configureServer(s){s.middlewares.use('/rune-project-tab',async(_q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/rune-project-tab',`<html><body style="margin:0"><div id="root"></div><script type="module" src="/@fs/${entry.replaceAll('\\','/')}"></script></body></html>`))})}}],
      resolve:{dedupe:['solid-js']},optimizeDeps:{entries:[entry],include:['solid-js','solid-js/web','solid-js/store','debug'],exclude:['lucide-solid']},
      server:{host:'127.0.0.1',port:0,hmr:false,watch:null,fs:{allow:[root,dependencyRoot]}},logLevel:'error'})
    shutdown.own(server);await server.listen()
    const origin=`http://127.0.0.1:${server.httpServer.address().port}`
    browser=await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined})
    for(const config of cases)for(const palette of ['light','dark']){
      const record={...config,title:config.title??'Alpha',id:`${config.name}-${palette}`,theme:palette,errors:[],requests:[],states:[],startupReloads:0};records.push(record)
      const page=await browser.newPage({viewport:{width:900,height:200},deviceScaleFactor:1})
      page.on('pageerror',e=>record.errors.push(e.message))
      await page.route('**/*',route=>{const u=new URL(route.request().url());assert.equal(u.origin,origin,'No external requests')
        if(!u.pathname.startsWith('/api/'))return route.continue()
        const method=route.request().method();record.requests.push({method,path:u.pathname})
        if(method!=='GET'){record.errors.push('Unexpected API mutation');return route.abort('blockedbyclient')}
        return u.pathname==='/api/events'?route.fulfill({contentType:'text/event-stream',body:': isolated primitive fixture\n\n'}):route.fulfill({json:{}})
      })
      await page.emulateMedia({colorScheme:palette,reducedMotion:'reduce'})
      await page.goto(`${origin}/rune-project-tab?${new URLSearchParams({locale:record.locale,theme:palette,title:record.title,active:String(record.active)})}`)
      for(let attempt=0;attempt<3;attempt++){try{await page.waitForFunction(()=>globalThis.runeProjectTab?.ready,undefined,{timeout:15000});break}catch(e){if(attempt===2)throw e;record.startupReloads++;await page.reload()}}
      await page.evaluate(()=>document.fonts.ready);assert.equal(await page.evaluate(()=>document.fonts.status),'loaded');record.fontsReady=true
      const tab=page.getByRole('tab'),frame=page.locator('#primitive-frame')
      assert.equal(await tab.count(),1)
      const cdp=await page.context().newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable')
      const {root:dom}=await cdp.send('DOM.getDocument'),{nodeId}=await cdp.send('DOM.querySelector',{nodeId:dom.nodeId,selector:'.tab-base'})
      record.platformFonts=await cdp.send('CSS.getPlatformFontsForNode',{nodeId})
      for(const state of ['rest','hover','close-hover','focus']){
        await page.mouse.move(899,190)
        if(state==='hover')await tab.hover()
        if(state==='close-hover')await tab.locator('.tab-close').hover()
        if(state==='focus'){await tab.focus();await page.keyboard.press('Space');assert(await tab.evaluate(e=>document.activeElement===e&&e.matches(':focus-visible')))}
        const prefix=`solid-${record.id}-${state}`,file=`${prefix}.png`,haloFile=`${prefix}-halo.png`
        const png=await tab.screenshot({path:path.join(out,file),animations:'disabled'})
        await frame.screenshot({path:path.join(out,haloFile),animations:'disabled'})
        const geometry=await tab.evaluate(el=>{const b=el.getBoundingClientRect(),s=getComputedStyle(el);return {bounds:b.toJSON(),color:s.color,font:s.font,shadow:s.boxShadow,borders:[s.borderTop,s.borderRight,s.borderBottom,s.borderLeft],glyphs:Object.fromEntries(['folder','close'].map((n,i)=>{const r=el.querySelectorAll('svg')[i].getBoundingClientRect();return[n,{x:r.x-b.x,y:r.y-b.y,width:r.width,height:r.height}]}))}})
        const halo=await frame.boundingBox(),extent=theme.metrics[palette].tabFocus.extent
        assert(geometry.bounds.x-halo.x>=extent&&geometry.bounds.y-halo.y>=extent,'Full outer focus neighborhood required')
        const alpha={file,width:png.readUInt32BE(16),height:png.readUInt32BE(20),selected:await tab.getAttribute('aria-selected')==='true',glyphs:geometry.glyphs,geometry,a11y:await tab.ariaSnapshot(),halo:{file:haloFile,clip:halo,extent,provenance:'Direct actual InstanceTab with unchanged DOM/CSS; structural frame uses generated parent height/focus extent; no InstanceTabs actions are mounted'}}
        await writeFile(path.join(out,`${prefix}.aria.yml`),alpha.a11y);record.states.push({state,alpha})
      }
      await tab.locator('.tab-close').focus();await page.keyboard.press('Space')
      record.keyboardClose=await page.evaluate(()=>!runeProjectTab.state().present)
      if(!record.keyboardClose)await tab.locator('.tab-close').click()
      assert(await page.evaluate(()=>!runeProjectTab.state().present),'Actual pointer close by identity required')
      assert.deepEqual(record.errors,[]);await page.close()
    }
  }
  if(values.binary)for(const record of records)for(const state of record.states){
    const prefix=`rune-${record.id}-${state.state}`,script=path.join(out,`${prefix}.script.json`)
    const events=state.state==='hover'?[{t:0.1,type:'move',key:'t-tab-0'}]:state.state==='close-hover'?[{t:0.1,type:'move',key:'c-tab-0'}]:state.state==='focus'?[{t:0.1,type:'key',name:'Tab'},{t:0.2,type:'type',text:' '}]:[]
    await writeFile(script,JSON.stringify({events}))
    const env={...await privateEnvironment(path.join(out,'profiles',prefix)),RUNE_PARITY_LOCALE:record.locale,RUNE_PARITY_CASE:record.active?'basic':'inactive',RUNE_PARITY_TITLE:record.title,RUNE_PARITY_PRIMITIVE:'true'}
    for(const halo of [false,true]){
      const file=path.join(out,`${prefix}${halo?'-halo':''}.png`),tree=path.join(out,`${prefix}${halo?'-halo':''}.json`),a=state.alpha
      const size=halo?`${Math.ceil(a.halo.clip.width)}x${Math.ceil(a.halo.clip.height)}`:`${a.width}x${a.height}`
      const {log,data,simulatedSceneSeconds}=await capture(['--script',script,'--tree',tree,'--snap',file,'--size',size,'--theme',record.theme,'--scale','1'],{...env,RUNE_PARITY_HALO:String(halo)},tree)
      await writeFile(tree.replace(/\.json$/,'.log'),log)
      const tab=data.elements.find(e=>e.key==='t-tab-0')
      assert.equal(tab.label,record.title);assert.equal(Boolean(tab.itemSelected),a.selected)
      const contains=(outer,inner)=>inner[0]>=outer[0]&&inner[1]>=outer[1]&&Math.round((inner[0]+inner[2])*100)<=Math.round((outer[0]+outer[2])*100)&&Math.round((inner[1]+inner[3])*100)<=Math.round((outer[1]+outer[3])*100)
      const folder=data.elements.find(e=>e.role==='icon'&&e.rect[2]===theme.metrics[record.theme].tabGlyph.width)
      const text=data.elements.find(e=>e.text===record.title)
      assert(folder&&text&&contains(tab.rect,folder.rect)&&contains(tab.rect,text.rect),'Folder and truncated text must stay inside the real selection control')
      const nodes=[];function walk(n){nodes.push(n);for(const c of n.children??[])walk(c)}walk(data.accessibility)
      const accessibleTab=nodes.find(n=>n.key==='t-tab-0'&&n.role==='tab');assert(accessibleTab,'Native accessible tab required')
      assert.equal(Boolean(accessibleTab.states?.includes('selected')),a.selected,'Native accessible selection must match the real reference')
      if(state.state==='focus')focus(data)
      if(halo){a.halo.rune=file;a.halo.tree=tree;a.halo.simulatedSceneSeconds=simulatedSceneSeconds}else{a.rune=file;a.tree=tree;a.simulatedSceneSeconds=simulatedSceneSeconds}
    }
  }
  if(values.binary)for(const record of records){
    const prefix=path.join(out,`rune-${record.id}-interaction`),script=`${prefix}.script.json`,tree=`${prefix}.json`
    await writeFile(script,JSON.stringify({events:[{t:0.1,type:'tap',key:'t-tab-0'},{t:0.2,type:'key',name:'Tab'},{t:0.3,type:'type',text:' '}]}))
    const env={...await privateEnvironment(`${prefix}-profile`),RUNE_PARITY_LOCALE:record.locale,RUNE_PARITY_CASE:record.active?'basic':'inactive',RUNE_PARITY_TITLE:record.title,RUNE_PARITY_PRIMITIVE:'true'}
    const log=await execute(['--script',script,'--tree',tree,'--snap',`${prefix}.png`,'--size','900x200','--theme',record.theme,'--scale','1','--at','0.5'],env)
    await writeFile(`${prefix}.log`,log)
    assert(log.includes('project-tabs-select:tab-0')&&log.includes('project-tabs-close:tab-0'),'Real pointer selection and keyboard close by identity required')
    const data=JSON.parse(await readFile(tree,'utf8'))
    const nodes=[];function walk(n){nodes.push(n);for(const c of n.children??[])walk(c)}walk(data.accessibility)
    assert(!nodes.some(e=>e.key==='t-tab-0'||e.key==='c-tab-0'),'Closed occurrence must leave the accessibility tree')
    assert(data.elements.filter(e=>e.key==='t-tab-0'||e.key==='c-tab-0').every(e=>e.exiting&&e.inert&&!e.focusable),'Any exit-animation nodes must be inert')
    record.nativeInteraction={tree,pointerSelectById:true,keyboardCloseById:true}
  }
}catch(error){if(records.length)records.at(-1).failure=error.message;throw error}
finally{
  await browser?.close();await server?.close()
  await writeFile(path.join(out,'evidence.json'),JSON.stringify({status:records.some(r=>r.failure)?'blocked':values.binary?'paired-captures-require-review':'actual-solid-only',component:'plain-instance-tab',wholeInstanceTabs:'pending',provenance,nativeBinary,records,findings:records.filter(r=>r.keyboardClose===false).map(r=>({id:r.id,contract:'Solid close Space',result:'failed',nativeRequirement:'Accessible keyboard close retained'})),pending:['Reviewed regional budgets and negative-control rejection','Independent blind reviews','Status/remote/temporary/rename contexts','Physical mobile qualification']},null,2)+'\n')
}
console.log(out)
