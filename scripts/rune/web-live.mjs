import assert from 'node:assert/strict'
import {now, withBudget} from './web-budget.mjs'

export function command(action) {
  assert(process.send,'Run the mobile smoke through launcher-fixture.mjs')
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error(`No fixture acknowledgement: ${action}`)),action==='restart'?45000:15000)
    process.once('message', ({value,error})=>{
      clearTimeout(timer)
      if(error)reject(Error(error))
      else resolve(value)
    })
    process.send(action)
  })
}

export async function openSessionSearch(page, sidebar, messages, tap) {
  const name=messages['sessionList.filter.ariaLabel']
  const create=sidebar.getByRole('button',{name:messages['rune.create'],exact:true})
  const before=await create.count()
  const trigger=sidebar.getByRole('button',{name,exact:true})
  const touch=async (locator, role)=>{
    await locator.waitFor()
    const box=await locator.boundingBox()
    assert(box&&box.width>0&&box.height>0)
    await tap(box.x+box.width/2,box.y+box.height/2,{label:name,role})
  }
  const field=sidebar.getByRole('group',{name,exact:true})
  let started=await page.evaluate(()=>performance.now())
  let stage='open'
  try {
    await touch(trigger,'button')
    await field.waitFor()
    assert.equal(await trigger.getAttribute('aria-expanded'),'true')
    // A project without a conversation already shows the creation form.
    assert.equal(await create.count(),before,
      'Opening session search must not open New Session')
    stage='focus'
    started=await page.evaluate(()=>performance.now())
    const editor=page.locator('textarea:focus').and(page.getByRole('textbox',{name,exact:true}))
    assert.equal(await editor.count(),0,'Opening search must not focus the field')
    await touch(field,'group')
    await editor.waitFor({state:'attached'})
  } catch (error) {
    const [expanded, elapsed]=await Promise.all([
      trigger.getAttribute('aria-expanded').catch(()=>null),
      page.evaluate(started=>Math.round(performance.now()-started),started).catch(()=>null),
    ])
    throw new Error(`Session search ${stage}; expanded: ${expanded}; DOM elapsed: ${elapsed} ms: ${error.message}`,{cause:error})
  }
}

export async function mobileLive({page,context,url,messages,revoke,eventSources,workspaces,policy,fromLink=true,tap=(x,y)=>page.touchscreen.tap(x,y),onRestart,attestedGet}){
  const text=value=>page.getByText(value,{exact:true})
  const connecting=text(messages['instanceShell.connection.connecting'])
  const before=eventSources()
  assert(before>0)
  await command('live')
  await text('Mobile live SSE only').waitFor()
  await command('cut')
  await connecting.waitFor()
  assert.equal(await text(messages['authRecovery.pairingTitle']).count(),0)
  let older
  if(workspaces){
    const button=page.getByRole('button',{name:messages['rune.older'],exact:true})
    const disabled=await button.evaluate(el=>el.disabled||el.getAttribute('aria-disabled')==='true')
    assert.equal(disabled,true,'Older messages button must expose disabled state while reconnecting')
    older={expected:'disabled',observed:'disabled',status:'pass'}
  }
  await command('resume')
  await text('Mobile recovered history').waitFor()
  await connecting.waitFor({state:'hidden'})
  const evidence={live:true,recovered:true,older}
  if(revoke){
    const draft='Draft across device revocation'
    const group=page.getByRole('group',{name:messages['rune.prompt'],exact:true})
    const focus=async()=>{
      const box=await group.boundingBox()
      const actions=await group.getByRole('button').evaluateAll(buttons=>Math.min(...buttons.map(button=>button.getBoundingClientRect().top)))
      assert(box&&Number.isFinite(actions)&&actions>box.y)
      await tap(box.x+box.width/2,(box.y+actions)/2)
      const editor=page.locator('textarea:focus')
      await editor.waitFor({timeout:2500})
      return editor
    }
    await (await focus()).fill(draft)
    const left=page.getByRole('button',{name:messages['window.menu.leftPanel'],exact:true})
    const sidebar=page.getByRole('region',{name:messages['window.menu.leftPanel'],exact:true})
    const search=sidebar.getByRole('button',{name:messages['sessionList.filter.ariaLabel'],exact:true})
    const hit=async locator=>{
      const box=await locator.boundingBox();assert(box)
      await tap(box.x+box.width/2,box.y+box.height/2)
    }
    await hit(left)
    await openSessionSearch(page, sidebar, messages, tap)
    await page.locator('textarea:focus').fill('Another session')
    await sidebar.getByRole('listitem',{name:'Another session',exact:true}).waitFor()
    const afterTransport=eventSources()
    const previous=[...workspaces]
    const newHistory=page.waitForResponse(response=>{
      const match=new URL(response.url()).pathname.match(/^\/api\/workspaces\/([^/]+)\/session-history\/window$/)
      return match&&!previous.includes(match[1])&&response.ok()&&response.request().postDataJSON()?.sessionID==='ses_existing'
    },{timeout:45000})
    void newHistory.catch(()=>{})
    const {older,witness,serverPid}=await command('restart')
    assert(Number.isSafeInteger(serverPid)&&serverPid>0,'Restarted fixture must report its new owned server PID')
    if(onRestart)await onRestart(serverPid)
    assert(previous.length&&previous.every(id=>older.includes(id)),'Fixture had the browser-owned workspaces before reboot')
    assert.equal((await (await newHistory).json()).status,'window','Rebind the conversation while search is open')
    assert.equal(await search.getAttribute('aria-expanded'),'true','Search must stay open through restart')
    await hit(search)
    await sidebar.getByRole('listitem',{name:'Existing history',exact:true}).waitFor({timeout:45000})
    await sidebar.getByRole('listitem',{name:'Linked checkout next page',exact:true}).waitFor()
    await hit(left)
    await text('Mobile Rust restart history').waitFor({timeout:45000})
    await connecting.waitFor({state:'hidden'})
    assert(typeof attestedGet==='function','Attested GET helper required for mobileLive inventory check')
    const inventory=await attestedGet('/api/workspaces',context)
    assert(inventory.ok)
    const ids=(await inventory.json()).map(row=>row.id)
    assert(older.every(id=>!ids.includes(id)),'The restarted listener must not still have the old workspace ids')
    assert(ids.includes(witness),'Reopening by folder must leave the other occurrence intact')
    const fresh=[...workspaces].filter(id=>!previous.includes(id))
    assert(fresh.length===1&&ids.includes(fresh[0]),'Browser must claim exactly one new workspace for the active tab')
    for(const id of previous)workspaces.delete(id)
    assert.equal(await (await focus()).inputValue(),draft)
    assert(eventSources()>afterTransport,'Rust restart must open a new EventSource')
    assert.equal(page.url(),url.href)
    evidence.recoveredAfterRustRestart=true
    evidence.ordinaryCatalogueAfterClosingSearch=true
    // Prepare the pairing link and second tab and restore front focus BEFORE revoking the device,
    // so neither tab creation nor bringToFront can trigger an unintercepted FocusCheck probe.
    const again=new URL(await command('pair'))
    assert.equal(again.origin,url.origin)
    assert.equal(again.pathname,'/remote-pair')
    again.searchParams.set('locale','he')
    let beforeRevoke=0
    const tab=await context.newPage()
    try {
      const pairFlow=await preparePair(tab, again, {fromLink, waitUntil:'commit'})
      try {
        await page.bringToFront()
        beforeRevoke=eventSources()
        const dialog=page.getByRole('dialog',{name:messages['authRecovery.pairingTitle']})
        const staleCaptured=Promise.withResolvers()
        const releaseStale=Promise.withResolvers()
        const staleSettled=Promise.withResolvers()
        const followUpCaptured=Promise.withResolvers()
        const releaseFollowUp=Promise.withResolvers()
        const followUpSettled=Promise.withResolvers()
        const staleReceivedByBrowser=Promise.withResolvers()
        const authStatusUrl=`${url.origin}/api/auth/status`
        const eventsUrl=`${url.origin}/api/events*`
        let heldStale=false
        let heldFollowUp=false
        let staleRequest=null
        let authStatusRequests=0
        let staleAborted=null
        let staleReleased=false
        let staleDone=false
        let blockEvents=false
        let postStaleStatus=0
        let staleError=null
        const onAuthFailed=req=>{
          if(staleRequest&&req===staleRequest){
            staleAborted=req.failure()?.errorText||'aborted'
            staleReceivedByBrowser.reject(new Error(`Held /api/auth/status aborted before delivery: ${staleAborted}`))
          }
        }
        const onAuthResponse=res=>{
          if(staleRequest&&res.request()===staleRequest){
            staleReceivedByBrowser.resolve(res)
          }
        }
        void staleCaptured.promise.catch(()=>{})
        void followUpCaptured.promise.catch(()=>{})
        void staleReceivedByBrowser.promise.catch(()=>{})
        page.on('requestfailed',onAuthFailed)
        page.on('response',onAuthResponse)
        const admitRoute=async req=>{
          if(policy)return await policy.request(req,{allowApi:true})
          const requested=new URL(req.url())
          return requested.origin===url.origin&&Boolean((await req.allHeaders()).cookie)
        }
        const fetchOwnedStatus=async route=>{
          assert(typeof attestedGet==='function','Attested status fetcher required')
          const requested=new URL(route.request().url())
          assert.equal(requested.origin,url.origin,'Auth status request must stay on the owned origin')
          const response=await attestedGet(`${requested.pathname}${requested.search}`,context)
          assert.equal(response.status,200,'Auth status response must return 200 without redirecting')
          const text=await response.text()
          const body=JSON.parse(text)
          const headers={}
          const contentType=response.headers.get('content-type')
          if(contentType)headers['content-type']=contentType
          const cacheControl=response.headers.get('cache-control')
          if(cacheControl)headers['cache-control']=cacheControl
          return {status:response.status,headers,text,body}
        }
        const holdEvents=async route=>{
          if(!blockEvents)return route.fallback()
          if(!await admitRoute(route.request()))return route.abort('blockedbyclient')
          return route.fulfill({status:503,contentType:'application/json',body:'{}'})
        }
        const holdStaleStatus=async route=>{
          if(route.request().method()!=='GET')return route.fallback()
          if(!await admitRoute(route.request()))return route.abort('blockedbyclient')
          authStatusRequests++
          if(heldStale){
            if(staleReleased&&!heldFollowUp){
              heldFollowUp=true
              postStaleStatus++
              try {
                const {status,headers,text,body}=await fetchOwnedStatus(route)
                assert.equal(body.authenticated,true)
                assert(!body.pairingRequired)
                followUpCaptured.resolve()
                await releaseFollowUp.promise
                await route.fulfill({status,headers,body:text})
              } catch (err) {
                followUpCaptured.reject(err)
                await route.abort().catch(()=>{})
              } finally {
                followUpSettled.resolve()
              }
              return
            }
            if(staleReleased)postStaleStatus++
            return route.fallback()
          }
          heldStale=true
          blockEvents=true
          staleRequest=route.request()
          try {
            const {status,headers,text,body}=await fetchOwnedStatus(route)
            assert.equal(body.authenticated,false)
            assert.equal(body.pairingRequired,true)
            staleCaptured.resolve()
            await releaseStale.promise
            await route.fulfill({status,headers,body:text})
          } catch (err) {
            staleError=err
            staleCaptured.reject(err)
            await route.abort().catch(()=>{})
          } finally {
            staleDone=true
            staleSettled.resolve()
          }
        }
        // Intercept the VERY FIRST /api/auth/status triggered by device revocation (before #pairing-recovery opens),
        // then block SSE reconnects until the pairing overlay dismisses so focus/visibility alone drives recovery.
        await page.route(eventsUrl,holdEvents)
        await page.route(authStatusUrl,holdStaleStatus)
        try {
          try {
            await page.evaluate(()=>{
              globalThis.__runeReturnSignal=null
              const onFocus=()=>{ globalThis.__runeReturnSignal='focus' }
              const onVis=()=>{ if(document.visibilityState==='visible')globalThis.__runeReturnSignal='visibility' }
              window.addEventListener('focus',onFocus)
              document.addEventListener('visibilitychange',onVis)
              globalThis.__runeCleanupReturnSignal=()=>{
                window.removeEventListener('focus',onFocus)
                document.removeEventListener('visibilitychange',onVis)
                delete globalThis.__runeCleanupReturnSignal
                delete globalThis.__runeReturnSignal
              }
            })
            await command('revoke')
            await withBudget(now()+10_000,'first pre-pairing auth status capture',()=>staleCaptured.promise)
            assert.equal(await dialog.count(),0,'#pairing-recovery must not be open yet while the first /api/auth/status is held')
            // Re-pair in the prepared tab and return focus BEFORE the first status probe delivers pairingRequired=true.
            await pairFlow.complete()
            await page.bringToFront()
            // Headless shell keeps every page visible/focused across tabs; when bringToFront emits
            // neither signal, dispatch window focus so Rune's real FocusCheck listener runs before release.
            const returnSignal=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{
              if(!globalThis.__runeReturnSignal)window.dispatchEvent(new Event('focus'))
              requestAnimationFrame(()=>requestAnimationFrame(()=>{
                const signal=globalThis.__runeReturnSignal
                globalThis.__runeCleanupReturnSignal?.()
                resolve(signal)
              }))
            })))
            assert(returnSignal==='focus'||returnSignal==='visibility','Expected a focus or visibility return signal before releasing the held status probe')
            assert.equal(await dialog.count(),0,'Focus return must precede opening of #pairing-recovery')
            assert(!staleDone,'Focus return must precede delivery of the held first status probe')
            assert.equal(staleAborted,null,'Held first status probe must still be in flight when focus returns')
            assert.equal(authStatusRequests,1,'No follow-up /api/auth/status may start before the held probe is delivered')
            assert.equal(eventSources(),beforeRevoke,'SSE must remain blocked so focus/visibility alone drives recovery')
          } finally {
            await page.evaluate(()=>globalThis.__runeCleanupReturnSignal?.()).catch(()=>{})
            staleReleased=true
            releaseStale.resolve()
            if(heldStale)await staleSettled.promise
          }
          if(staleError)throw staleError
          assert.equal(staleAborted,null,'Held first status probe must not abort before browser delivery')
          const staleBrowserResponse=await withBudget(now()+5_000,'browser receipt of held first auth status',()=>staleReceivedByBrowser.promise)
          assert.equal(staleBrowserResponse.status(),200)
          assert.equal(await staleBrowserResponse.finished(),null,'Browser must finish reading the held first status response')
          assert.equal((await staleBrowserResponse.json()).pairingRequired,true,'Browser must receive pairingRequired=true from the first probe')
          // Returning focus while the first status probe was in flight must queue a follow-up check
          // immediately once pairingRequired=true opens #pairing-recovery, without any click or SSE help.
          try {
            await withBudget(now()+10_000,'follow-up auth status after first stale probe',()=>followUpCaptured.promise)
            await dialog.waitFor()
            await text(messages['rune.pairing_guide']).waitFor()
            assert.equal(await dialog.getByRole('textbox').count(),0,'Browser pairing never shows a password form')
          } finally {
            releaseFollowUp.resolve()
            if(heldFollowUp)await followUpSettled.promise
          }
          await dialog.waitFor({state:'detached',timeout:10_000})
          assert.equal(eventSources(),beforeRevoke,'SSE stayed blocked until the pairing overlay dismissed')
          assert(postStaleStatus>=1,'Focus return during the first status probe must trigger a follow-up /api/auth/status check')
        } finally {
          blockEvents=false
          releaseFollowUp.resolve()
          if(heldFollowUp)await followUpSettled.promise
          page.off('requestfailed',onAuthFailed)
          page.off('response',onAuthResponse)
          await page.unroute(eventsUrl,holdEvents).catch(()=>{})
          await page.unroute(authStatusUrl,holdStaleStatus).catch(()=>{})
        }
      } finally { await pairFlow.dispose() }
    } finally { await tab.close().catch(()=>{}) }
    await connecting.waitFor({state:'hidden'})
    assert.equal(await (await focus()).inputValue(),draft)
    assert(eventSources()>beforeRevoke,'Re-pairing must open a new real EventSource')
    assert.equal(page.url(),url.href,'Original document stays on its conversation')
    evidence.repairedWithDraft=true
    evidence.crossOriginRePairLink=fromLink
  }
  await command('reset')
  return evidence
}

export async function revokedLauncher({context,url,messages}){
  const page=await context.newPage()
  try {
    await page.goto(url.href,{waitUntil:'domcontentloaded'})
    const connect=page.getByRole('button',{name:messages['folderSelection.servers.dialog.connect'],exact:true})
    await connect.waitFor()
    const password=messages['authRecovery.password']
    // Playwright's DOM-based snapshot still lists inert controls.
    const accessibility=await context.newCDPSession(page)
    const observePassword=async()=>{
      assert.equal(await page.getByText(password,{exact:true}).count(),0)
      assert.equal(await page.getByLabel(password,{exact:true}).count(),0)
      const generic=await page.getByLabel('Password input',{exact:true}).evaluateAll(fields=>fields.map(field=>{
        const rect=field.getBoundingClientRect(),style=getComputedStyle(field)
        return {bridge:field instanceof HTMLInputElement&&field.type==='password'&&field.parentElement===document.body&&
          field.inert&&field.tabIndex===-1&&field!==document.activeElement&&style.opacity==='0'&&style.pointerEvents==='none',
          tag:field.tagName,type:field.type,tabIndex:field.tabIndex,focused:field===document.activeElement,
          opacity:style.opacity,pointerEvents:style.pointerEvents,rect:[rect.width,rect.height]}
      }))
      assert(generic.length<=1&&generic.every(field=>field.bridge),`Only Rune's hidden password proxy may carry the generic label: ${JSON.stringify(generic)}`)
      assert.equal(await page.locator('input[type=password]').count(),generic.length,'Reject password controls with any other label')
      const {nodes}=await accessibility.send('Accessibility.getFullAXTree')
      assert(!nodes.some(node=>!node.ignored&&node.name?.value==='Password input'),'The inactive password proxy must stay out of the accessibility tree')
    }
    for(let i=0;i<4;i++){
      await page.keyboard.press('Tab')
      assert.equal(await page.locator('input[type=password]:focus').count(),0,'No launcher gesture may activate a password field')
    }
    await observePassword()
    await command('revoke')
    const box=await connect.boundingBox();assert(box)
    await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2)
    await page.getByRole('dialog',{name:messages['authRecovery.pairingTitle'],exact:true}).waitFor()
    await observePassword()
    assert.equal(await connect.count(),0,'Pairing replaces the launcher form instead of covering it')
    return {launcherRevokedNoPassword:true}
  } finally {
    await page.evaluate(()=>globalThis.__fixtureFlushTouches?.()).catch(()=>{})
    await page.close()
  }
}

export async function preparePair(tab, url, {fromLink=false,assets,waitForRune=Boolean(assets),returnLocale=url.searchParams.get('locale'),waitUntil='load'}={}){
  const pairPath='/api/remote-control/pair'
  const referrer='https://rune-pair-source.test/'
  let observedReferrer
  const routePair=async route=>{
    const req=route.request(), requested=new URL(req.url())
    if(fromLink&&requested.href===referrer){
      const target=url.href.replaceAll('&','&amp;').replaceAll('"','&quot;')
      return route.fulfill({contentType:'text/html',body:`<a href="${target}">Pair</a>`})
    }
    if(requested.origin===url.origin&&requested.pathname==='/remote-pair'&&req.isNavigationRequest()){
      observedReferrer=(await req.allHeaders()).referer
    }
    const exchange=requested.pathname===pairPath&&req.method()==='POST'&&req.postDataJSON()?.code===url.hash.slice(1)
    return requested.origin===url.origin&&(exchange||req.method()==='GET'&&
      (['/remote-pair','/'].includes(requested.pathname)||assets?.has(requested.pathname)||
        assets&&!waitForRune&&requested.pathname.startsWith('/api/')))
      ?route.continue():route.abort()
  }
  await tab.route('**/*', routePair)
  try {
    if(fromLink)await tab.goto(referrer)
  } catch (err) {
    await tab.unroute('**/*', routePair).catch(()=>{})
    throw err
  }
  return {
    async complete(){
      const document=tab.waitForResponse(response=>response.request().isNavigationRequest()&&
        new URL(response.url()).origin===url.origin&&new URL(response.url()).pathname==='/remote-pair')
      void document.catch(()=>{})
      const exchange=tab.waitForResponse(response=>new URL(response.url()).pathname===pairPath)
      void exchange.catch(()=>{})
      if(fromLink)await tab.getByRole('link',{name:'Pair',exact:true}).click({noWaitAfter:true})
      else await tab.goto(url.href,{waitUntil:'commit'})
      const status=(await document).status()
      if(fromLink)assert.equal(observedReferrer,referrer,'Pairing navigation must carry a real cross-origin Referer')
      assert.equal(status,200,'Serve the pairing document even with a foreign Referer')
      assert.equal((await exchange).status(),200)
      await tab.waitForURL(target=>target.pathname==='/' && target.searchParams.get('locale')===returnLocale,
        {waitUntil})
      if(waitForRune)await tab.waitForFunction(()=>globalThis.__codenomadRuneBoot?.state==='ready',undefined,{timeout:60000})
    },
    async dispose(){
      await tab.unroute('**/*',routePair).catch(()=>{})
    },
  }
}

export async function navigatePair(tab, url, options){
  const flow=await preparePair(tab, url, options)
  try { await flow.complete() } finally { await flow.dispose() }
}
