// Real product DOM bridge + sessionStorage, on a runner-owned loopback fixture only.
import assert from 'node:assert/strict'
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {pendingBrowser} from './web-pending-open.mjs'
import {assertRenderedTextContrast} from './text-contrast.mjs'
import {privateWebFixture,bundleAssetPaths,workspacePolicy,fulfillWorkspaceCreation} from './web-workspace-policy.mjs'

const root=fileURLToPath(new URL('../../',import.meta.url))
const {values}=parseArgs({options:{url:{type:'string'},project:{type:'string'},'storage-state':{type:'string'},out:{type:'string'},executable:{type:'string'},workspace:{type:'string'},'pending-open':{type:'boolean'}}})
assert(values.url&&values.project&&values['storage-state']&&values.out,'Pass --url --project --storage-state --out')
const url=new URL(values.url)
assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.pathname==='/'&&!url.hash,'Explicit isolated loopback root required')
url.search='?locale=fr'
const out=path.resolve(values.out)
const {profile,storage,inside}=await privateWebFixture({root,project:values.project,storageState:values['storage-state'],out,origin:url.origin})
await mkdir(out,{recursive:true});assert(inside(profile,await realpath(out)),'Output link escapes fixture')
const m=JSON.parse(await readFile(path.join(root,'crates/rune-theme-codenomad/assets/catalogues/fr.json'),'utf8'))
if(values['pending-open']){await pendingBrowser({values,m,out,storage});process.exit(0)}
const KEY='codenomad.rune.alpha.client-state.v1',RELEASED='codenomad.rune.alpha.records-released'
const PROOF='codenomad.fixture.rune.web-restore-proof.v1'
const draftA='Brouillon Alpha\nété · 日本語 · 🦀',draftB='Brouillon Beta\nשלום · e\u0301 · 🧭'
const retryDraft='Brouillon Beta enregistré après retry 🦀',unsaved='Dernière saisie volontairement non enregistrée 🧪'
const browser=await chromium.launch({headless:true,...(values.executable?{executablePath:values.executable}:{}),args:['--enable-unsafe-webgpu','--use-angle=swiftshader']})
const results=[]
const palette=JSON.parse(await readFile(path.join(root,'crates/rune-theme-codenomad/assets/theme.json'),'utf8'))
const assets=await bundleAssetPaths(path.resolve(root,process.env.RUNE_WEB_DIR??'target/rune-web-connected'))
const imagePage=await browser.newPage()
try {
  for(const spec of [{name:'desktop-light',width:1100,height:900,colorScheme:'light',touch:false},{name:'phone-dark',width:390,height:844,colorScheme:'dark',touch:true}]) {
    const context=await browser.newContext({viewport:{width:spec.width,height:spec.height},deviceScaleFactor:1,colorScheme:spec.colorScheme,isMobile:spec.touch,hasTouch:spec.touch,storageState:storage})
    const page=await context.newPage();page.setDefaultTimeout(20000)
    const record={context:spec.name,phoneEmulated:spec.touch,requests:[],eventSource:[],storage:[],storageLocal:[],history:[],errors:[],forbidden:[],stages:[]}
    results.push(record)
    let forbidRelease=false,sequence=0
    const policy=workspacePolicy({origin:url.origin,project:values.project,assets}),workspaces=policy.workspaces
    const stamp=()=>++sequence
    await page.addInitScript(({key,released,proof})=>{
      globalThis.__runeRestoreQuota=false
      const original=Storage.prototype.setItem,originalFetch=globalThis.fetch
      const sourceDocumentId=crypto.randomUUID();let indexLocal=0
      globalThis.__runeRestoreProofDocumentId=sourceDocumentId
      const report=(kind,extra={})=>{
        const event={sourceDocumentId,indexLocal:++indexLocal,kind,...extra}
        try {
          const prior=JSON.parse(sessionStorage.getItem(proof)??'{"version":1,"events":[]}')
          const events=prior.version===1&&Array.isArray(prior.events)?prior.events:[]
          events.push(event);while(events.length>256)events.shift()
          let text=JSON.stringify({version:1,events})
          while(text.length>65536&&events.length>1){events.shift();text=JSON.stringify({version:1,events})}
          original.call(sessionStorage,proof,text)
        }catch{}
        console.debug('__rune_restore_proof__'+JSON.stringify(event))
      }
      const originalAdd=globalThis.addEventListener,originalRemove=globalThis.removeEventListener
      const listeners=new WeakMap();let nextListener=0
      globalThis.addEventListener=function(type,listener,options){
        if(type!=='pagehide'||typeof listener!=='function')return originalAdd.call(this,type,listener,options)
        const capture=typeof options==='boolean'?options:Boolean(options?.capture)
        let modes=listeners.get(listener);if(!modes){modes=new Map();listeners.set(listener,modes)}
        let item=modes.get(capture)
        if(!item){
          const id=++nextListener
          const wrapped=function(event){report('pagehide-handler-enter',{listener:id,capture,persisted:event.persisted});try{return listener.call(this,event)}finally{report('pagehide-handler-exit',{listener:id,capture})}}
          item={id,wrapped};modes.set(capture,item)
        }
        const result=originalAdd.call(this,type,item.wrapped,options)
        report('pagehide-listener-added',{listener:item.id,capture})
        return result
      }
      globalThis.removeEventListener=function(type,listener,options){
        const capture=typeof options==='boolean'?options:Boolean(options?.capture)
        const item=type==='pagehide'&&typeof listener==='function'?listeners.get(listener)?.get(capture):null
        if(item)report('pagehide-listener-removed',{listener:item.id,capture})
        return originalRemove.call(this,type,item?.wrapped??listener,options)
      }
      Storage.prototype.setItem=function(name,value){
        const watched=this===sessionStorage&&(name===key||name===released)
        if(watched&&globalThis.__runeRestoreQuota){report('quota-refused',{key:name});throw new DOMException('Controlled fixture quota','QuotaExceededError')}
        const result=original.call(this,name,value)
        if(watched){let revision;try{revision=JSON.parse(value).revision}catch{}report(name===key?'snapshot-written':'released-written',{bytes:new TextEncoder().encode(value).length,revision})}
        return result
      }
      globalThis.fetch=function(...args){
        const [input,init]=args
        try {
          const address=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,location.href)
          const method=String(init?.method??input?.method??'GET').toUpperCase()
          if(method==='DELETE'&&address.origin===location.origin&&/^\/api\/workspaces\/[^/]+$/.test(address.pathname)){
            let revision;try{revision=JSON.parse(sessionStorage.getItem(key)).revision}catch{}
            report('fetch-delete-call',{path:address.pathname,releaseMarker:sessionStorage.getItem(released)==='1',snapshotPresent:sessionStorage.getItem(key)!==null,revision})
          }
        }catch{}
        return originalFetch.apply(this,args)
      }
      addEventListener('pagehide',event=>report('pagehide',{persisted:event.persisted}))
    },{key:KEY,released:RELEASED,proof:PROOF})
    page.on('console',message=>{const text=message.text();if(text.startsWith('__rune_restore_proof__')&&record.storage.length<512){try{record.storage.push({sequence:stamp(),...JSON.parse(text.slice('__rune_restore_proof__'.length))})}catch{}}})
    page.on('pageerror',error=>record.errors.push({name:error.name,message:error.message.slice(0,200)}))
    const cdp=await context.newCDPSession(page);await cdp.send('Network.enable')
    cdp.on('Network.eventSourceMessageReceived',event=>{
      if(record.eventSource.length>=512)return
      let data;try{data=JSON.parse(event.data)}catch{}
      const value=data?.event??data
      record.eventSource.push({sequence:stamp(),type:value?.type??event.eventName,id:value?.id,sessionID:value?.data?.sessionID})
    })
    const responses=new Set()
    page.on('response',response=>{
      const task=(async()=>{
        const req=response.request(),p=new URL(response.url()).pathname
        if(p.endsWith('/session-history/window')&&response.ok()) {
          const body=await response.json(),input=req.postDataJSON()
          record.history.push({sequence:stamp(),sessionID:input.sessionID,status:body.status,messages:body.messages?.map(row=>({id:row.id,type:row.type,text:row.type==='user'?row.text:row.content?.filter(p=>p.type==='text').map(p=>p.text).join('\n')}))})
        }
      })().catch(()=>record.errors.push({name:'FixtureResponse',message:'Invalid fixture response'}))
      responses.add(task);task.finally(()=>responses.delete(task))
    })
    await context.route('**/*',async route=>{
      const req=route.request(),requested=new URL(req.url()),p=requested.pathname,method=req.method()
      let allowed=await policy.request(req,{forbidRelease})
      const entry={sequence:stamp(),method,path:p,status:allowed?'allowed':'refused',...(requested.searchParams.has('cursor')?{pagination:true}:{})}
      if(record.requests.length<4000)record.requests.push(entry);else allowed=false
      if(!allowed){record.forbidden.push(entry);return route.abort('blockedbyclient')}
      if(method==='POST'&&p==='/api/workspaces'){
        try {
          Object.assign(entry,await fulfillWorkspaceCreation(route,policy))
          return
        }catch{
          record.errors.push({name:'WorkspaceAdmission',message:'Private workspace response was refused before delivery'})
          return route.abort('blockedbyclient')
        }
      }
      await route.continue()
    })
    const mirror=()=>page.locator('[data-rune-a11y]')
    const press=async locator=>{
      await locator.waitFor({state:'attached'})
      for(const until=Date.now()+20000;await locator.evaluate(el=>el.disabled||el.getAttribute('aria-disabled')==='true');){assert(Date.now()<until,'Product control remained disabled');await page.waitForTimeout(20)}
      await locator.click({force:true})
    }
    const button=name=>mirror().getByRole('button',{name,exact:true})
    const left=m['window.menu.leftPanel']
    const sessions=mirror().getByRole('region',{name:left,exact:true})
    const openSessions=async()=>{
      await button(left).waitFor()
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      if(await button(left).getAttribute('aria-expanded')!=='true')await press(button(left))
      await sessions.waitFor()
    }
    const sessionRow=name=>sessions.getByRole('listitem',{name,exact:true})
    const connect=async()=>{await press(button(m['folderSelection.servers.dialog.connect']))}
    const boot=async()=>{
      await page.waitForFunction(()=>['ready','failed'].includes(globalThis.__codenomadRuneBoot?.state),undefined,{timeout:60000})
      assert.equal(await page.evaluate(()=>globalThis.__codenomadRuneBoot.state),'ready')
      await button(m['folderSelection.servers.dialog.connect']).waitFor({state:'attached'})
    }
    const field=async label=>{
      for(let i=0;i<64;i++){
        const focused=page.locator('textarea:focus')
        if(await focused.count()&&await focused.getAttribute('aria-label')===label)return focused
        await page.keyboard.press('Tab')
        await page.waitForTimeout(20)
      }
      throw Error(`Real textarea focus unavailable: ${label}`)
    }
    const type=async(label,text)=>{const input=await field(label);await input.fill(text);assert.equal(await input.inputValue(),text)}
    const reading=async(session,draft)=>{
      await mirror().getByRole('heading',{name:session==='ses_another'?'Another session':'Existing history',exact:true}).waitFor()
      for(const deadline=Date.now()+15000;!record.history.some(row=>row.sessionID===session&&row.status==='window');){
        assert(Date.now()<deadline,'Restoration must read authoritative history')
        await page.waitForTimeout(20)
      }
      await page.waitForFunction(({existing})=>{const text=document.querySelector('[data-rune-a11y]')?.textContent??'';return existing?text.includes('Existing project history')&&text.includes('Existing answer'):!text.includes('Existing project history')&&!text.includes('Existing answer')},{existing:session==='ses_existing'})
      if(draft!==undefined)assert.equal(await (await field(m['rune.prompt'])).inputValue(),draft,'Occurrence draft must match exactly')
    }
    const tab=async index=>{await press(mirror().getByRole('tab',{name:values.project,exact:true}).nth(index))}
    const selected=async index=>{
      await page.waitForFunction(index=>{const list=[...document.querySelectorAll('[data-rune-a11y] [role=tab]')];return list.length===2&&list[index].getAttribute('aria-selected')==='true'},index)
    }
    const saved=async expected=>{
      await page.waitForFunction(({key,expected})=>{try{const s=JSON.parse(sessionStorage.getItem(key));return s.session.tabs.length===2&&s.session.activeTabIndex===1&&s.session.tabs[0].drafts.ses_existing===expected[0]&&s.session.tabs[1].drafts.ses_another===expected[1]}catch{return false}},{key:KEY,expected})
      const raw=await page.evaluate(key=>sessionStorage.getItem(key),KEY)
      assert(Buffer.byteLength(raw)<=1048576)
      const snapshot=JSON.parse(raw)
      const inspect=value=>{if(value&&typeof value==='object')for(const [key,child]of Object.entries(value)){assert(!/password|authorization|cookie|token|secret/i.test(key),'Snapshot must omit authentication');inspect(child)}};inspect(snapshot)
      assert(snapshot.session.tabs.every(t=>t.folder===values.project&&t.backendId==='web'&&typeof t.serverId==='string'))
      return raw
    }
    const capture=async stage=>{
      record.stages.push(stage);await writeFile(path.join(out,`${spec.name}-${stage}.aria.yml`),await page.locator('body').ariaSnapshot())
      if(stage==='failure'){await page.screenshot({path:path.join(out,`${spec.name}-${stage}.png`)});return}
      const attempts=[]
      for(const deadline=Date.now()+5000;;){
      const boxes={}
      try {
      for(const [key,locator] of [['canvas',page.locator('canvas').first()],['model',button(m['rune.model'])],
        ['composer',mirror().getByRole('group',{name:m['rune.prompt'],exact:true})],['send',button(m['promptInput.overlay.send'])]]) {
        boxes[key]=await locator.evaluate(el=>{
          const r=el.getBoundingClientRect(),rect=[r.x,r.y,r.width,r.height]
          let left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom)
          for(let p=el.parentElement;p;p=p.parentElement){
            const s=getComputedStyle(p),b=p.getBoundingClientRect()
            if(/hidden|clip|auto|scroll/.test(s.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right)}
            if(/hidden|clip|auto|scroll/.test(s.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom)}
          }
          return {rect,clip:[left,top,Math.max(0,right-left),Math.max(0,bottom-top)]}
        })
        const {rect,clip}=boxes[key]
        assert(rect[2]>0&&rect[3]>0&&clip[2]>0&&clip[3]>=rect[3]-1&&(key==='composer'||clip[2]>=rect[2]-1),`${key} must fit the actual viewport and ancestor clips: ${JSON.stringify(boxes[key])}`)
      }
      const {['space-md']:md,['space-sm']:sm}=palette.numbers[spec.colorScheme]
      const regions=['model','send'].map(name=>({name,rect:boxes[name].rect,surface:'surface-control',inset:sm}))
      const [x,y,w]=boxes.composer.rect
      const editor=[x+md,y+md,w-md*2,boxes.send.rect[1]-sm-y-md],clip=boxes.composer.clip
      assert(editor[0]>=clip[0]&&editor[1]>=clip[1]&&editor[0]+editor[2]<=clip[0]+clip[2]+1&&editor[1]+editor[3]<=clip[1]+clip[3]+1,'Actual editor surface must fit its viewport and ancestor clips')
      regions.push({name:'composer',rect:editor,surface:'surface-field',inset:sm})
      let png,paint;const paintSamples=[]
      for(let sample=0;sample<2;sample++){
        png=await page.screenshot()
        paint=await assertRenderedTextContrast(imagePage,png,regions,palette[spec.colorScheme])
        paintSamples.push(paint.map(region=>({name:region.name,drawnInkPixels:region.drawnInkPixels})))
      }
      await writeFile(path.join(out,`${spec.name}-${stage}.png`),png)
      ;(record.viewportProof??=[]).push({stage,viewport:[spec.width,spec.height],boxes,paint,paintSamples,settlementAttempts:attempts})
      break
      }catch(error){
        if(attempts.length<16)attempts.push({failure:error.message,boxes})
        if(Date.now()>=deadline){(record.viewportProof??=[]).push({stage,settlementAttempts:attempts});throw error}
        // Observed mirror commits can precede final geometry and GPU presentation.
        await page.screenshot()
      }
      }
    }
    const localProof=async documentId=>{
      const raw=await page.evaluate(key=>sessionStorage.getItem(key),PROOF)
      assert(raw&&Buffer.byteLength(raw)<=65536,'Bounded persistent fixture proof required')
      const proof=JSON.parse(raw);assert.equal(proof.version,1);assert(Array.isArray(proof.events)&&proof.events.length<=256)
      for(const event of proof.events){
        assert(typeof event.sourceDocumentId==='string'&&Number.isInteger(event.indexLocal)&&event.indexLocal>0)
        if(!record.storageLocal.some(e=>e.sourceDocumentId===event.sourceDocumentId&&e.indexLocal===event.indexLocal))record.storageLocal.push(event)
      }
      assert(record.storageLocal.length<=768,'Fixture proof collection exceeded its bound')
      return proof.events.filter(e=>e.sourceDocumentId===documentId)
    }
    try {
      await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:60000});await boot();await connect()
      await type(m['instanceInfo.labels.folder'],values.project);await page.keyboard.press('Enter')
      await openSessions();await press(sessionRow('Existing history'));await reading('ses_existing');await type(m['rune.prompt'],draftA)
      await press(button(m['instanceTabs.new.ariaLabel']))
      await type(m['instanceInfo.labels.folder'],values.project);await page.keyboard.press('Enter')
      await openSessions();await press(button(m['rune.more']));await press(sessionRow('Another session'));await reading('ses_another');await type(m['rune.prompt'],draftB)
      await selected(1);await saved([draftA,draftB]);await capture('before-reload')
      record.syntheticBFCache=await page.evaluate(({key,released,proof})=>{
        const snapshot=sessionStorage.getItem(key),marker=sessionStorage.getItem(released),documentId=globalThis.__runeRestoreProofDocumentId
        const prior=JSON.parse(sessionStorage.getItem(proof)).events.filter(event=>event.sourceDocumentId===documentId)
        const before=prior.at(-1)?.indexLocal??0
        dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))
        dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))
        return {synthetic:true,snapshotUnchanged:sessionStorage.getItem(key)===snapshot,markerUnchanged:sessionStorage.getItem(released)===marker,
          documentUnchanged:globalThis.__runeRestoreProofDocumentId===documentId,
          events:JSON.parse(sessionStorage.getItem(proof)).events.filter(event=>event.sourceDocumentId===documentId&&event.indexLocal>before)}
      },{key:KEY,released:RELEASED,proof:PROOF})
      assert(record.syntheticBFCache.snapshotUnchanged&&record.syntheticBFCache.markerUnchanged&&record.syntheticBFCache.documentUnchanged,'Synthetic persisted transition preserves this document and its snapshot')
      assert(record.syntheticBFCache.events.some(event=>event.kind==='pagehide'&&event.persisted===true),'Synthetic persisted pagehide must reach the real handlers')
      assert(!record.syntheticBFCache.events.some(event=>['snapshot-written','released-written','fetch-delete-call','pagehide-listener-removed'].includes(event.kind)),'Synthetic persisted transition must preserve Store and records without cleanup')
      await reading('ses_another',draftB);await selected(1)
      const normalStart=sequence,normalDocument=await page.evaluate(()=>globalThis.__runeRestoreProofDocumentId)
      const ownedAtDeparture=JSON.parse(await saved([draftA,draftB])).session.tabs.map(tab=>tab.workspaceId)
      assert.equal(new Set(ownedAtDeparture).size,2);assert(ownedAtDeparture.every(id=>workspaces.has(id)))
      record.ownedAtDeparture=ownedAtDeparture
      record.inventoryBeforeDeparture=await page.evaluate(async()=>{const response=await fetch('/api/workspaces',{credentials:'include'});if(!response.ok)throw Error('Departure inventory refused');return (await response.json()).map(row=>row.id)})
      await page.reload({waitUntil:'domcontentloaded',timeout:60000});await boot()
      record.inventoryAfterDeparture=await page.evaluate(async()=>{const response=await fetch('/api/workspaces',{credentials:'include'});if(!response.ok)throw Error('Departure inventory refused');return (await response.json()).map(row=>row.id)})
      const settleBy=Date.now()+5000
      while(record.inventoryAfterDeparture.some(id=>ownedAtDeparture.includes(id))&&Date.now()<settleBy){
        await page.waitForTimeout(50)
        record.inventoryAfterDeparture=await page.evaluate(async()=>{const response=await fetch('/api/workspaces',{credentials:'include'});if(!response.ok)throw Error('Departure inventory refused');return (await response.json()).map(row=>row.id)})
      }
      await connect();await reading('ses_another',draftB);await selected(1)
      await tab(0);await reading('ses_existing',draftA);await tab(1);await reading('ses_another',draftB);await selected(1)
      await saved([draftA,draftB]);await capture('restored')
      const normalLocal=await localProof(normalDocument)
      const hide=normalLocal.find(e=>e.kind==='pagehide'&&!e.persisted)
      assert(hide,'Real pagehide must be persisted in the fixture proof')
      const committed=normalLocal.find(e=>e.kind==='snapshot-written'&&e.indexLocal>hide.indexLocal)
      const marked=normalLocal.find(e=>e.kind==='released-written'&&e.indexLocal>(committed?.indexLocal??Infinity))
      const dispatched=normalLocal.filter(e=>e.kind==='fetch-delete-call')
      assert(committed&&marked&&dispatched.length>=2&&dispatched.every(e=>e.indexLocal>marked.indexLocal&&e.releaseMarker&&e.snapshotPresent&&workspaces.has(e.path.split('/').at(-1))),'Document-local order must be pagehide, snapshot, marker, owned DELETE dispatches')
      const normalDeletes=record.requests.filter(e=>e.sequence>normalStart&&e.method==='DELETE')
      record.observedDepartureDeletes=normalDeletes.length
      assert(ownedAtDeparture.every(id=>!record.inventoryAfterDeparture.includes(id)),'Successful pagehide DELETEs must remove their adopted records from the real Rust inventory before any restore')
      assert(record.inventoryBeforeDeparture.filter(id=>!ownedAtDeparture.includes(id)).every(id=>record.inventoryAfterDeparture.includes(id)),'Departure preserves records owned by other documents')

      const beforeQuota=await saved([draftA,draftB])
      await page.evaluate(()=>{globalThis.__runeRestoreQuota=true});await type(m['rune.prompt'],retryDraft)
      await mirror().getByText(m['rune.save_error'],{exact:true}).waitFor()
      assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),KEY),beforeQuota,'Quota failure must preserve the previous complete snapshot')
      await capture('quota-refused')
      await page.evaluate(()=>{globalThis.__runeRestoreQuota=false});await press(button(m['sessionList.loadError.retry']))
      await saved([draftA,retryDraft]);await reading('ses_another',retryDraft)
      const beforeFailedHide=await saved([draftA,retryDraft]);forbidRelease=true
      record.inventoryBeforeFailedDeparture=await page.evaluate(async()=>{const response=await fetch('/api/workspaces',{credentials:'include'});if(!response.ok)throw Error('Departure inventory refused');return (await response.json()).map(row=>row.id)})
      await page.evaluate(()=>{globalThis.__runeRestoreQuota=true});await type(m['rune.prompt'],unsaved)
      await mirror().getByText(m['rune.save_error'],{exact:true}).waitFor()
      const failedStart=sequence,failedDocument=await page.evaluate(()=>globalThis.__runeRestoreProofDocumentId)
      await page.reload({waitUntil:'domcontentloaded',timeout:60000});await boot()
      assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),KEY),beforeFailedHide,'Failed pagehide keeps the last stored draft, not the unsaved edit')
      record.inventoryAfterFailedDeparture=await page.evaluate(async()=>{const response=await fetch('/api/workspaces',{credentials:'include'});if(!response.ok)throw Error('Departure inventory refused');return (await response.json()).map(row=>row.id)})
      assert.deepEqual([...record.inventoryAfterFailedDeparture].sort(),[...record.inventoryBeforeFailedDeparture].sort(),'Quota failure must retain every real Rust record before restoring any occurrence')
      await connect();await reading('ses_another',retryDraft);await selected(1)
      const failedLocal=await localProof(failedDocument)
      const failedHide=failedLocal.find(e=>e.kind==='pagehide'&&!e.persisted)
      assert(failedHide&&failedLocal.some(e=>e.kind==='quota-refused'&&e.indexLocal>failedHide.indexLocal),'Failed pagehide must persist its real quota refusal')
      assert(!failedLocal.some(e=>e.kind==='released-written'&&e.indexLocal>failedHide.indexLocal),'Failed pagehide must not mark its records released')
      assert(!failedLocal.some(e=>e.kind==='fetch-delete-call'),'Failed pagehide must never invoke DELETE fetch')
      assert(!record.requests.some(e=>e.sequence>failedStart&&e.method==='DELETE'),'Failed pagehide must not attempt logical record deletion')
      forbidRelease=false
      await tab(0);await reading('ses_existing',draftA);await tab(1);await reading('ses_another',retryDraft)
      await saved([draftA,retryDraft]);await capture('retry-restored')
      await Promise.all([...responses])
      const histories=record.history.filter(h=>h.status==='window')
      assert(histories.some(h=>h.sessionID==='ses_existing'&&JSON.stringify(h.messages.map(m=>m.text))===JSON.stringify(['Existing project history','Existing answer'])))
      assert(histories.some(h=>h.sessionID==='ses_another'&&h.messages.length===0))
      assert(record.requests.some(r=>r.pagination),'Second session must be reached through a real catalogue page')
      assert(record.eventSource.length>0,'Real EventSource traffic required')
      assert.equal(record.errors.length,0);assert.equal(record.forbidden.length,0)
      await writeFile(path.join(out,`${spec.name}-snapshot.json`),await saved([draftA,retryDraft]))
      record.result='pass';record.limit='Phone emulated. Forced closure with unsaved edits is outside the restoration guarantee.'
    }catch(error){record.result='fail';record.failure=error.message;await capture('failure').catch(()=>{});throw error}
    finally{forbidRelease=false;try{await localProof(await page.evaluate(()=>globalThis.__runeRestoreProofDocumentId))}catch{}await context.close();await writeFile(path.join(out,`${spec.name}-proof.json`),JSON.stringify(record,null,2))}
  }
}finally{await browser.close();await writeFile(path.join(out,'summary.json'),JSON.stringify({runner:'web-restore',origin:url.origin,contexts:results.map(r=>({context:r.context,result:r.result,failure:r.failure})),scope:'Real Rust static/API, simulated OpenCode fixture, product WASM/DOM/sessionStorage; no model or real sessions'},null,2))}
console.log(JSON.stringify({runner:'web-restore',contexts:results.map(r=>({context:r.context,result:r.result})),out}))
