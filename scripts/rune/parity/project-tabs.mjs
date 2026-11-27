// node --import tsx scripts/rune/parity/project-tabs.mjs [--rune-dir ABS --max-diff-ratio REVIEWED]
import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {spawnFixtureChild as spawn} from '../../native-fixture-guards.mjs'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {createServer} from 'vite'
import solid from 'vite-plugin-solid'
import {createFixtureCache} from '../../../packages/ui/tests/browser/fixture-cache.ts'
import {createFixtureShutdown} from '../../../packages/ui/tests/browser/fixture-shutdown.ts'
import {buildInventory} from '../component-inventory.mjs'
import {privateEnvironment} from '../../../packages/rune-app/fixtures/private-profile.mjs'

const root=fileURLToPath(new URL('../../../',import.meta.url)),require=createRequire(import.meta.url)
const {values}=parseArgs({options:{binary:{type:'string'},'rune-dir':{type:'string'},'max-diff-ratio':{type:'string'},'max-alpha-diff-ratio':{type:'string'},'reuse-solid':{type:'boolean'}}})
assert(!values['reuse-solid']||values.binary,'--reuse-solid requires the real gallery binary')
assert(!values['rune-dir']||values['max-diff-ratio'],'Actual Rune comparisons require an explicit reviewed pixel threshold')
assert(!values['max-diff-ratio']||values['rune-dir']||values.binary,'Pixel comparisons require actual Rune captures')
if(values.binary)assert(path.isAbsolute(values.binary),'Standalone gallery binary must be absolute')
if(values['max-alpha-diff-ratio'])assert((values.binary||values['rune-dir'])&&Number(values['max-alpha-diff-ratio'])>=0&&Number(values['max-alpha-diff-ratio'])<1,'Alpha pixel comparison requires actual captures and a reviewed threshold')
if(values['rune-dir'])assert(path.isAbsolute(values['rune-dir'])&&Number(values['max-diff-ratio'])>=0&&Number(values['max-diff-ratio'])<1)
const out=path.join(root,'target/rune-parity/project-tabs');await mkdir(out,{recursive:true})
const themeContract=JSON.parse(await readFile(path.join(root,'crates/rune-theme-codenomad/assets/theme.json'),'utf8'))
const focusEvents=[{t:0.1,type:'key',name:'Tab'},{t:0.15,type:'key',name:'Home'},{t:0.2,type:'type',text:' '}]
function assertKeyboardFocus(tree){assert(tree.elements.some(e=>e.key==='t-tab-0'&&e.focused&&e.focusVisible),'Real keyboard focus and focus-visible are required')}
async function execute(program,args,env=process.env){
  return new Promise((resolve,reject)=>{
    const child=spawn(program,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log=''
    const timer=setTimeout(()=>{child.kill();reject(Error('Owned parity child exceeded 60 seconds'))},60000)
    child.on('error',error=>{clearTimeout(timer);reject(error)})
    for(const pipe of [child.stdout,child.stderr])pipe.on('data',bytes=>log=(log+bytes).slice(-1048576))
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(log):reject(Error(log))})
  })
}
const inventory=await buildInventory(root),sheets=[]
for(const name of ['instance-tabs','instance-tab','tab-scroll']){
  const sheet=inventory.get(`target/rune-inventory/components__${name}.json`)
  assert(sheet,`Missing real AST sheet for ${name}`)
  const source=await readFile(path.join(root,sheet.source),'utf8')
  assert.equal(createHash('sha256').update(source.replaceAll('\r\n','\n')).digest('hex'),sheet.sha256)
  await writeFile(path.join(out,`${name}.sheet.json`),JSON.stringify(sheet,null,2));sheets.push({source:sheet.source,sha256:sheet.sha256})
}
const cache=await createFixtureCache(),shutdown=createFixtureShutdown(cache)
const entry=path.join(root,'scripts/rune/parity/project-tabs.fixture.tsx')
const dependencyRoot=path.dirname(path.dirname(require.resolve('playwright/package.json')))
let html=''
const server=await createServer({root:path.join(root,'packages/ui'),configFile:false,cacheDir:cache.cacheDir,
  plugins:[shutdown.plugin,solid(),{name:'real-project-tabs-fixture',configureServer(s){s.middlewares.use('/rune-project-tabs',async(req,res)=>{res.setHeader('content-type','text/html');res.end(await s.transformIndexHtml('/rune-project-tabs',html))})}}],
  resolve:{dedupe:['solid-js']},optimizeDeps:{entries:[entry],include:['solid-js','solid-js/web','solid-js/store','debug'],exclude:['lucide-solid']},
  server:{host:'127.0.0.1',port:0,hmr:false,watch:null,fs:{allow:[root,dependencyRoot]}},logLevel:'error'})
shutdown.own(server)
let browser
const records=[]
let reusedSolid
try{
  html=`<html><body style="margin:0"><div id="root"></div><script type="module" src="/@fs/${entry.replaceAll('\\','/')}"></script></body></html>`
  await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`
  if(values['reuse-solid']){
    const raw=await readFile(path.join(out,'evidence.json'),'utf8'),prior=JSON.parse(raw)
    assert.deepEqual(prior.sheets,sheets,'Regenerate Solid references after source changes')
    assert.equal(prior.records.length,10)
    for(const record of prior.records){
      assert.equal(record.states.length,4);assert.deepEqual(record.errors,[])
      for(const state of record.states){await readFile(path.join(out,state.solid));if(record.scene!=='overflow'){assert(state.alpha?.halo&&state.alpha.glyphs);await readFile(path.join(out,state.alpha.file));await readFile(path.join(out,state.alpha.halo.file))}}
      records.push({...record,priorAttemptFailure:record.failure,failure:undefined})
    }
    reusedSolid={sha256:createHash('sha256').update(raw).digest('hex'),sheets}
  }else{
  browser=await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined})
  const words=JSON.parse(await readFile(path.join(root,'crates/rune-theme-codenomad/assets/catalogues/en.json'),'utf8'))
  for(const config of [{name:'desktop',width:900,locale:'en',scene:'basic'},{name:'phone-emulated',width:390,locale:'en',scene:'basic'},{name:'rtl',width:900,locale:'he',scene:'basic'},{name:'inactive',width:900,locale:'en',scene:'inactive'},{name:'overflow',width:390,locale:'en',scene:'overflow'}]){
    for(const theme of ['light','dark']){
      const id=`${config.name}-${theme}`,page=await browser.newPage({viewport:{width:config.width,height:200},deviceScaleFactor:1,hasTouch:config.name==='phone-emulated',isMobile:config.name==='phone-emulated'})
      const record={id,theme,...config,errors:[],requests:[],states:[],checks:{},startupReloads:0};records.push(record)
      page.on('pageerror',error=>record.errors.push(error.message))
      page.on('console',message=>{if(message.type()==='error')console.error(message.text())})
      await page.route('**/*',route=>{
        const url=new URL(route.request().url());assert.equal(url.origin,origin,'No external fixture request')
        if(/^\/api\//.test(url.pathname)){
          const method=route.request().method();record.requests.push({method,path:url.pathname})
          if(method!=='GET'){record.errors.push(`Unexpected fixture mutation: ${method} ${url.pathname}`);return route.abort('blockedbyclient')}
          if(url.pathname==='/api/events')return route.fulfill({contentType:'text/event-stream',body:': isolated UI fixture\n\n'})
          return route.fulfill({json:{}})
        }
        return route.continue()
      })
      await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'})
      await page.goto(`${origin}/rune-project-tabs?locale=${config.locale}&case=${config.scene}`)
      // As in window-close.mjs, a cold owned Vite cache can invalidate its first module URLs.
      for(let attempt=0;attempt<3;attempt++){
        try{await page.waitForFunction(()=>globalThis.runeProjectTabs?.ready,undefined,{timeout:15000});break}
        catch(error){if(attempt===2)throw error;record.startupReloads++;await page.reload()}
      }
      await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme)
      await page.evaluate(()=>document.fonts.ready)
      assert.equal(await page.evaluate(()=>document.fonts.status),'loaded')
      record.fontsReady=true
      const strip=page.locator('.tab-bar-instance');await strip.waitFor()
      const tabs=page.getByRole('tab'),first=tabs.first()
      assert.equal(await tabs.count(),config.scene==='overflow'?8:2)
      assert.equal(await first.getAttribute('aria-selected'),config.scene==='inactive'?'false':'true')
      for(const state of ['rest','hover','close-hover','focus']){
        await page.mouse.move(config.width-1,190)
        if(state==='hover')await tabs.nth(1).hover()
        if(state==='close-hover')await first.locator('.tab-close').hover()
        if(state==='focus'){await first.focus();await page.keyboard.press('Space');assert(await first.evaluate(e=>document.activeElement===e&&e.matches(':focus-visible')),'Focus capture requires real keyboard focus-visible')}
        const filename=`solid-${id}-${state}.png`;await strip.screenshot({path:path.join(out,filename),animations:'disabled'})
        const a11y=await strip.ariaSnapshot();await writeFile(path.join(out,`solid-${id}-${state}.aria.yml`),a11y)
        const geometry=await strip.evaluate(el=>({bounds:el.getBoundingClientRect().toJSON(),tabs:[...el.querySelectorAll('[role=tab]')].map(tab=>{const s=getComputedStyle(tab);return {label:tab.textContent,selected:tab.getAttribute('aria-selected'),bounds:tab.getBoundingClientRect().toJSON(),font:s.font,fontSize:s.fontSize,lineHeight:s.lineHeight,background:s.backgroundColor,color:s.color,borderRadius:s.borderRadius}})}))
        const item={state,solid:filename,a11y,geometry};record.states.push(item)
        if(config.scene!=='overflow'){
          if(state==='hover')await first.hover()
          const file=`solid-alpha-${id}-${state}.png`;let png,retries=0
          for(let attempt=0;attempt<3;attempt++){
            try{png=await first.screenshot({path:path.join(out,file),animations:'disabled'});break}
            catch(error){if(attempt===2||!error.message.includes('not attached'))throw error;retries++;await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));if(state==='hover')await first.hover();if(state==='close-hover')await first.locator('.tab-close').hover()}
          }
          const bounds=await first.boundingBox()
          item.alpha={file,bounds,retries,width:png.readUInt32BE(16),height:png.readUInt32BE(20),selected:await first.getAttribute('aria-selected')==='true',a11y:await first.ariaSnapshot()}
          item.alpha.glyphs=await first.evaluate(el=>Object.fromEntries(['folder','close'].map((name,i)=>{const r=el.querySelectorAll('svg')[i].getBoundingClientRect(),b=el.getBoundingClientRect();return[name,{x:r.x-b.x,y:r.y-b.y,width:r.width,height:r.height}]})))
          const extent=themeContract.metrics[theme].tabFocus.extent
          const clip={x:Math.floor(bounds.x-extent),y:Math.floor(bounds.y-extent),width:Math.ceil(bounds.width+2*extent),height:Math.ceil(bounds.height+2*extent)}
          assert(clip.x>=0&&clip.y>=0,'The real component focus neighborhood must fit in the page')
          const haloFile=`solid-alpha-halo-${id}-${state}.png`
          await page.screenshot({path:path.join(out,haloFile),clip,animations:'disabled'})
          item.alpha.halo={file:haloFile,clip,extent,component:{x:bounds.x-clip.x,y:bounds.y-clip.y,width:bounds.width,height:bounds.height},provenance:'Unmodified page pixels around actual InstanceTab, including neighboring components and parent clipping'}
          await writeFile(path.join(out,`solid-alpha-${id}-${state}.aria.yml`),item.alpha.a11y)
        }
      }
      if(config.scene==='basic'){
        await tabs.nth(1).click();assert.equal((await page.evaluate(()=>runeProjectTabs.state())).active,'tab-1');record.checks.pointerSelect=true
        await first.focus();await page.keyboard.press('Enter');assert.equal((await page.evaluate(()=>runeProjectTabs.state())).active,'tab-0');record.checks.keyboardSelect=true
        const catalogue=config.locale==='en'?words:JSON.parse(await readFile(path.join(root,`crates/rune-theme-codenomad/assets/catalogues/${config.locale}.json`),'utf8'))
        const close=first.getByRole('button',{name:catalogue['instanceTab.actions.close.ariaLabel'],exact:true})
        await close.focus();await page.keyboard.press('Space')
        record.checks.keyboardClose=(await page.evaluate(()=>runeProjectTabs.state())).actions.some(a=>a.type==='close'&&a.id==='tab-0')
        if(!record.checks.keyboardClose)await close.click()
        assert((await page.evaluate(()=>runeProjectTabs.state())).actions.some(a=>a.type==='close'&&a.id==='tab-0'));record.checks.pointerOrKeyboardClose=true
        const add=page.getByRole('button',{name:catalogue['instanceTabs.new.ariaLabel'],exact:true})
        await add.click();await add.focus();await page.keyboard.press('Enter');await page.keyboard.press('Space')
        assert.equal((await page.evaluate(()=>runeProjectTabs.state())).actions.filter(a=>a.type==='new').length,3);record.checks.newPointerEnterSpace=true
      }
      assert.deepEqual(record.errors,[])
      await page.close()
    }
  }
  }
  if(values.binary)for(const record of records)for(const state of record.states){
    const prefix=`rune-${record.id}-${state.state}`,tree=path.join(out,`${prefix}.json`),snap=path.join(out,`${prefix}.png`),script=path.join(out,`${prefix}.script.json`)
    const bounds=state.geometry.bounds;assert(Number.isInteger(bounds.width)&&Number.isInteger(bounds.height),'Use the actual integer Solid crop dimensions')
    const events=state.state==='hover'?[{t:0.1,type:'move',key:'t-tab-1'}]:state.state==='close-hover'?[{t:0.1,type:'move',key:'c-tab-0'}]:state.state==='focus'?focusEvents:[]
    await writeFile(script,JSON.stringify({events}))
    const env={...await privateEnvironment(path.join(out,'native-profiles',prefix)),RUNE_PARITY_LOCALE:record.locale,RUNE_PARITY_CASE:record.scene}
    const log=await execute(values.binary,['--script',script,'--tree',tree,'--snap',snap,'--size',`${bounds.width}x${bounds.height}`,'--theme',record.theme,'--scale','1','--at','0.5'],env)
    await writeFile(path.join(out,`${prefix}.log`),log)
    const actual=JSON.parse(await readFile(tree,'utf8')),nodes=[]
    function walk(node){if(!node)return;nodes.push(node);for(const child of node.children??[])walk(child)}walk(actual.accessibility)
    const tabs=nodes.filter(n=>n.role==='tab');assert.equal(tabs.length,record.scene==='overflow'?8:2)
    assert.equal(tabs.filter(n=>n.states?.includes('selected')).length,1)
    assert(tabs.every(n=>n.actions?.includes('click')&&n.actions?.includes('focus')))
    assert.equal(nodes.filter(n=>n.key?.startsWith('c-')&&n.role==='button').length,tabs.length)
    if(state.state==='focus')assertKeyboardFocus(actual)
    assert(nodes.some(n=>n.key==='project-tabs-new'&&n.role==='button'))
    state.rune=snap;state.nativeTabs=tabs.map(n=>({key:n.key,name:n.name,states:n.states,bounds:n.bounds}))
  }
  if(values.binary)for(const record of records)for(const state of record.states.filter(s=>s.alpha)){
    const prefix=`rune-alpha-${record.id}-${state.state}`,tree=path.join(out,`${prefix}.json`),snap=path.join(out,`${prefix}.png`),script=path.join(out,`${prefix}.script.json`)
    const events=state.state==='hover'?[{t:0.1,type:'move',key:'t-tab-0'}]:state.state==='close-hover'?[{t:0.1,type:'move',key:'c-tab-0'}]:state.state==='focus'?focusEvents:[]
    await writeFile(script,JSON.stringify({events}))
    const env={...await privateEnvironment(path.join(out,'native-profiles',prefix)),RUNE_PARITY_LOCALE:record.locale,RUNE_PARITY_CASE:record.scene,RUNE_PARITY_PRIMITIVE:'true'}
    const log=await execute(values.binary,['--script',script,'--tree',tree,'--snap',snap,'--size',`${state.alpha.width}x${state.alpha.height}`,'--theme',record.theme,'--scale','1','--at','0.5'],env)
    await writeFile(path.join(out,`${prefix}.log`),log)
    const actual=JSON.parse(await readFile(tree,'utf8')),nodes=[]
    if(state.state==='focus')assertKeyboardFocus(actual)
    function walk(n){if(!n)return;nodes.push(n);for(const c of n.children??[])walk(c)}walk(actual.accessibility)
    const tabs=nodes.filter(n=>n.role==='tab');assert.equal(tabs.length,1)
    assert.equal(Boolean(tabs[0].states?.includes('selected')),state.alpha.selected)
    assert(nodes.some(n=>n.key==='c-tab-0'&&n.role==='button'))
    state.alpha.rune=snap;state.alpha.tree=tree;state.alpha.nativeTabs=tabs
    assert(state.alpha.halo,'Regenerate real Solid focus-neighborhood references')
    const halo=state.alpha.halo,haloSnap=path.join(out,`${prefix}-halo.png`),haloTree=path.join(out,`${prefix}-halo.json`)
    await execute(values.binary,['--script',script,'--tree',haloTree,'--snap',haloSnap,'--size',`${halo.clip.width}x${halo.clip.height}`,'--theme',record.theme,'--scale','1','--at','0.5'],{...env,RUNE_PARITY_HALO:'true'})
    if(state.state==='focus')assertKeyboardFocus(JSON.parse(await readFile(haloTree,'utf8')))
    halo.rune=haloSnap;halo.tree=haloTree
  }
  if(values.binary)for(const record of records.filter(r=>r.scene==='basic')){
    const prefix=`rune-${record.id}-interaction`,tree=path.join(out,`${prefix}.json`),snap=path.join(out,`${prefix}.png`),script=path.join(out,`${prefix}.script.json`),bounds=record.states[0].geometry.bounds
    await writeFile(script,JSON.stringify({events:[{t:0.1,type:'tap',key:'t-tab-1'},{t:0.2,type:'tap',key:'c-tab-0'},{t:0.3,type:'tap',key:'project-tabs-new'}]}))
    const env={...await privateEnvironment(path.join(out,'native-profiles',prefix)),RUNE_PARITY_LOCALE:record.locale,RUNE_PARITY_CASE:'basic'}
    const log=await execute(values.binary,['--script',script,'--tree',tree,'--snap',snap,'--size',`${bounds.width}x${bounds.height}`,'--theme',record.theme,'--scale','1','--at','0.5'],env)
    await writeFile(path.join(out,`${prefix}.log`),log)
    assert.deepEqual(log.split(/\r?\n/).filter(line=>line.startsWith('project-tabs-select:')),['project-tabs-select:tab-1'])
    assert(log.includes('project-tabs-close:tab-0')&&log.includes('project-tabs-new'))
    const actual=JSON.parse(await readFile(tree,'utf8')),nodes=[]
    function walk(node){if(!node)return;nodes.push(node);for(const child of node.children??[])walk(child)}walk(actual.accessibility)
    const tabs=nodes.filter(n=>n.role==='tab');assert.equal(tabs.length,2)
    assert(tabs.some(n=>n.key==='t-tab-1')&&!tabs.some(n=>n.key==='t-tab-0'))
    assert(tabs.some(n=>n.key==='t-blank-2'&&n.states?.includes('selected')))
    record.nativeInteraction={tree,snap,selectById:true,closeById:true,newSelected:true}
  }
  if(values['max-diff-ratio'])for(const record of records)for(const state of record.states){
    const rune=path.join(values['rune-dir']??out,`rune-${record.id}-${state.state}.png`)
    await readFile(rune)
    await execute(process.execPath,[path.join(root,'scripts/rune/qualify-pixels.mjs'),'--component','project-tabs','--theme',record.theme,'--solid',path.join(out,state.solid),'--rune',rune,'--max-diff-ratio',values['max-diff-ratio'],'--report',path.join(out,`pixels-${record.id}-${state.state}.json`)])
  }
  if(values['max-alpha-diff-ratio'])for(const record of records)for(const state of record.states.filter(s=>s.alpha)){
    const rune=path.join(values['rune-dir']??out,`rune-alpha-${record.id}-${state.state}.png`)
    await execute(process.execPath,[path.join(root,'scripts/rune/qualify-pixels.mjs'),'--component','project-tab-alpha','--theme',record.theme,'--solid',path.join(out,state.alpha.file),'--rune',rune,'--max-diff-ratio',values['max-alpha-diff-ratio'],'--report',path.join(out,`pixels-alpha-${record.id}-${state.state}.json`)])
  }
}catch(error){if(records.length)records.at(-1).failure=error.message;throw error}
finally{
  await browser?.close();await server.close()
  const findings=records.filter(r=>r.checks.keyboardClose===false).map(r=>({context:r.id,contract:'close-keyboard-space',result:'failed',source:'packages/ui/src/components/instance-tab.tsx',evidence:'tab-close span has role=button and tabIndex=0; Space did not dispatch onClose; pointer fallback did',nativeRequirement:'Rune retains keyboard activation; divergence requires review'}))
  await writeFile(path.join(out,'evidence.json'),JSON.stringify({status:records.some(r=>r.failure)?'blocked-parity-fixture':values['rune-dir']||values.binary?'paired-captures-require-review':'solid-reference-only-unqualified',components:{wholeInstanceTabs:'pending',plainInstanceTabAlpha:values['max-alpha-diff-ratio']?'threshold-checked-review-required':'captures-unqualified'},sheets,reusedSolid,records,findings,pending:['Whole InstanceTabs actions, status/remote/temporary states and scrolling parity','Reviewed per-component pixel thresholds','Two independent blind reviews','Physical mobile qualification']},null,2))
}
console.log(out)
