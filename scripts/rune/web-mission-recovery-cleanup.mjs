import assert from 'node:assert/strict'
import {pressControl} from './web-mission-lifecycle.mjs'

export function recoveryCleanupFixture(){
  let oldPending=true
  let oldSequence=[]
  let holdCleanupsGate=null
  let alphaTombstoned=false
  let alphaDeleted=false
  let alphaRecoveryCalls=0
  let alphaRevision=5
  let alphaDeleteRequest=null
  let alphaDeleteCalls=0
  let deleteSessions=false
  let deleteSessionPatches=[]
  let lastConfig=null
  const cleanupRow=()=>JSON.stringify({
    missionID:'old',deletionID:'cleanup',requestID:'request',expectedRevision:1,
    deleteManagedSessions:false,objective:'Nettoyage vérifié',createdAt:1,removed:0,retained:1,
    pending:0,reasons:['children'],documentPending:oldPending,
  })
  const alphaCleanupRow=()=>JSON.stringify({
    missionID:'alpha',deletionID:'del-alpha',requestID:alphaDeleteRequest.requestId,
    expectedRevision:alphaDeleteRequest.expectedRevision,
    deleteManagedSessions:alphaDeleteRequest.deleteManagedSessions,
    objective:'Alpha à jour 🦀',createdAt:2,removed:1,retained:0,pending:alphaDeleted?0:1,
    reasons:[],documentPending:false,
  })
  return {
    cleanups:()=>alphaDeleteRequest?[cleanupRow(),alphaCleanupRow()]:[cleanupRow()],
    holdCleanups:()=>holdCleanupsGate?.promise??null,
    releaseCleanups:()=>{holdCleanupsGate?.release();holdCleanupsGate=null},
    alphaTombstoned:()=>alphaTombstoned,
    alphaRevision:()=>alphaRevision,
    alphaHeader:()=>({
      coordinator:{kind:'coordinator',sessionId:'ses_existing',location:{directory:'/fixture'}},
      revision:alphaRevision,
    }),
    alphaActorWindow:(order)=>({
      context:{id:'alpha',projectID:'fixture-project',revision:alphaRevision,status:'active',
        coordinatorSessionId:'ses_existing',
        actors:[{sessionId:'ses_existing',title:'Coordinateur',location:{directory:'/fixture'},reportOwed:true,callOpen:false}],
        actorPage:{order,offset:0,end:1,total:1},
        discardedEvents:0,controlUnavailable:false,notificationUnavailable:false,cleanupUnavailable:false},
      coverage:'observed',
      requests:{state:'observed',items:[]},
      activity:{actors:[{sessionId:'ses_existing',state:'idle-without-report'}],
        family:{state:'observed',members:[]}},
    }),
    async route(route,path){
      const method=route.request().method()
      if(path==='/api/storage/config/ui'&&method==='GET'){
        const response=await route.fetch({maxRedirects:0})
        const config=await response.json()
        lastConfig=config
        await route.fulfill({response,json:{...config,settings:{...(config.settings??{}),missionDeleteSessions:deleteSessions}}})
        return true
      }
      if(path==='/api/storage/config/ui'&&method==='PATCH'){
        const body=route.request().postDataJSON()
        assert.equal(typeof body?.settings?.missionDeleteSessions,'boolean')
        deleteSessions=body.settings.missionDeleteSessions
        deleteSessionPatches.push(deleteSessions)
        await route.fulfill({json:{...(lastConfig??{}),settings:{...(lastConfig?.settings??{}),missionDeleteSessions:deleteSessions}}})
        return true
      }
      if(path.endsWith('/missions/old')&&method==='GET'){
        oldSequence.push('GET')
        await route.fulfill({json:{available:true,version:1,projectID:'fixture-project',generatedAt:1,
          cleanups:[JSON.parse(cleanupRow())]}})
        return true
      }
      if(path.endsWith('/missions/old')&&method==='DELETE'){
        oldSequence.push('DELETE')
        const body=route.request().postDataJSON()
        assert.deepEqual(body,{expectedRevision:1,requestId:'request',deleteManagedSessions:false})
        // Simulate a 409 whose reconciliation confirms the cleanup already completed.
        // Hold subsequent cleanup directory refreshes until the UI proves exact receipt adoption.
        oldPending=false
        let release
        const promise=new Promise(resolve=>{release=resolve})
        holdCleanupsGate={promise,release}
        await route.fulfill({status:409,json:{code:'request-conflict'}})
        return true
      }
      if(path.endsWith('/missions/alpha/recover')&&method==='POST'){
        const body=route.request().postDataJSON()
        assert.deepEqual(body,{expectedRevision:alphaRevision,target:'coordinator'})
        alphaRecoveryCalls++
        if(alphaRecoveryCalls===1){
          await route.fulfill({status:409,json:{code:'recovery-busy'}})
          return true
        }
        // Active-mission recovery admission does not advance the revision on its own.
        await route.fulfill({json:{admitted:true,mission:{
          id:'alpha',projectID:'fixture-project',projectCanonical:'/fixture',
          coordinatorSessionId:'ses_existing',revision:alphaRevision,
          actors:[{kind:'coordinator',sessionId:'ses_existing',location:{directory:'/fixture'}}],
        }}})
        return true
      }
      if(path.endsWith('/missions/alpha')&&method==='GET'){
        await route.fulfill({json:{available:true,version:1,projectID:'fixture-project',generatedAt:2,
          mission:alphaTombstoned?undefined:{id:'alpha',projectID:'fixture-project',revision:alphaRevision},
          cleanups:alphaDeleteRequest?[JSON.parse(alphaCleanupRow())]:[]}})
        return true
      }
      if(path.endsWith('/missions/alpha')&&method==='DELETE'){
        const body=route.request().postDataJSON()
        assert.match(body.requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        assert.equal(body.expectedRevision,alphaRevision)
        assert.equal(body.deleteManagedSessions,true,'Delete must freeze the enabled missionDeleteSessions option')
        alphaDeleteCalls++
        if(alphaDeleteCalls===1){
          alphaDeleteRequest=body
          alphaTombstoned=true
          await route.fulfill({status:503,json:{code:'cleanup-pending'}})
          return true
        }
        assert.deepEqual(body,alphaDeleteRequest,'Delete retry must reuse the frozen intent')
        alphaDeleted=true
        await route.fulfill({json:{deleted:true,cleanup:JSON.parse(alphaCleanupRow())}})
        return true
      }
      return false
    },
    counts:()=>({alphaRecoveryCalls,alphaDeleteCalls,oldSequence:[...oldSequence],deleteSessionPatches:[...deleteSessionPatches]}),
  }
}

async function setDeleteSessionsPreference(page,messages,expected){
  const waitStable=async(locator,label)=>{
    await locator.waitFor({state:'attached'})
    let previous=null
    let lastState=null
    for(const until=Date.now()+15000;;){
      const state=await locator.evaluateAll(nodes=>{
        if(nodes.length!==1)return {count:nodes.length}
        const el=nodes[0]
        const rect=el.getBoundingClientRect()
        return {
          count:1,connected:el.isConnected,disabled:Boolean(el.disabled),
          ariaDisabled:el.getAttribute('aria-disabled'),
          ariaChecked:el.getAttribute('aria-checked'),
          checked:Boolean(el.checked),
          box:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
        }
      }).catch(()=>null)
      lastState=state
      if(state&&state.count===1&&state.connected&&!state.disabled&&state.ariaDisabled!=='true'&&state.box.width>0&&state.box.height>0){
        if(previous&&previous.x===state.box.x&&previous.y===state.box.y&&previous.width===state.box.width&&previous.height===state.box.height)return state
        previous=state.box
      }else previous=null
      assert(Date.now()<until,`Preference control "${label}" not ready: ${JSON.stringify(lastState)}`)
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)))
    }
  }
  const openPrefs=page.getByRole('button',{name:messages['settings.title'],exact:true})
  await waitStable(openPrefs,'settings.title')
  await openPrefs.click({force:true})
  const missionsNav=page.getByRole('radio',{name:messages['settings.nav.missions'],exact:true})
  await missionsNav.waitFor({state:'attached'})
  await pressControl(page,missionsNav)
  const toggle=page.getByRole('switch',{name:messages['missions.preferences.deleteSessions'],exact:true})
  await waitStable(toggle,'missions.preferences.deleteSessions')
  const patch=page.waitForResponse(r=>r.url().endsWith('/api/storage/config/ui')&&r.request().method()==='PATCH')
  await toggle.click({force:true})
  assert.equal((await patch).status(),200)
  await page.getByRole('switch',{name:messages['missions.preferences.deleteSessions'],exact:true,checked:expected}).waitFor()
  const closePrefs=page.getByRole('button',{name:messages['settings.close'],exact:true})
  await waitStable(closePrefs,'settings.close')
  await closePrefs.click({force:true})
  await toggle.waitFor({state:'detached'})
}

export async function checkCleanupRetry(page,messages,counts,releaseCleanups){
  const pendingRegion=page.getByRole('region',{name:messages['missions.cleanup.title'],exact:true})
  await pendingRegion.waitFor()
  await pendingRegion.getByText(messages['missions.cleanup.reason.children'],{exact:true}).waitFor()
  await pendingRegion.getByText(messages['missions.cleanup.preserved'],{exact:true}).waitFor()
  const retryButton=pendingRegion.getByRole('button',{name:messages['missions.control.retry'],exact:true})
  await retryButton.waitFor()
  const del=page.waitForResponse(r=>r.url().endsWith('/missions/old')&&r.request().method()==='DELETE')
  await pressControl(page,retryButton)
  assert.equal((await del).status(),409)
  try{
    await page.getByRole('region',{name:messages['missions.progress.cleanupHistory'],exact:true}).waitFor()
    await page.getByText(messages['missions.cleanup.documentPending'],{exact:true}).waitFor({state:'detached'})
    if(counts) assert.deepEqual(counts().oldSequence,['GET','DELETE','GET'])
  }finally{
    releaseCleanups?.()
  }
}

export async function checkRecoveryAndDelete(page,messages,counts,filter){
  await filter('Alpha')
  const row=name=>page.getByRole('listitem',{name,exact:true})
  await row('Alpha à jour 🦀').waitFor()
  await pressControl(page,row('Alpha à jour 🦀'))
  await page.getByRole('heading',{name:'Fiche alpha',exact:true}).waitFor()
  const recover=page.getByRole('button',{name:messages['missionsPanel.action.recover'],exact:true})
  await recover.waitFor()
  assert.equal(await page.getByRole('button',{name:messages['missionsPanel.action.pause'],exact:true}).count(),0,
    'Interrupted coordinator replaces Pause with Recover')
  const busy=page.waitForResponse(r=>r.url().endsWith('/missions/alpha/recover'))
  await pressControl(page,recover)
  assert.equal((await busy).status(),409)
  await page.getByText(messages['missions.recovery.error.busy'],{exact:true}).waitFor()
  const ok=page.waitForResponse(r=>r.url().endsWith('/missions/alpha/recover'))
  await pressControl(page,recover)
  assert.equal((await ok).status(),200)
  await page.getByText(messages['missions.recovery.error.busy'],{exact:true}).waitFor({state:'detached'})
  // Pressing Recover again at the same revision must be a no-op (disabled after admission).
  await recover.click({force:true})
  await page.waitForTimeout(300)
  assert.equal(counts().alphaRecoveryCalls,2)

  // Toggle missionDeleteSessions to true in Web Preferences -> Missions, delete Alpha
  // (asserting deleteManagedSessions: true), toggle back to false, then retry via keyboard
  // and verify the frozen true option is preserved.
  await setDeleteSessionsPreference(page,messages,true)
  const delBtn=page.getByRole('button',{name:messages['missionsPanel.picker.delete'],exact:true})
  await delBtn.waitFor()
  const firstDel=page.waitForResponse(r=>r.url().endsWith('/missions/alpha')&&r.request().method()==='DELETE')
  await pressControl(page,delBtn)
  assert.equal((await firstDel).status(),503)
  await row('Alpha à jour 🦀').waitFor({state:'detached'})
  await page.getByText(messages['missions.cleanup.error.pending'],{exact:true}).waitFor()
  await setDeleteSessionsPreference(page,messages,false)
  const delGroup=page.getByRole('group',{name:messages['missions.control.delete'],exact:true})
  const retryDel=delGroup.getByRole('button',{name:messages['missions.control.retry'],exact:true})
  const cancelDel=delGroup.getByRole('button',{name:messages['missions.control.cancel'],exact:true})
  await retryDel.waitFor()
  await cancelDel.waitFor()
  const secondDel=page.waitForResponse(r=>r.url().endsWith('/missions/alpha')&&r.request().method()==='DELETE')
  await retryDel.focus()
  await page.keyboard.press('Enter')
  assert.equal((await secondDel).status(),200)
  await delGroup.waitFor({state:'detached'})
  assert.equal(counts().alphaDeleteCalls,2)
  assert.deepEqual(counts().deleteSessionPatches,[true,false])
  await filter('')
}
