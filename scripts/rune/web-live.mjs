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

export async function admitLiveRoute(req, {policy, origin, forbiddenRequests, onForbidden}){
  const requested=new URL(req.url())
  const allowed=policy
    ? await policy.request(req,{allowApi:true})
    : req.method()==='GET'&&requested.origin===origin&&Boolean((await req.allHeaders()).cookie)
  if(!allowed){
    const entry={origin:requested.origin,path:requested.pathname}
    forbiddenRequests?.push(entry)
    onForbidden?.(new Error(`Forbidden live route request: ${req.method()} ${entry.origin}${entry.path}`))
  }
  return allowed
}

function settleWithin(promise, abort, ms=2_000){
  let timer
  return Promise.race([
    promise,
    ...(abort?[abort]:[]),
    new Promise(resolve=>{ timer=setTimeout(resolve,ms); timer.unref?.() }),
  ]).finally(()=>clearTimeout(timer))
}

async function fetchOwnedStatus(route, origin, context, attestedGet){
  assert(typeof attestedGet==='function','Attested status fetcher required')
  const requested=new URL(route.request().url())
  assert.equal(requested.origin,origin,'Auth status request must stay on the owned origin')
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

const SSE_RETRY1_MIN_MS=750
const SSE_RETRY1_MAX_MS=2250
const SSE_RETRY2_MIN_MS=1600
const SSE_RETRY2_MAX_MS=3500
const HANDOVER_SAME_FRAME_MS=100

function probeDelayMs(probes, index){
  return probes[index].receivedAt-probes[index-1].fulfilledAt
}

function inRetry1Window(delayMs){
  return delayMs>=SSE_RETRY1_MIN_MS&&delayMs<=SSE_RETRY1_MAX_MS
}

function inRetry2Window(delayMs, delay1Ms){
  return delayMs>=SSE_RETRY2_MIN_MS&&delayMs<=SSE_RETRY2_MAX_MS&&delayMs>delay1Ms
}

function hasMultiplexHandover(probes, handover, targetIndex){
  if(!handover||handover.sseOpenedAt==null)return false
  const targetAt=probes[targetIndex].receivedAt
  if(handover.sseOpenedAt>targetAt)return false
  const syncs=handover.conversationSyncTimes||[]
  const nextAt=probes[targetIndex+1]?.receivedAt??Infinity
  const latestAt=Math.min(targetAt+HANDOVER_SAME_FRAME_MS,nextAt)
  if(targetIndex===1){
    const delay=probeDelayMs(probes,1)
    if(delay<SSE_RETRY1_MIN_MS)return syncs.some(at=>at<=latestAt)
    return delay<1000&&syncs.some(at=>at>probes[0].fulfilledAt&&at<=latestAt)
  }
  if(targetIndex===2){
    return probeDelayMs(probes,2)<SSE_RETRY2_MIN_MS&&
      syncs.some(at=>at>probes[0].fulfilledAt&&at<=latestAt)
  }
  return false
}

export function shouldServeSse503(probes, handover){
  if(probes.length<=2)return true
  if(probes.length===3){
    const delay1=probeDelayMs(probes,1)
    const delay2=probeDelayMs(probes,2)
    if(inRetry1Window(delay1)&&inRetry2Window(delay2,delay1))return false
    return hasMultiplexHandover(probes,handover,1)||
      (inRetry1Window(delay1)&&hasMultiplexHandover(probes,handover,2))
  }
  if(probes.length===4){
    const delay1=probeDelayMs(probes,2)
    const delay2=probeDelayMs(probes,3)
    if(hasMultiplexHandover(probes,handover,1)&&inRetry1Window(delay1)&&inRetry2Window(delay2,delay1))return false
    return inRetry1Window(probeDelayMs(probes,1))&&hasMultiplexHandover(probes,handover,2)&&inRetry1Window(delay2)
  }
  return false
}

export function assertSse503Backoff(probes, handover){
  assert(probes.length>=3&&probes.length<=5,
    `Expected 3 to 5 /api/auth/status probes for one multiplexed SSE episode, observed ${probes.length}`)
  if(probes.length===4){
    assert(hasMultiplexHandover(probes,handover,1),
      '4-probe SSE 503 recovery requires independent proof of a two-slot multiplexed handover before retry 1')
  } else if(probes.length===5){
    const priorRetry1Ms=probeDelayMs(probes,1)
    assert(inRetry1Window(priorRetry1Ms),
      `Expected 5-probe multiplexed handover to follow a ~1 s first retry (${SSE_RETRY1_MIN_MS}-${SSE_RETRY1_MAX_MS} ms), observed ${Math.round(priorRetry1Ms)} ms`)
    assert(hasMultiplexHandover(probes,handover,2),
      '5-probe SSE 503 recovery requires independent proof of a two-slot multiplexed handover before retry 2')
  }
  const start=probes.length-3
  const retryDelay1Ms=probeDelayMs(probes,start+1)
  const retryDelay2Ms=probeDelayMs(probes,start+2)
  assert(inRetry1Window(retryDelay1Ms),
    `Expected first bounded retry delay (~1 s, ${SSE_RETRY1_MIN_MS}-${SSE_RETRY1_MAX_MS} ms), observed ${Math.round(retryDelay1Ms)} ms`)
  assert(inRetry2Window(retryDelay2Ms,retryDelay1Ms),
    `Expected second bounded retry delay (~2 s, ${SSE_RETRY2_MIN_MS}-${SSE_RETRY2_MAX_MS} ms and > ${Math.round(retryDelay1Ms)} ms), observed ${Math.round(retryDelay2Ms)} ms`)
  return {retryDelay1Ms,retryDelay2Ms,coalescedSlotProbes:start}
}

async function verifySseAuthenticated503Recovery({
  page,context,url,messages,eventSources,policy,forbiddenRequests,fromLink,connecting,focus,draft,attestedGet,
}){
  const again=new URL(await command('pair'))
  assert.equal(again.origin,url.origin)
  assert.equal(again.pathname,'/remote-pair')
  again.searchParams.set('locale','he')
  const dialog=page.getByRole('dialog',{name:messages['authRecovery.pairingTitle']})
  const authStatusUrl=`${url.origin}/api/auth/status`
  const eventsUrl=`${url.origin}/api/events*`
  let transient503s=0
  let recoveredStatuses=0
  let retryDelay1Ms=0
  let retryDelay2Ms=0
  let coalescedSlotProbes=0
  let forbiddenError=null
  const tab=await context.newPage()
  try {
    const pairFlow=await preparePair(tab, again, {fromLink, waitUntil:'commit'})
    try {
      await page.bringToFront()
      let injectTransient503=false
      let sseGate='pass'
      let sseAdmitted=false
      let recovered=false
      let routeError=null
      let sseBeforeFirstProbe=0
      const statusProbes=[]
      const handover={sseOpenedAt:null,conversationSyncTimes:[]}
      let notifyHandoverSync=null
      const waitForSameFrameHandover=async(probes)=>{
        if(probes.length!==3||shouldServeSse503(probes,handover))return
        const delay1=probeDelayMs(probes,1),delay2=probeDelayMs(probes,2)
        if(inRetry1Window(delay1)&&inRetry2Window(delay2,delay1))return
        if(!(delay1<1000||(inRetry1Window(delay1)&&delay2<SSE_RETRY2_MIN_MS)))return
        const waiter=Promise.withResolvers()
        notifyHandoverSync=()=>{ if(!injectTransient503||shouldServeSse503(probes,handover))waiter.resolve() }
        try {
          await settleWithin(waiter.promise,forbiddenDone,HANDOVER_SAME_FRAME_MS)
        } finally {
          notifyHandoverSync=null
        }
      }
      const first503Served=Promise.withResolvers()
      const releaseRecovered=Promise.withResolvers()
      const releaseHeldSse=Promise.withResolvers()
      const recoveredCaptured=Promise.withResolvers()
      const forbiddenRejected=Promise.withResolvers()
      const forbiddenDone=forbiddenRejected.promise.catch(()=>{})
      void first503Served.promise.catch(()=>{})
      void recoveredCaptured.promise.catch(()=>{})
      const failForbidden=err=>{
        forbiddenError??=err
        forbiddenRejected.reject(err)
      }
      const failRoute=err=>{
        routeError??=err
        first503Served.reject(err)
        recoveredCaptured.reject(err)
      }
      const step=promise=>Promise.race([promise,forbiddenRejected.promise])
      const admitRoute=req=>admitLiveRoute(req,{policy,origin:url.origin,forbiddenRequests,onForbidden:failForbidden})
      const onSseResponse=res=>{
        if(!injectTransient503||handover.sseOpenedAt!==null)return
        const req=res.request()
        if(req.resourceType()==='eventsource'&&res.status()===200){
          const target=new URL(res.url())
          if(target.origin===url.origin&&target.pathname==='/api/events'){
            handover.sseOpenedAt=performance.now()
            notifyHandoverSync?.()
          }
        }
      }
      const onConversationRequest=req=>{
        if(!injectTransient503||!sseAdmitted)return
        const target=new URL(req.url())
        if(target.origin!==url.origin)return
        if((req.method()==='GET'&&(/^\/workspaces\/[^/]+\/instance\/api\/session\/[^/]+$/.test(target.pathname)||
            /^\/api\/workspaces\/[^/]+\/worktrees$/.test(target.pathname)))||
          (req.method()==='POST'&&/^\/api\/workspaces\/[^/]+\/session-history\/window$/.test(target.pathname))){
          handover.conversationSyncTimes.push(performance.now())
          notifyHandoverSync?.()
        }
      }
      const routeEvents=async route=>{
        if(sseGate==='pass')return route.fallback()
        if(sseGate==='abort')return route.abort().catch(()=>{})
        if(!await admitRoute(route.request()))return route.abort('blockedbyclient')
        if(sseGate==='pass')return route.fallback()
        if(sseGate==='abort')return route.abort().catch(()=>{})
        if(sseGate==='admit-one'){
          sseGate='hold'
          sseAdmitted=true
          return route.fallback()
        }
        if(sseGate==='hold'){
          const pass=await releaseHeldSse.promise
          return (pass?route.fallback():route.abort()).catch(()=>{})
        }
        try {
          await route.fulfill({status:503,contentType:'application/json',body:'{}'})
        } catch (err) {
          if(injectTransient503)failRoute(err)
        }
      }
      const routeStatus=async route=>{
        const receivedAt=performance.now()
        if(route.request().method()!=='GET')return route.fallback()
        if(!await admitRoute(route.request()))return route.abort('blockedbyclient')
        if(!injectTransient503)return route.fallback()
        const probe={receivedAt,fulfilledAt:receivedAt}
        statusProbes.push(probe)
        const attempt=statusProbes.length
        if(attempt===1)sseBeforeFirstProbe=eventSources()
        if(recoveredStatuses>0||attempt>5){
          failRoute(new Error(`Unexpected /api/auth/status probe #${attempt} after bounded SSE 503 recovery`))
          await route.abort().catch(()=>{})
          return
        }
        await waitForSameFrameHandover(statusProbes)
        if(!injectTransient503){
          await route.abort().catch(()=>{})
          return
        }
        if(shouldServeSse503(statusProbes,handover)){
          transient503s++
          try {
            await route.fulfill({status:503,contentType:'application/json',body:'{}'})
            probe.fulfilledAt=performance.now()
            if(attempt===1)first503Served.resolve()
          } catch (err) {
            if(injectTransient503)failRoute(err)
            await route.abort().catch(()=>{})
          }
          return
        }
        try {
          const deliver=await releaseRecovered.promise
          if(!deliver||!injectTransient503){
            await route.abort().catch(()=>{})
            return
          }
          const {status,headers,text,body}=await fetchOwnedStatus(route,url.origin,context,attestedGet)
          if(!injectTransient503){
            await route.abort().catch(()=>{})
            return
          }
          assert.equal(body.authenticated,true)
          assert(!body.pairingRequired)
          recoveredStatuses++
          await route.fulfill({status,headers,body:text})
          probe.fulfilledAt=performance.now()
          recoveredCaptured.resolve()
        } catch (err) {
          failRoute(err)
          await route.abort().catch(()=>{})
        }
      }
      try {
        page.on('response',onSseResponse)
        page.on('request',onConversationRequest)
        await page.route(eventsUrl,routeEvents)
        await page.route(authStatusUrl,routeStatus)
        await step(command('revoke'))
        await step(dialog.waitFor({timeout:15_000}))
        await step(page.getByText(messages['rune.pairing_guide'],{exact:true}).waitFor())
        await step(page.evaluate(()=>{
          globalThis.__runeSse503Signals=[]
          const onFocus=()=>globalThis.__runeSse503Signals.push('focus')
          const onVis=()=>{ if(document.visibilityState==='visible')globalThis.__runeSse503Signals.push('visibility') }
          window.addEventListener('focus',onFocus)
          document.addEventListener('visibilitychange',onVis)
          globalThis.__runeCleanupSse503Signals=()=>{
            window.removeEventListener('focus',onFocus)
            document.removeEventListener('visibilitychange',onVis)
            const signals=globalThis.__runeSse503Signals
            delete globalThis.__runeSse503Signals
            delete globalThis.__runeCleanupSse503Signals
            return signals
          }
        }))
        const beforeSseAuth=eventSources()
        sseGate='block'
        injectTransient503=true
        // Re-pair in the prepared tab without returning focus or clicking Check, then admit exactly
        // one authenticated EventSource so a single SSE episode drives both bounded retries (1 s, 2 s).
        await step(pairFlow.complete())
        sseGate='admit-one'
        try {
          await step(withBudget(now()+20_000,'first transient 503 on SSE-driven /api/auth/status',
            ()=>step(first503Served.promise)))
          assert.equal(await step(dialog.count()),1,'Pairing overlay must stay visible after the first transient 503 status failure')
          releaseRecovered.resolve(true)
        } catch (err) {
          injectTransient503=false
          releaseRecovered.resolve(false)
          throw err
        }
        await step(withBudget(now()+20_000,'bounded retry /api/auth/status 200 after transient 503s',
          ()=>step(recoveredCaptured.promise)))
        if(forbiddenError)throw forbiddenError
        if(routeError)throw routeError
        await step(dialog.waitFor({state:'detached',timeout:10_000}))
        const accidentalSignals=await step(page.evaluate(()=>globalThis.__runeCleanupSse503Signals?.()??[]))
        assert.deepEqual(accidentalSignals,[],'Authenticated SSE + 503 recovery must not rely on focus or visibility events')
        assert(sseBeforeFirstProbe>beforeSseAuth,'Authenticated SSE 200 on the original page must precede the first /api/auth/status probe')
        ;({retryDelay1Ms,retryDelay2Ms,coalescedSlotProbes}=assertSse503Backoff(statusProbes,handover))
        assert.equal(transient503s,statusProbes.length-1,'Every pre-recovery /api/auth/status probe must receive 503')
        assert.equal(recoveredStatuses,1,'Bounded retry must settle once with 200 /api/auth/status')
        recovered=true
      } catch (err) {
        if(forbiddenError)throw forbiddenError
        if(routeError)throw routeError
        throw err
      } finally {
        injectTransient503=false
        sseGate=recovered?'pass':'abort'
        notifyHandoverSync?.()
        releaseRecovered.resolve(false)
        releaseHeldSse.resolve(recovered)
        page.off('response',onSseResponse)
        page.off('request',onConversationRequest)
        await page.unroute(authStatusUrl,routeStatus).catch(()=>{})
        await page.unroute(eventsUrl,routeEvents).catch(()=>{})
        await settleWithin(page.evaluate(()=>globalThis.__runeCleanupSse503Signals?.()).catch(()=>{}),forbiddenDone)
      }
    } finally { await pairFlow.dispose() }
  } finally { await tab.close().catch(()=>{}) }
  await connecting.waitFor({state:'hidden',timeout:15_000})
  assert.equal(await (await focus()).inputValue(),draft)
  assert.equal(page.url(),url.href,'Original document stays on its conversation after SSE 503 recovery')
  return {transient503s,recoveredStatuses,coalescedSlotProbes,retryDelay1Ms:Math.round(retryDelay1Ms),retryDelay2Ms:Math.round(retryDelay2Ms)}
}

export async function mobileLive({page,context,url,messages,revoke,eventSources,workspaces,policy,forbiddenRequests=[],fromLink=true,tap=(x,y)=>page.touchscreen.tap(x,y),onRestart,attestedGet}){
  const forbiddenBefore=forbiddenRequests.length
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
        let focusForbiddenError=null
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
        const focusForbiddenRejected=Promise.withResolvers()
        const focusForbiddenDone=focusForbiddenRejected.promise.catch(()=>{})
        const failFocusForbidden=err=>{
          focusForbiddenError??=err
          focusForbiddenRejected.reject(err)
        }
        const focusStep=promise=>Promise.race([promise,focusForbiddenRejected.promise])
        let followUpCleaned=false
        const settleFollowUp=async()=>{
          if(!followUpCleaned&&!focusForbiddenError&&heldFollowUp){
            followUpCleaned=true
            await settleWithin(followUpSettled.promise,focusForbiddenDone)
          }
        }
        const admitRoute=req=>admitLiveRoute(req,{policy,origin:url.origin,forbiddenRequests,onForbidden:failFocusForbidden})
        const holdEvents=async route=>{
          if(!blockEvents)return route.fallback()
          if(!await admitRoute(route.request()))return route.abort('blockedbyclient')
          if(!blockEvents)return route.fallback()
          try {
            await route.fulfill({status:503,contentType:'application/json',body:'{}'})
          } catch (err) {
            if(blockEvents){
              staleError??=err
              staleCaptured.reject(err)
              followUpCaptured.reject(err)
            }
          }
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
                const {status,headers,text,body}=await fetchOwnedStatus(route,url.origin,context,attestedGet)
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
            const {status,headers,text,body}=await fetchOwnedStatus(route,url.origin,context,attestedGet)
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
        try {
          page.on('requestfailed',onAuthFailed)
          page.on('response',onAuthResponse)
          await page.route(eventsUrl,holdEvents)
          await page.route(authStatusUrl,holdStaleStatus)
          try {
            await focusStep(page.evaluate(()=>{
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
            }))
            await focusStep(command('revoke'))
            await focusStep(withBudget(now()+10_000,'first pre-pairing auth status capture',
              ()=>focusStep(staleCaptured.promise)))
            assert.equal(await focusStep(dialog.count()),0,'#pairing-recovery must not be open yet while the first /api/auth/status is held')
            // Re-pair in the prepared tab and return focus BEFORE the first status probe delivers pairingRequired=true.
            await focusStep(pairFlow.complete())
            await focusStep(page.bringToFront())
            // Headless shell keeps every page visible/focused across tabs; when bringToFront emits
            // neither signal, dispatch window focus so Rune's real FocusCheck listener runs before release.
            const returnSignal=await focusStep(page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{
              if(!globalThis.__runeReturnSignal)window.dispatchEvent(new Event('focus'))
              requestAnimationFrame(()=>requestAnimationFrame(()=>{
                const signal=globalThis.__runeReturnSignal
                globalThis.__runeCleanupReturnSignal?.()
                resolve(signal)
              }))
            }))))
            assert(returnSignal==='focus'||returnSignal==='visibility','Expected a focus or visibility return signal before releasing the held status probe')
            assert.equal(await focusStep(dialog.count()),0,'Focus return must precede opening of #pairing-recovery')
            assert(!staleDone,'Focus return must precede delivery of the held first status probe')
            assert.equal(staleAborted,null,'Held first status probe must still be in flight when focus returns')
            assert.equal(authStatusRequests,1,'No follow-up /api/auth/status may start before the held probe is delivered')
            assert.equal(eventSources(),beforeRevoke,'SSE must remain blocked so focus/visibility alone drives recovery')
          } finally {
            staleReleased=true
            releaseStale.resolve()
            await settleWithin(page.evaluate(()=>globalThis.__runeCleanupReturnSignal?.()).catch(()=>{}),focusForbiddenDone)
            if(!focusForbiddenError&&heldStale)await settleWithin(staleSettled.promise,focusForbiddenDone)
          }
          if(focusForbiddenError)throw focusForbiddenError
          if(staleError)throw staleError
          assert.equal(staleAborted,null,'Held first status probe must not abort before browser delivery')
          const staleBrowserResponse=await focusStep(withBudget(now()+5_000,'browser receipt of held first auth status',
            ()=>focusStep(staleReceivedByBrowser.promise)))
          assert.equal(staleBrowserResponse.status(),200)
          assert.equal(await focusStep(staleBrowserResponse.finished()),null,'Browser must finish reading the held first status response')
          assert.equal((await focusStep(staleBrowserResponse.json())).pairingRequired,true,'Browser must receive pairingRequired=true from the first probe')
          // Returning focus while the first status probe was in flight must queue a follow-up check
          // immediately once pairingRequired=true opens #pairing-recovery, without any click or SSE help.
          try {
            await focusStep(withBudget(now()+10_000,'follow-up auth status after first stale probe',
              ()=>focusStep(followUpCaptured.promise)))
            await focusStep(dialog.waitFor())
            await focusStep(text(messages['rune.pairing_guide']).waitFor())
            assert.equal(await focusStep(dialog.getByRole('textbox').count()),0,'Browser pairing never shows a password form')
          } finally {
            releaseFollowUp.resolve()
            await settleFollowUp()
          }
          if(focusForbiddenError)throw focusForbiddenError
          await focusStep(dialog.waitFor({state:'detached',timeout:10_000}))
          if(focusForbiddenError)throw focusForbiddenError
          assert.equal(eventSources(),beforeRevoke,'SSE stayed blocked until the pairing overlay dismissed')
          assert(postStaleStatus>=1,'Focus return during the first status probe must trigger a follow-up /api/auth/status check')
        } catch (err) {
          if(focusForbiddenError)throw focusForbiddenError
          throw err
        } finally {
          blockEvents=false
          staleReleased=true
          releaseStale.resolve()
          releaseFollowUp.resolve()
          page.off('requestfailed',onAuthFailed)
          page.off('response',onAuthResponse)
          await settleFollowUp()
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
    evidence.sseAuthenticated503Recovery=await verifySseAuthenticated503Recovery({
      page,context,url,messages,eventSources,policy,forbiddenRequests,fromLink,connecting,focus,draft,attestedGet,
    })
  }
  assert.equal(forbiddenRequests.length,forbiddenBefore,
    `Mobile live intercepted forbidden requests: ${JSON.stringify(forbiddenRequests.slice(forbiddenBefore))}`)
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
