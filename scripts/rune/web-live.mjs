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

function trackPending(pending, promise){
  const run=promise.finally(()=>pending.delete(run))
  pending.add(run)
  return run
}

async function abortRouteOrClose(route, label='route abort', ms=2_000, errorCode){
  const abortErr=await drainWithin([errorCode?route.abort(errorCode):route.abort()],label,ms)
  if(!abortErr)return null
  const target=route.request().frame()?.page()
  if(target&&!target.isClosed()){
    await drainWithin([target.close()],`closing page after failed ${label}`,ms)
  }
  return abortErr
}

async function fulfillOrAbort(pending, route, payload, onError, ms=5_000){
  let err=null
  const run=drainWithin([route.fulfill(payload)],'route fulfill',ms)
    .then(result=>{ if(result){ err=result; onError(result) } })
    .finally(()=>pending.delete(run))
  pending.add(run)
  await run
  if(err)await abortRouteOrClose(route,'route fulfill recovery')
  return !err
}

async function drainWithin(promises, label, ms=2_000){
  if(!promises.length)return null
  const TIMED_OUT=Symbol('timedOut')
  let timer
  const result=await Promise.race([
    Promise.allSettled(promises),
    new Promise(resolve=>{ timer=setTimeout(()=>resolve(TIMED_OUT),ms); timer.unref?.() }),
  ]).finally(()=>clearTimeout(timer))
  if(result===TIMED_OUT)return new Error(`Timed out draining ${label} after ${ms} ms`)
  const rejected=result.find(entry=>entry.status==='rejected')
  return rejected?rejected.reason:null
}

async function drainSetsWithin(sets, label, ms=2_000){
  const deadline=now()+ms
  let firstError=null
  while(true){
    const snapshot=sets.flatMap(set=>[...set])
    if(!snapshot.length)return firstError
    const remaining=deadline-now()
    if(remaining<=0)return firstError??new Error(`Timed out draining ${label} after ${ms} ms`)
    const TIMED_OUT=Symbol('timedOut')
    let timer
    const result=await Promise.race([
      Promise.allSettled(snapshot),
      new Promise(resolve=>{ timer=setTimeout(()=>resolve(TIMED_OUT),remaining); timer.unref?.() }),
    ]).finally(()=>clearTimeout(timer))
    if(result===TIMED_OUT)return firstError??new Error(`Timed out draining ${label} after ${ms} ms`)
    const rejected=result.find(entry=>entry.status==='rejected')
    if(rejected)firstError??=rejected.reason
  }
}

function unrouteBounded(page, routes, label, ms=2_000){
  return drainWithin(
    routes.map(([targetUrl,handler])=>page.unroute(targetUrl,handler)),
    `unrouting ${label}`,
    ms,
  )
}

async function fetchOwnedStatus(route, origin, context, attestedGet, signal){
  assert(typeof attestedGet==='function','Attested status fetcher required')
  const requested=new URL(route.request().url())
  assert.equal(requested.origin,origin,'Auth status request must stay on the owned origin')
  const response=await attestedGet(`${requested.pathname}${requested.search}`,context,{signal})
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

async function runWithPairTab(context, again, options, fn){
  const setupDeadline=options?.setupDeadline??now()+30_000
  const tab=await withBudget(setupDeadline,'creating pairing tab',()=>context.newPage())
  let primaryError=null
  let tabCleanupError=null
  let result
  try {
    const pairFlow=await preparePair(tab, again, {...options,setupDeadline})
    try {
      result=await fn(pairFlow)
    } catch (err) {
      primaryError=err
      throw err
    } finally {
      try { await pairFlow.dispose() } catch (err) { tabCleanupError??=err }
    }
  } catch (err) {
    primaryError??=err
    throw err
  } finally {
    const closeErr=await drainWithin([tab.close()],'closing pairing tab',2_000)
    tabCleanupError??=closeErr
    if(tabCleanupError&&primaryError){
      console.error(`Pairing tab cleanup error after primary failure: ${tabCleanupError.message}`)
    }
  }
  if(tabCleanupError)throw tabCleanupError
  return result
}

const SSE_RETRY1_MIN_MS=750
const SSE_RETRY1_MAX_MS=10_000
const SSE_RETRY2_MIN_MS=1800
const SSE_RETRY2_MAX_MS=15_000

function probeDelayMs(probes, index){
  return probes[index].receivedAt-probes[index-1].fulfilledAt
}

export function assertSse503Backoff(probes){
  assert.equal(probes.length,3,
    `Expected exactly 3 /api/auth/status probes for one SSE-authenticated episode, observed ${probes.length}`)
  const retryDelay1Ms=probeDelayMs(probes,1)
  const retryDelay2Ms=probeDelayMs(probes,2)
  assert(retryDelay1Ms>=SSE_RETRY1_MIN_MS&&retryDelay1Ms<=SSE_RETRY1_MAX_MS,
    `Expected first bounded retry delay (~1 s, ${SSE_RETRY1_MIN_MS}-${SSE_RETRY1_MAX_MS} ms), observed ${Math.round(retryDelay1Ms)} ms`)
  assert(retryDelay2Ms>=SSE_RETRY2_MIN_MS&&retryDelay2Ms<=SSE_RETRY2_MAX_MS,
    `Expected second bounded retry delay (~2 s, ${SSE_RETRY2_MIN_MS}-${SSE_RETRY2_MAX_MS} ms), observed ${Math.round(retryDelay2Ms)} ms`)
  return {retryDelay1Ms,retryDelay2Ms}
}

async function verifySseAuthenticated503Recovery({
  page,context,url,messages,eventSources,policy,forbiddenRequests,fromLink,connecting,focus,draft,tap,attestedGet,
}){
  const setupDeadline=now()+30_000
  const again=new URL(await withBudget(setupDeadline,'creating pairing link before SSE 503 recovery',()=>command('pair')))
  assert.equal(again.origin,url.origin)
  assert.equal(again.pathname,'/remote-pair')
  again.searchParams.set('locale','he')
  const dialog=page.getByRole('dialog',{name:messages['authRecovery.pairingTitle']})
  const authStatusUrl=target=>target.origin===url.origin&&target.pathname==='/api/auth/status'
  const eventsUrl=`${url.origin}/api/events*`
  const metaUrl=`${url.origin}/api/meta`
  let transient503s=0
  let recoveredStatuses=0
  let retryDelay1Ms=0
  let retryDelay2Ms=0
  let episodeDeadline=0
  let forbiddenError=null
  await runWithPairTab(context, again, {fromLink, waitUntil:'commit', setupDeadline}, async pairFlow=>{
      await withBudget(setupDeadline,'focusing original tab before SSE 503 recovery',()=>page.bringToFront())
      let injectTransient503=false
      let observeStatusEpisode=false
      let sseScenarioActive=true
      let sseTeardown=false
      let recoveryReserved=false
      let sseGate='pass'
      let metaGate='pass'
      let admittedSseRequest=null
      let sseResponseAt=null
      let recovered=false
      let routeError=null
      const sseAbort=new AbortController()
      const statusProbes=[]
      const observedStatusRequests=[]
      const observedStatusCodes=[]
      const pendingSseRoutes=new Set()
      const pendingStatusRoutes=new Set()
      const pendingSseFulfills=new Set()
      const pendingHeldRoutes=new Set()
      let teardownFulfillError=null
      const secondProbeArrived=Promise.withResolvers()
      const releaseSecond503=Promise.withResolvers()
      const thirdProbeArrived=Promise.withResolvers()
      const releaseThird200=Promise.withResolvers()
      const releaseHeldSse=Promise.withResolvers()
      const recoveredCaptured=Promise.withResolvers()
      const forbiddenRejected=Promise.withResolvers()
      const forbiddenDone=forbiddenRejected.promise.catch(()=>{})
      const routeFailed=Promise.withResolvers()
      const routeFailedDone=routeFailed.promise.catch(()=>{})
      const sseStop=Promise.race([forbiddenDone,routeFailedDone])
      void secondProbeArrived.promise.catch(()=>{})
      void thirdProbeArrived.promise.catch(()=>{})
      void recoveredCaptured.promise.catch(()=>{})
      const failForbidden=err=>{
        forbiddenError??=err
        releaseSecond503.resolve(false)
        releaseThird200.resolve(false)
        forbiddenRejected.reject(err)
      }
      const failRoute=err=>{
        routeError??=err
        secondProbeArrived.reject(err)
        thirdProbeArrived.reject(err)
        recoveredCaptured.reject(err)
        releaseSecond503.resolve(false)
        releaseThird200.resolve(false)
        routeFailed.reject(err)
      }
      const step=promise=>Promise.race([promise,forbiddenRejected.promise,routeFailed.promise])
      const admitRoute=req=>admitLiveRoute(req,{policy,origin:url.origin,forbiddenRequests,onForbidden:failForbidden})
      const onSseFulfillError=err=>{
        if(sseTeardown)teardownFulfillError??=err
        else failRoute(err)
      }
      const abortSseRoute=async(route,code)=>{
        const err=await abortRouteOrClose(route,'SSE+503 route abort',2_000,code)
        if(err)onSseFulfillError(err)
      }
      const continueSseRoute=async route=>{
        const err=await drainWithin([route.continue()],'SSE+503 route continue',5_000)
        if(!err)return
        if(sseTeardown&&/Route is already handled/i.test(String(err?.message??err)))return
        onSseFulfillError(err)
        await abortRouteOrClose(route,'SSE+503 route continue recovery')
      }
      const checkRoute=async route=>{
        try {
          if(await admitRoute(route.request()))return true
          await abortSseRoute(route,'blockedbyclient')
          return false
        } catch (err) {
          if(sseScenarioActive)failRoute(err)
          await abortSseRoute(route)
          return false
        }
      }
      let heldRouteError=null
      const holdRoute=async route=>{
        const run=releaseHeldSse.promise
          .then(async pass=>{
            if(pass)return continueSseRoute(route)
            const err=await abortRouteOrClose(route,'held SSE route abort')
            if(err)throw err
          })
          .catch(err=>{ heldRouteError??=err })
          .finally(()=>pendingHeldRoutes.delete(run))
        pendingHeldRoutes.add(run)
        await run
      }
      const isAuthStatusUrl=raw=>{
        try {
          const target=new URL(raw)
          return target.origin===url.origin&&target.pathname==='/api/auth/status'
        } catch {
          return false
        }
      }
      const onStatusRequest=req=>{
        if(!observeStatusEpisode||req.method()!=='GET')return
        if(isAuthStatusUrl(req.url()))observedStatusRequests.push(performance.now())
      }
      const onSseResponse=res=>{
        if(!observeStatusEpisode)return
        if(sseResponseAt===null&&admittedSseRequest&&res.request()===admittedSseRequest&&res.status()===200){
          sseResponseAt=performance.now()
          return
        }
        if(res.request().method()!=='GET')return
        if(isAuthStatusUrl(res.url()))observedStatusCodes.push(res.status())
      }
      const routeMeta=route=>trackPending(pendingSseRoutes,(async()=>{
        const entryGate=metaGate
        if(entryGate==='abort')return abortSseRoute(route)
        if(!await checkRoute(route))return
        if(metaGate==='abort')return abortSseRoute(route)
        if(!sseScenarioActive||entryGate==='pass'||metaGate==='pass')return continueSseRoute(route)
        if(entryGate==='admit-one'&&metaGate==='admit-one'){
          metaGate='block'
          return continueSseRoute(route)
        }
        if(entryGate==='hold'||metaGate==='hold')return holdRoute(route)
        await fulfillOrAbort(pendingSseFulfills,route,
          {status:503,contentType:'application/json',body:'{}'},onSseFulfillError)
      })())
      const routeEvents=route=>trackPending(pendingSseRoutes,(async()=>{
        const entryGate=sseGate
        if(entryGate==='abort')return abortSseRoute(route)
        if(!await checkRoute(route))return
        if(sseGate==='abort')return abortSseRoute(route)
        if(!sseScenarioActive||entryGate==='pass'||sseGate==='pass')return continueSseRoute(route)
        if(entryGate==='admit-one'&&sseGate==='admit-one'){
          sseGate='hold'
          metaGate='block'
          admittedSseRequest=route.request()
          return continueSseRoute(route)
        }
        if(entryGate!=='block'&&sseGate==='hold')return holdRoute(route)
        await fulfillOrAbort(pendingSseFulfills,route,
          {status:503,contentType:'application/json',body:'{}'},onSseFulfillError)
      })())
      const routeStatus=route=>trackPending(pendingStatusRoutes,(async()=>{
        const receivedAt=performance.now()
        if(sseGate==='abort')return abortSseRoute(route)
        if(!sseScenarioActive||route.request().method()!=='GET'){
          if(!await checkRoute(route))return
          if(sseGate==='abort')return abortSseRoute(route)
          return continueSseRoute(route)
        }
        const duringEpisode=injectTransient503
        let probe=null
        if(duringEpisode){
          probe={receivedAt,fulfilledAt:receivedAt}
          statusProbes.push(probe)
        }
        const attempt=duringEpisode?statusProbes.length:0
        if(!await checkRoute(route))return
        if(sseGate==='abort')return abortSseRoute(route)
        if(!duringEpisode)return continueSseRoute(route)
        if(!sseScenarioActive||!injectTransient503){
          await abortSseRoute(route)
          return
        }
        if(attempt===1){
          if(!await fulfillOrAbort(pendingSseFulfills,route,
            {status:503,contentType:'application/json',body:'{}'},onSseFulfillError))return
          transient503s++
          probe.fulfilledAt=performance.now()
          return
        }
        if(attempt===2){
          secondProbeArrived.resolve()
          const deliver=await releaseSecond503.promise
          if(!deliver||!injectTransient503){
            await abortSseRoute(route)
            return
          }
          if(metaGate==='block')metaGate='hold'
          if(!await fulfillOrAbort(pendingSseFulfills,route,
            {status:503,contentType:'application/json',body:'{}'},onSseFulfillError))return
          transient503s++
          probe.fulfilledAt=performance.now()
          return
        }
        if(attempt!==3||recoveryReserved||recoveredStatuses>0){
          failRoute(new Error(`Unexpected /api/auth/status probe #${attempt} during bounded SSE 503 recovery`))
          await abortSseRoute(route)
          return
        }
        recoveryReserved=true
        thirdProbeArrived.resolve()
        let fulfillError=null
        try {
          const deliver=await releaseThird200.promise
          if(!deliver||!injectTransient503){
            await abortSseRoute(route)
            return
          }
          const {status,headers,text,body}=await fetchOwnedStatus(route,url.origin,context,attestedGet,sseAbort.signal)
          if(!injectTransient503){
            await abortSseRoute(route)
            return
          }
          assert.equal(body.authenticated,true)
          assert(!body.pairingRequired)
          if(!await fulfillOrAbort(pendingSseFulfills,route,{status,headers,body:text},
            err=>{ fulfillError=err; onSseFulfillError(err) }))throw fulfillError
          recoveredStatuses++
          probe.fulfilledAt=performance.now()
          recoveredCaptured.resolve()
        } catch (err) {
          if(!sseTeardown)failRoute(err)
          if(!fulfillError)await abortSseRoute(route)
        }
      })())
      let cleanupError=null
      try {
        page.on('request',onStatusRequest)
        page.on('response',onSseResponse)
        try {
          await withBudget(setupDeadline,'installing SSE 503 /api/meta route',()=>page.route(metaUrl,routeMeta))
          await withBudget(setupDeadline,'installing SSE 503 /api/events route',()=>page.route(eventsUrl,routeEvents))
          await withBudget(setupDeadline,'installing SSE 503 /api/auth/status route',()=>page.route(authStatusUrl,routeStatus))
          await step(withBudget(setupDeadline,'revoking session before SSE 503 recovery',()=>step(command('revoke'))))
          await step(withBudget(setupDeadline,'pairing overlay visible after revoke',
            ms=>dialog.waitFor({timeout:Math.max(1,Math.round(ms))})))
          await step(withBudget(setupDeadline,'pairing guide visible after revoke',
            ms=>page.getByText(messages['rune.pairing_guide'],{exact:true}).waitFor({timeout:Math.max(1,Math.round(ms))})))
          await step(withBudget(setupDeadline,'installing SSE 503 browser observer',()=>page.evaluate(targetOrigin=>{
            globalThis.__runeSse503Signals=[]
            const browserProbes=[]
            const pushEntry=entry=>{
              let parsed
              try { parsed=new URL(entry.name) } catch { return }
              if(parsed.origin!==targetOrigin||parsed.pathname!=='/api/auth/status')return
              const responseAt=entry.responseStart>0?entry.responseStart:entry.responseEnd
              browserProbes.push({
                receivedAt:entry.startTime,
                fulfilledAt:responseAt,
              })
            }
            const flush=()=>{ for(const entry of observer.takeRecords())pushEntry(entry) }
            const onFocus=()=>globalThis.__runeSse503Signals.push('focus')
            const onVis=()=>{ if(document.visibilityState==='visible')globalThis.__runeSse503Signals.push('visibility') }
            const observer=new PerformanceObserver(list=>{
              for(const entry of list.getEntries())pushEntry(entry)
            })
            observer.observe({type:'resource',buffered:false})
            window.addEventListener('focus',onFocus)
            document.addEventListener('visibilitychange',onVis)
            globalThis.__runeSse503ProbesCount=()=>{
              flush()
              return browserProbes.length
            }
            globalThis.__runeCleanupSse503Signals=()=>{
              flush()
              observer.disconnect()
              window.removeEventListener('focus',onFocus)
              document.removeEventListener('visibilitychange',onVis)
              const signals=globalThis.__runeSse503Signals
              delete globalThis.__runeSse503Signals
              delete globalThis.__runeSse503ProbesCount
              delete globalThis.__runeCleanupSse503Signals
              return {signals,browserProbes}
            }
          },url.origin)))
          const beforeSseAuth=eventSources()
          metaGate='block'
          sseGate='block'
          observeStatusEpisode=true
          injectTransient503=true
          // Re-pair in the prepared tab without returning focus or clicking Check, then admit one
          // /api/meta attestation and one /api/events stream so only one multiplexed subscriber
          // attaches and drives both bounded retries (1 s, 2 s) before releasing the other subscriber.
          await step(withBudget(setupDeadline,'completing re-pairing before SSE 503 recovery',()=>step(pairFlow.complete())))
          metaGate='admit-one'
          sseGate='admit-one'
          episodeDeadline=now()+30_000
          try {
            await step(withBudget(episodeDeadline,'second /api/auth/status probe after first transient 503',
              ()=>step(secondProbeArrived.promise)))
            assert.equal(await step(withBudget(episodeDeadline,'pairing overlay visible after first 503',
              ()=>dialog.count())),1,'Pairing overlay must stay visible after Rune processes the first transient 503')
            releaseSecond503.resolve(true)
            await step(withBudget(episodeDeadline,'third /api/auth/status probe after second transient 503',
              ()=>step(thirdProbeArrived.promise)))
            assert.equal(await step(withBudget(episodeDeadline,'pairing overlay visible after second 503',
              ()=>dialog.count())),1,'Pairing overlay must stay visible after Rune processes the second transient 503')
            releaseThird200.resolve(true)
          } catch (err) {
            injectTransient503=false
            releaseSecond503.resolve(false)
            releaseThird200.resolve(false)
            throw err
          }
          await step(withBudget(episodeDeadline,'bounded retry /api/auth/status 200 after transient 503s',
            ()=>step(recoveredCaptured.promise)))
          if(forbiddenError)throw forbiddenError
          if(routeError)throw routeError
          await step(withBudget(episodeDeadline,'pairing overlay detached after SSE 503 recovery',
            ms=>dialog.waitFor({state:'detached',timeout:Math.max(1,Math.round(ms))})))
          if(forbiddenError)throw forbiddenError
          if(routeError)throw routeError
          await step(withBudget(episodeDeadline,'browser /api/auth/status resource timings',
            ms=>page.waitForFunction(()=>(globalThis.__runeSse503ProbesCount?.()??0)>=3,undefined,{timeout:Math.max(1,Math.round(ms))})))
          const {signals:accidentalSignals,browserProbes}=await step(withBudget(episodeDeadline,'collecting SSE 503 browser metrics',
            ()=>page.evaluate(()=>globalThis.__runeCleanupSse503Signals?.()??{signals:[],browserProbes:[]})))
          assert.deepEqual(accidentalSignals,[],'Authenticated SSE + 503 recovery must not rely on focus or visibility events')
          assert(eventSources()>beforeSseAuth,'Authenticated SSE 200 on the original page must be observed')
          if(forbiddenError)throw forbiddenError
          if(routeError)throw routeError
          assert.equal(statusProbes.length,3,
            `Expected exactly 3 intercepted /api/auth/status probes, observed ${statusProbes.length}`)
          assert(sseResponseAt!==null&&sseResponseAt<=statusProbes[0].receivedAt,
            'Authenticated SSE 200 on the original page must precede the first /api/auth/status probe')
          assert.equal(observedStatusRequests.length,3,
            `Expected exactly 3 /api/auth/status requests during SSE 503 recovery, observed ${observedStatusRequests.length}`)
          assert.deepEqual(observedStatusCodes,[503,503,200],
            'Browser must receive exact [503, 503, 200] statuses for /api/auth/status probes')
          assert(browserProbes.every(p=>p.receivedAt>0&&p.fulfilledAt>=p.receivedAt),
            'Browser resource timings for /api/auth/status probes must be monotonic')
          ;({retryDelay1Ms,retryDelay2Ms}=assertSse503Backoff(browserProbes))
          assert.equal(transient503s,2,'Two transient 503 /api/auth/status responses must be exercised')
          assert.equal(recoveredStatuses,1,'Bounded retry must settle once with 200 /api/auth/status')
          recovered=true
        } catch (err) {
          if(forbiddenError)throw forbiddenError
          if(routeError)throw routeError
          throw err
        } finally {
          sseTeardown=true
          sseScenarioActive=false
          injectTransient503=false
          sseGate=recovered?'pass':'abort'
          metaGate=recovered?'pass':'abort'
          sseAbort.abort()
          releaseSecond503.resolve(false)
          releaseThird200.resolve(false)
          releaseHeldSse.resolve(recovered)
          const heldDrainErr=await drainSetsWithin([pendingHeldRoutes],'held SSE+503 routes',2_000)
          const unrouteErr=await unrouteBounded(page,[[authStatusUrl,routeStatus],[eventsUrl,routeEvents],[metaUrl,routeMeta]],'SSE+503 routes',2_000)
          const drainErr=await drainSetsWithin([pendingSseRoutes,pendingStatusRoutes,pendingSseFulfills,pendingHeldRoutes],'SSE+503 routes',2_000)
          cleanupError??=heldRouteError??teardownFulfillError??heldDrainErr??unrouteErr??drainErr
          await settleWithin(page.evaluate(()=>globalThis.__runeCleanupSse503Signals?.()).catch(()=>{}),sseStop)
        }
        if(cleanupError)throw cleanupError
        if(forbiddenError)throw forbiddenError
        if(routeError)throw routeError
        await withBudget(episodeDeadline,'reconnection settled after SSE 503 recovery',
          ms=>connecting.waitFor({state:'hidden',timeout:Math.max(1,Math.round(ms))}))
        const right=messages['window.menu.rightPanel']
        const rightDrawer=page.getByRole('region',{name:right,exact:true})
        const rightToggle=page.getByRole('button',{name:right,exact:true})
        const tapLocator=async(locator,label)=>{
          const box=await withBudget(episodeDeadline,`${label} bounds`,
            ms=>locator.boundingBox({timeout:Math.max(1,Math.round(ms))}))
          assert(box&&box.width>0&&box.height>0,`Expected visible bounds for ${label}`)
          await withBudget(episodeDeadline,`tapping ${label}`,()=>tap(box.x+box.width/2,box.y+box.height/2))
        }
        let openedRightDrawer=false
        try {
          const expanded=await withBudget(episodeDeadline,'right panel expanded state',
            ms=>rightToggle.getAttribute('aria-expanded',{timeout:Math.max(1,Math.round(ms))}))
          if(expanded!=='true'){
            await tapLocator(rightToggle,'right panel toggle')
            openedRightDrawer=true
          }
          await withBudget(episodeDeadline,'right panel visible after SSE 503 recovery',
            ms=>rightDrawer.waitFor({timeout:Math.max(1,Math.round(ms))}))
          const statusTab=rightDrawer.getByRole('tab',{name:messages['instanceShell.rightPanel.tabs.status'],exact:true})
          const statusSelected=await withBudget(episodeDeadline,'status tab selected state',
            ms=>statusTab.getAttribute('aria-selected',{timeout:Math.max(1,Math.round(ms))}))
          if(statusSelected!=='true'){
            await tapLocator(statusTab,'status tab')
          }
          await withBudget(episodeDeadline,'confirmed connected status after SSE 503 recovery',
            ms=>rightDrawer.getByText(messages['instanceShell.connection.connected'],{exact:true}).waitFor({timeout:Math.max(1,Math.round(ms))}))
          if(openedRightDrawer){
            await tapLocator(rightToggle,'closing right panel toggle')
            await withBudget(episodeDeadline,'right panel hidden after SSE 503 recovery',
              ms=>rightDrawer.waitFor({state:'hidden',timeout:Math.max(1,Math.round(ms))}))
            openedRightDrawer=false
          }
        } finally {
          if(openedRightDrawer){
            await settleWithin((async()=>{
              const box=await rightToggle.boundingBox({timeout:1_000})
              if(box&&box.width>0&&box.height>0)await tap(box.x+box.width/2,box.y+box.height/2)
              await rightDrawer.waitFor({state:'hidden',timeout:1_500})
            })().catch(()=>{}),sseStop,2_000)
          }
        }
        assert.equal(observedStatusRequests.length,3,
          `Expected exactly 3 /api/auth/status requests through confirmed reconnection, observed ${observedStatusRequests.length}`)
        assert.deepEqual(observedStatusCodes,[503,503,200],
          'Browser must receive exact [503, 503, 200] statuses through confirmed reconnection')
      } finally {
        observeStatusEpisode=false
        page.off('request',onStatusRequest)
        page.off('response',onSseResponse)
      }
  })
  const editor=await withBudget(episodeDeadline,'focusing composer after SSE 503 recovery',()=>focus())
  const preservedDraft=await withBudget(episodeDeadline,'reading preserved draft after SSE 503 recovery',
    ms=>editor.inputValue({timeout:Math.max(1,Math.round(ms))}))
  assert.equal(preservedDraft,draft)
  assert.equal(page.url(),url.href,'Original document stays on its conversation after SSE 503 recovery')
  return {transient503s,recoveredStatuses,retryDelay1Ms:Math.round(retryDelay1Ms),retryDelay2Ms:Math.round(retryDelay2Ms)}
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
    await runWithPairTab(context, again, {fromLink, waitUntil:'commit'}, async pairFlow=>{
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
        let focusActive=true
        let focusTeardown=false
        let postStaleStatus=0
        let staleError=null
        let focusForbiddenError=null
        let focusRouteError=null
        const focusAbort=new AbortController()
        const pendingFocusRoutes=new Set()
        const pendingFocusFulfills=new Set()
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
        const focusRouteFailed=Promise.withResolvers()
        const focusRouteDone=focusRouteFailed.promise.catch(()=>{})
        const failFocusForbidden=err=>{
          focusForbiddenError??=err
          focusForbiddenRejected.reject(err)
        }
        const failFocusRoute=err=>{
          focusRouteError??=err
          focusRouteFailed.reject(err)
        }
        const focusStop=Promise.race([focusForbiddenDone,focusRouteDone])
        const focusStep=promise=>Promise.race([promise,focusForbiddenRejected.promise,focusRouteFailed.promise])
        let followUpCleaned=false
        const settleFollowUp=async()=>{
          if(!followUpCleaned&&!focusForbiddenError&&!focusRouteError&&heldFollowUp){
            followUpCleaned=true
            await settleWithin(followUpSettled.promise,focusStop)
          }
        }
        const admitRoute=req=>admitLiveRoute(req,{policy,origin:url.origin,forbiddenRequests,onForbidden:failFocusForbidden})
        let focusTeardownFulfillError=null
        const abortFocusRoute=async(route,code)=>{
          const err=await abortRouteOrClose(route,'focus recovery route abort',2_000,code)
          if(err){
            if(focusTeardown)focusTeardownFulfillError??=err
            else failFocusRoute(err)
          }
        }
        const checkFocusRoute=async route=>{
          try {
            if(await admitRoute(route.request()))return true
            await abortFocusRoute(route,'blockedbyclient')
            return false
          } catch (err) {
            if(focusActive)failFocusRoute(err)
            await abortFocusRoute(route)
            return false
          }
        }
        const holdEvents=route=>trackPending(pendingFocusRoutes,(async()=>{
          if(!focusActive||!blockEvents)return route.fallback()
          if(!await checkFocusRoute(route))return
          if(!focusActive||!blockEvents)return route.fallback()
          await fulfillOrAbort(pendingFocusFulfills,route,
            {status:503,contentType:'application/json',body:'{}'},
            err=>{
              if(focusTeardown){
                focusTeardownFulfillError??=err
              } else {
                staleError??=err
                staleCaptured.reject(err)
                followUpCaptured.reject(err)
                failFocusRoute(err)
              }
            })
        })())
        const holdStaleStatus=route=>trackPending(pendingFocusRoutes,(async()=>{
          if(!focusActive||route.request().method()!=='GET')return route.fallback()
          if(!await checkFocusRoute(route))return
          if(!focusActive)return route.fallback()
          authStatusRequests++
          if(heldStale){
            if(staleReleased&&!heldFollowUp){
              heldFollowUp=true
              postStaleStatus++
              let fulfillError=null
              try {
                const {status,headers,text,body}=await fetchOwnedStatus(route,url.origin,context,attestedGet,focusAbort.signal)
                if(!focusActive){
                  await abortFocusRoute(route)
                  return
                }
                assert.equal(body.authenticated,true)
                assert(!body.pairingRequired)
                followUpCaptured.resolve()
                await releaseFollowUp.promise
                if(!focusActive){
                  await abortFocusRoute(route)
                  return
                }
                if(!await fulfillOrAbort(pendingFocusFulfills,route,{status,headers,body:text},
                  err=>{ fulfillError=err; if(focusTeardown)focusTeardownFulfillError??=err }))throw fulfillError
              } catch (err) {
                followUpCaptured.reject(err)
                if(!focusTeardown&&focusActive)failFocusRoute(err)
                if(!fulfillError)await abortFocusRoute(route)
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
          let fulfillError=null
          try {
            const {status,headers,text,body}=await fetchOwnedStatus(route,url.origin,context,attestedGet,focusAbort.signal)
            if(!focusActive){
              await abortFocusRoute(route)
              return
            }
            assert.equal(body.authenticated,false)
            assert.equal(body.pairingRequired,true)
            staleCaptured.resolve()
            await releaseStale.promise
            if(!focusActive){
              await abortFocusRoute(route)
              return
            }
            if(!await fulfillOrAbort(pendingFocusFulfills,route,{status,headers,body:text},
              err=>{ fulfillError=err; if(focusTeardown)focusTeardownFulfillError??=err }))throw fulfillError
          } catch (err) {
            staleError=err
            staleCaptured.reject(err)
            if(!focusTeardown&&focusActive)failFocusRoute(err)
            if(!fulfillError)await abortFocusRoute(route)
          } finally {
            staleDone=true
            staleSettled.resolve()
          }
        })())
        // Intercept the VERY FIRST /api/auth/status triggered by device revocation (before #pairing-recovery opens),
        // then block SSE reconnects until the pairing overlay dismisses so focus/visibility alone drives recovery.
        let focusCleanupError=null
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
            await settleWithin(page.evaluate(()=>globalThis.__runeCleanupReturnSignal?.()).catch(()=>{}),focusStop)
          }
          staleReleased=true
          releaseStale.resolve()
          if(!focusForbiddenError&&!focusRouteError&&heldStale)await settleWithin(staleSettled.promise,focusStop)
          if(focusForbiddenError)throw focusForbiddenError
          if(focusRouteError)throw focusRouteError
          if(staleError)throw staleError
          assert.equal(staleAborted,null,'Held first status probe must not abort before browser delivery')
          const staleBrowserResponse=await focusStep(withBudget(now()+5_000,'browser receipt of held first auth status',
            ()=>focusStep(staleReceivedByBrowser.promise)))
          assert.equal(staleBrowserResponse.status(),200)
          assert.equal(await focusStep(staleBrowserResponse.finished()),null,'Browser must finish reading the held first status response')
          assert.equal((await focusStep(staleBrowserResponse.json())).pairingRequired,true,'Browser must receive pairingRequired=true from the first probe')
          // Returning focus while the first status probe was in flight must queue a follow-up check
          // immediately once pairingRequired=true opens #pairing-recovery, without any click or SSE help.
          await focusStep(withBudget(now()+10_000,'follow-up auth status after first stale probe',
            ()=>focusStep(followUpCaptured.promise)))
          await focusStep(dialog.waitFor())
          await focusStep(text(messages['rune.pairing_guide']).waitFor())
          assert.equal(await focusStep(dialog.getByRole('textbox').count()),0,'Browser pairing never shows a password form')
          releaseFollowUp.resolve()
          await settleFollowUp()
          if(focusForbiddenError)throw focusForbiddenError
          if(focusRouteError)throw focusRouteError
          await focusStep(dialog.waitFor({state:'detached',timeout:10_000}))
          assert.equal(eventSources(),beforeRevoke,'SSE stayed blocked until the pairing overlay dismissed')
          blockEvents=false
          if(focusForbiddenError)throw focusForbiddenError
          if(focusRouteError)throw focusRouteError
          assert(postStaleStatus>=1,'Focus return during the first status probe must trigger a follow-up /api/auth/status check')
        } catch (err) {
          if(focusForbiddenError)throw focusForbiddenError
          if(focusRouteError)throw focusRouteError
          throw err
        } finally {
          focusTeardown=true
          focusActive=false
          blockEvents=false
          staleReleased=true
          focusAbort.abort()
          releaseStale.resolve()
          releaseFollowUp.resolve()
          page.off('requestfailed',onAuthFailed)
          page.off('response',onAuthResponse)
          const unrouteErr=await unrouteBounded(page,[[eventsUrl,holdEvents],[authStatusUrl,holdStaleStatus]],'focus recovery routes',2_000)
          const drainErr=await drainSetsWithin([pendingFocusRoutes,pendingFocusFulfills],'focus recovery routes',2_000)
          focusCleanupError??=focusTeardownFulfillError??unrouteErr??drainErr
        }
        if(focusCleanupError)throw focusCleanupError
        if(focusForbiddenError)throw focusForbiddenError
        if(focusRouteError)throw focusRouteError
    })
    await connecting.waitFor({state:'hidden'})
    assert.equal(await (await focus()).inputValue(),draft)
    assert(eventSources()>beforeRevoke,'Re-pairing must open a new real EventSource')
    assert.equal(page.url(),url.href,'Original document stays on its conversation')
    evidence.repairedWithDraft=true
    evidence.crossOriginRePairLink=fromLink
    evidence.sseAuthenticated503Recovery=await verifySseAuthenticated503Recovery({
      page,context,url,messages,eventSources,policy,forbiddenRequests,fromLink,connecting,focus,draft,tap,attestedGet,
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

export async function preparePair(tab, url, {fromLink=false,assets,waitForRune=Boolean(assets),returnLocale=url.searchParams.get('locale'),waitUntil='load',setupDeadline}={}){
  const pairPath='/api/remote-control/pair'
  const referrer='https://rune-pair-source.test/'
  const deadline=setupDeadline??now()+30_000
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
  try {
    await withBudget(deadline,'installing pairing tab route',()=>tab.route('**/*', routePair))
    if(fromLink)await withBudget(deadline,'opening pairing source document',
      ms=>tab.goto(referrer,{timeout:Math.max(1,Math.round(ms))}))
  } catch (err) {
    const unrouteErr=await unrouteBounded(tab,[['**/*',routePair]],'pairing tab route',2_000)
    if(unrouteErr)console.error(`Pairing route cleanup error after setup failure: ${unrouteErr.message}`)
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
      const err=await unrouteBounded(tab,[['**/*',routePair]],'pairing tab route',2_000)
      if(err)throw err
    },
  }
}

export async function navigatePair(tab, url, options){
  const flow=await preparePair(tab, url, options)
  let primaryError=null
  let disposeError=null
  try {
    await flow.complete()
  } catch (err) {
    primaryError=err
    throw err
  } finally {
    try { await flow.dispose() } catch (err) { disposeError=err }
    if(disposeError&&primaryError){
      console.error(`Pairing route cleanup error after primary failure: ${disposeError.message}`)
    }
  }
  if(disposeError)throw disposeError
}
