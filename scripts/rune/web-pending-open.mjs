import assert from 'node:assert/strict'
import {appendFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {chromium} from 'playwright'

export async function pendingBrowser({values,m,out,storage}) {
  const origin=new URL(values.url).origin,results=[]
  const browser=await chromium.launch({headless:true,executablePath:values.executable,args:['--enable-unsafe-webgpu','--use-angle=swiftshader']})
  try {for(const mode of ['post','ack','quota','corrupt']) {
    let held,oldClaim,oldRecord,created=0,heldRoute,heldResponse,heldBody,latePostStatus
    const owned=new Set(),network=[]
    const stage=async value=>writeFile(path.join(out,`pending-${mode}-stage.json`),JSON.stringify({stage:value,network},null,2))
    const base=origin+'/'
    const context=await browser.newContext({viewport:{width:1100,height:900},storageState:storage})
    await context.route(`${origin}/api/workspaces`,async route=>{
      const req=route.request();if(req.method()!=='POST')return route.continue()
      const body=req.postDataJSON();assert.equal(body.path,values.project);assert.equal(typeof body.requestId,'string')
      created++;network.push({method:'POST',path:'/api/workspaces'})
      if(created===2){
        oldClaim=body.requestId;heldRoute=route;heldBody=body
        if(mode==='post'){held=true;return}
        heldResponse=await route.fetch({maxRedirects:0});assert.equal(heldResponse.status(),201)
        oldRecord=(await heldResponse.json()).id;owned.add(oldRecord);held=true;return
      }
      const response=await route.fetch({maxRedirects:0});assert.equal(response.status(),201)
      owned.add((await response.json()).id);await route.fulfill({response})
    })
    const page=await context.newPage();page.setDefaultTimeout(20000)
    let errors=0
    const error=message=>{if(errors++<64)appendFile(path.join(out,`pending-${mode}-errors.log`),`${String(message).slice(0,512)}\n`)}
    page.on('pageerror',error);page.on('console',message=>{if(message.type()==='error')error(message.text())})
    const KEY='codenomad.rune.alpha.client-state.v1',PROOF='codenomad.fixture.rune.pending.v1'
    await page.addInitScript(({KEY,PROOF,corrupt})=>{
      const original=Storage.prototype.setItem,fetch0=fetch,doc=crypto.randomUUID()
      globalThis.__pendingQuota=false
      const report=(kind,extra={})=>{try{const rows=JSON.parse(sessionStorage.getItem(PROOF)||'[]');rows.push({doc,kind,...extra});original.call(sessionStorage,PROOF,JSON.stringify(rows.slice(-128)))}catch{}}
      Storage.prototype.setItem=function(key,value){if(this===sessionStorage&&(key===KEY||key==='codenomad.rune.alpha.records-released')){if(globalThis.__pendingQuota){report('quota');throw new DOMException('fixture quota','QuotaExceededError')}report(key===KEY?'snapshot':'marker')}return original.call(this,key,value)}
      globalThis.fetch=function(input,init){const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.pathname==='/api/workspaces/creation/cancel')report('cancel',{base:url.origin,keepalive:init?.keepalive,credentials:init?.credentials,body:JSON.parse(init?.body??'{}')});return fetch0.apply(this,arguments)}
      addEventListener('pagehide',event=>report('pagehide',{persisted:event.persisted}))
      if(corrupt)original.call(sessionStorage,KEY,'{invalid-fixture')
    },{KEY,PROOF,corrupt:mode==='corrupt'})
    const mirror=()=>page.locator('[data-rune-a11y]'),button=name=>mirror().getByRole('button',{name,exact:true})
    const press=async locator=>{await locator.waitFor({state:'attached'});for(const end=Date.now()+20000;await locator.evaluate(el=>el.disabled||el.getAttribute('aria-disabled')==='true');){assert(Date.now()<end,'control disabled');await page.waitForTimeout(20)}await locator.click({force:true})}
    const boot=()=>page.waitForFunction(()=>globalThis.__codenomadRuneBoot?.state==='ready',undefined,{timeout:60000})
    const type=async(label,text)=>{for(let i=0;i<64;i++){const field=page.locator('textarea:focus');if(await field.count()&&await field.getAttribute('aria-label')===label){await field.fill(text);return}await page.keyboard.press('Tab');await page.waitForTimeout(20)}throw Error('Missing product field')}
    const inventory=async()=>{const r=await context.request.get(`${origin}/api/workspaces`);assert(r.ok());return (await r.json()).map(r=>r.id)}
    try {
      await stage('boot');await page.goto(base+'?locale=fr',{waitUntil:'domcontentloaded',timeout:60000});await boot()
      await stage('connect');await press(button(m['folderSelection.servers.dialog.connect']))
      await type(m['instanceInfo.labels.folder'],values.project);await press(button(m['directoryBrowser.openCurrent']));await button(m['window.menu.leftPanel']).waitFor()
      await stage('first-opened');await press(button(m['instanceTabs.new.ariaLabel']))
      if(mode!=='corrupt')await page.waitForFunction(key=>{try{return JSON.parse(sessionStorage.getItem(key)).session.tabs.length===2}catch{return false}},KEY)
      await type(m['instanceInfo.labels.folder'],values.project);await press(button(m['directoryBrowser.openCurrent']))
      for(const end=Date.now()+20000;!held;){assert(Date.now()<end,'creation not held');await page.waitForTimeout(20)}
      const before=await inventory();assert.equal(before.length,mode==='post'?1:2)
      if(mode==='quota')await page.evaluate(()=>globalThis.__pendingQuota=true)
      await stage('reload-held');await page.reload({waitUntil:'domcontentloaded'});await boot();await stage('reloaded')
      if(mode==='post'){
        const late=await context.request.post(`${origin}/api/workspaces`,{data:heldBody})
        latePostStatus=late.status();assert.equal(latePostStatus,400,'early cancellation fences the delayed exact POST')
      }
      await heldRoute.abort().catch(()=>{})
      let after;for(const end=Date.now()+5000;;){after=await inventory();if(!after.includes(oldRecord)&&after.length===(['quota','corrupt'].includes(mode)?1:0))break;assert(Date.now()<end,'departure cleanup inventory');await page.waitForTimeout(30)}
      const proof=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)||'[]'),PROOF)
      const cancel=proof.find(e=>e.kind==='cancel'&&e.body.requestId===oldClaim)
      assert(cancel&&cancel.keepalive===true&&cancel.credentials==='include'&&cancel.base===new URL(base).origin,'exact original claim requires captured-origin authenticated keepalive')
      const departure=proof.findIndex(e=>e.kind==='pagehide'),cancelAt=proof.indexOf(cancel)
      assert(departure>=0&&cancelAt>departure)
      const closing=proof.slice(departure,cancelAt)
      if(mode==='corrupt'){
        assert(!closing.some(e=>['snapshot','marker'].includes(e.kind)))
        assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),KEY),'{invalid-fixture')
      }else if(mode==='quota')assert(closing.some(e=>e.kind==='quota')&&!closing.some(e=>e.kind==='marker'))
      else assert(closing.some(e=>e.kind==='snapshot')&&closing.some(e=>e.kind==='marker'))
      // Reconnect only after the authoritative inventory has qualified departure.
      await press(button(m['folderSelection.servers.dialog.connect']))
      await type(m['instanceInfo.labels.folder'],values.project);await press(button(m['directoryBrowser.openCurrent']));await button(m['window.menu.leftPanel']).waitFor()
      const successor=(await inventory()).filter(id=>!before.includes(id));assert.equal(successor.length,1)
      await page.waitForTimeout(200);assert((await inventory()).includes(successor[0]),'old claim preserves new occurrence')
      results.push({mode,before:before.length,after:after.length,successorProtected:true,oldClaimDispatched:true,receiptUnavailableAtDeparture:true,departedDocumentReceiptDelivered:false,latePostStatus,proof,network})
    }catch(error){await writeFile(path.join(out,`pending-${mode}-failure.yml`),await page.locator('body').ariaSnapshot().catch(()=>''));await stage(String(error));throw error}finally {
      await context.close()
      const cleanup=await browser.newContext({storageState:storage})
      for(const id of owned){const r=await cleanup.request.delete(`${origin}/api/workspaces/${id}`);assert(r.ok())}
      await cleanup.close()
    }
  }}finally{await browser.close();await writeFile(path.join(out,'pending-open-proof.json'),JSON.stringify(results,null,2))}
  console.log(JSON.stringify({pendingBrowser:true,cases:results.length,success:true}))
}
