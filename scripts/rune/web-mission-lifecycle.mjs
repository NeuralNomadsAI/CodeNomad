import assert from 'node:assert/strict'

export function lifecycleFixture(){
  let state='running', control, first
  const calls=[]
  return {calls,
    header:()=>({runState:state,...(control?{control}:{})}),
    rows(part){
      return part==='pending' ? Array.from({length:control.pending},(_,i)=>`ses-pending-${i+1}`)
        : [{receiptID:'rcpt-unknown',sessionID:'ses-unknown',acknowledgementState:'unknown'}]
    },
    async reply(route,revision,publish){
      const input=route.request().postDataJSON()
      assert.match(input.requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      assert.equal(input.expectedRevision,revision)
      calls.push(input)
      if(!first){
        first=input
        assert.equal(input.action,'pause')
        assert.equal(input.graceful,true)
        await route.fulfill({status:503,json:{error:'fixture acknowledgement lost'}})
        return revision
      }
      if(calls.length===2)assert.deepEqual(input,first,'Replay reuses the exact intent')
      else assert(!calls.slice(0,-1).some(prior=>prior.requestId===input.requestId))
      state={start:'running',pause:'paused',stop:'stopped'}[input.action]
      const {requestId,expectedRevision,graceful,action}=input
      control={id:`ctrl-${requestId}`,requestID:requestId,expectedRevision,action,pending:0,
        completedRevision:revision+1,receipts:action==='pause'?0:1,unconfirmedReceipts:0,partialDescendants:0,
        ...(graceful?{graceful:true}:{})}
      if(action==='start'){
        control={...control,pending:51,unconfirmedReceipts:1}
        delete control.completedRevision
        publish(revision+1)
        await route.fulfill({status:503,json:{code:'control-pending'}})
        return revision+1
      }
      const {pending,receipts,unconfirmedReceipts,partialDescendants,...identity}=control
      publish(revision+1)
      await route.fulfill({json:{mission:{id:'gamma',projectID:'fixture-project',projectCanonical:'/fixture',
        coordinatorSessionId:'ses_existing',revision:revision+1,control:{...identity,missionID:'gamma',pending:[]}}}})
      return revision+1
    },
  }
}

export async function checkLifecycle(page,messages,calls){
  const button=(key,scope=page)=>scope.getByRole('button',{name:messages[key],exact:true})
  const act=async(key,scope)=>{
    const target=button(key,scope)
    await target.waitFor()
    await target.dispatchEvent('click')
  }
  const pause='missionsPanel.action.pause'
  const resume='missionsPanel.action.resume'
  const check='missionsPanel.action.checkStatus'
  const replay='missions.control.refreshResend'
  const stop='missions.control.run.stop'
  const dialog=page.getByRole('alertdialog',{name:messages['missions.control.run.stopConfirm'],exact:true})
  assert.equal(calls.length,0)
  const first=page.waitForResponse(response=>response.url().endsWith('/missions/gamma/control'))
  const primary=await button(pause).elementHandle()
  await act(pause)
  assert.equal((await first).status(),503)
  await page.getByText(messages['missions.control.run.error'],{exact:true}).waitFor()
  await button(check).waitFor()
  assert(await button(check).evaluate((node, old)=>node===old,primary),'Primary action keeps its DOM node')
  assert.equal(calls.length,1)
  assert.equal(await button(replay).count(),0,'No replay without a read')
  await act(check)
  await button(replay).waitFor()
  assert.equal(calls.length,1,'Check status is read-only')
  await act(replay)
  await button(resume).waitFor()
  await act(resume)
  await button(check).waitFor()
  await page.getByRole('button',{name:'control.receipts (1)',exact:true}).dispatchEvent('click')
  await page.getByText(`ses-unknown · ${messages['missions.control.activity.state.unknown']}`,{exact:true}).waitFor()
  await page.getByRole('button',{name:'control.pending (51)',exact:true}).dispatchEvent('click')
  await page.getByText('ses-pending-1',{exact:true}).waitFor()
  const fields = page.getByRole('region',{name:messages['missionsPanel.pages.fields'],exact:true})
  await fields.getByRole('button',{name:messages['missionsPanel.pages.more'],exact:true}).dispatchEvent('click')
  await page.getByText('ses-pending-51',{exact:true}).waitFor()
  await act(stop)
  await dialog.waitFor()
  await act('missions.control.cancel',dialog)
  await dialog.waitFor({state:'detached'})
  assert.equal(calls.length,3,'Cancel never submits Stop')
  await act(stop)
  await act(stop,dialog)
  await dialog.waitFor({state:'detached'})
  await button(check).waitFor({state:'detached'})
  assert.deepEqual(calls.map(input=>input.action),['pause','pause','start','stop'])
}
