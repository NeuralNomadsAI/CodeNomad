import assert from 'node:assert/strict'
import {waitSettledControl} from './web-chromium.mjs'

export function lifecycleFixture(){
  let state='running', control, first
  const calls=[]
  return {calls,
    header:()=>({runState:state,...(control?{control}:{})}),
    rows(part){
      return part==='pending' ? Array.from({length:control.pending},(_,i)=>`ses-pending-${i+1}`)
        : [{receiptID:'rcpt-unknown',sessionID:'ses-unknown',acknowledgementState:'unknown'},
          {receiptID:'rcpt-known',sessionID:'ses-known',acknowledgementState:'known',nativeAcknowledgement:{
            missionID:'gamma',operationID:control.id,sessionID:'ses-known',action:control.action,disposition:'start-admitted',
            admission:{id:'inb-recorded',sessionID:'ses-known',type:'synthetic',delivery:'queue',
              time:{created:1},payload:{text:'Resume the Mission',metadata:{}}},
          }}]
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
      if(calls.length===4){
        assert.equal(input.action,'stop')
        await route.fulfill({status:503,json:{error:'fixture Stop lost before admission'}})
        return revision
      }
      if(calls.length===2)assert.deepEqual(input,first,'Replay reuses the exact intent')
      else if(calls.length===5)assert.deepEqual(input,calls[3],'Stop retains its identity over a partial Play')
      else assert(!calls.slice(0,-1).some(prior=>prior.requestId===input.requestId))
      state={start:'running',pause:'paused',stop:'stopped'}[input.action]
      const {requestId,expectedRevision,graceful,action}=input
      control={id:`ctrl-${requestId}`,requestID:requestId,expectedRevision,action,pending:0,
        completedRevision:revision+1,receipts:action==='pause'?0:1,unconfirmedReceipts:0,partialDescendants:0,
        ...(graceful?{graceful:true}:{})}
      if(action==='start'){
        control={...control,pending:51,receipts:2,unconfirmedReceipts:1}
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

async function waitControlReady(page,target){
  const viewport=page.viewportSize()
  const visible=box=>!viewport||(box.x>=-1&&box.y>=120&&box.x+box.width<=viewport.width+1&&box.y+box.height<=viewport.height-24)
  let box=await waitSettledControl(page,target)
  if(viewport&&!visible(box)){
    const anchorX=Math.min(Math.max(box.x+box.width/2,16),viewport.width-16)
    const anchorY=viewport.height/2
    await page.mouse.move(anchorX,anchorY)
    for(let step=0;step<24&&!visible(box);step++){
      const delta=box.y+box.height>viewport.height-24?360:-360
      await page.mouse.wheel(0,delta)
      // Rune throttles scroll-only a11y mirror sync to 150 ms; wait past it before reading rect.
      await page.waitForTimeout(200)
      box=await waitSettledControl(page,target,{settleMs:0})
    }
    box=await waitSettledControl(page,target)
  }
  if(viewport){
    assert(box.x>=-1&&box.y>=-1&&box.x+box.width<=viewport.width+1&&box.y+box.height<=viewport.height+1,'Mission control outside viewport')
  }
  for(const until=Date.now()+20000;;){
    const ready=await target.evaluateAll(nodes=>{
      if(nodes.length!==1)return false
      const el=nodes[0]
      if(!el.isConnected||el.disabled||el.getAttribute('aria-disabled')==='true')return false
      const rect=el.getBoundingClientRect()
      if(rect.width<=0||rect.height<=0)return false
      const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)
      return hit===el||el.contains(hit)||hit?.tagName==='CANVAS'
    }).catch(()=>false)
    if(ready)break
    assert(Date.now()<until,'Mission control failed hit-test readiness')
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)))
  }
}

export async function pressControl(page,target){
  await waitControlReady(page,target)
  await target.click({force:true})
}

export async function checkLifecycle(page,messages,calls){
  const button=(key,scope=page)=>scope.getByRole('button',{name:messages[key],exact:true})
  const enabled=target=>waitControlReady(page,target)
  const press=target=>pressControl(page,target)
  const act=(key,scope)=>press(button(key,scope))
  const pause='missionsPanel.action.pause'
  const resume='missionsPanel.action.resume'
  const check='missionsPanel.action.checkStatus'
  const replay='missions.control.refreshResend'
  const stop='missions.control.run.stop'
  const dialog=page.getByRole('alertdialog',{name:messages['missions.control.run.stopConfirm'],exact:true})
  assert.equal(calls.length,0)
  await enabled(button(pause))
  const primary=await button(pause).elementHandle()
  const first=page.waitForResponse(response=>response.url().endsWith('/missions/gamma/control'))
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
  await enabled(button(check))
  const receipts=page.getByRole('button',{name:'control.receipts (2)',exact:true})
  await press(receipts)
  const unknown=page.getByRole('button',{name:`ses-unknown · ${messages['missions.control.activity.state.unknown']}`,exact:true})
  await press(unknown)
  await page.getByText(/"acknowledgementState":"unknown"/).waitFor()
  const recorded=page.getByRole('button',{name:'ses-known',exact:true})
  await press(recorded)
  await page.getByText(/"id":"inb-recorded"/).waitFor()
  await page.getByText(/"acknowledgementState":"unknown"/).waitFor({state:'detached'})
  await press(page.getByRole('button',{name:'control.pending (51)',exact:true}))
  await page.getByText('ses-pending-1',{exact:true}).waitFor()
  const fields = page.getByRole('region',{name:messages['missionsPanel.pages.fields'],exact:true})
  await press(fields.getByRole('button',{name:messages['missionsPanel.pages.more'],exact:true}))
  await page.getByText('ses-pending-51',{exact:true}).waitFor()
  await act(stop)
  await dialog.waitFor()
  await act('missions.control.cancel',dialog)
  await dialog.waitFor({state:'detached'})
  assert.equal(calls.length,3,'Cancel never submits Stop')
  await act(stop)
  const missingStop=page.waitForResponse(response=>response.url().endsWith('/missions/gamma/control'))
  await act(stop,dialog)
  assert.equal((await missingStop).status(),503)
  await dialog.waitFor({state:'detached'})
  await button(stop).waitFor({state:'detached'})
  await page.getByText(messages['missions.control.run.error'],{exact:true}).waitFor()
  await act(check)
  await button(replay).waitFor()
  assert.equal(calls.length,4,'Reconciliation never sends Stop')
  await act(replay)
  await button(check).waitFor({state:'detached'})
  assert.deepEqual(calls.map(input=>input.action),['pause','pause','start','stop','stop'])
}
