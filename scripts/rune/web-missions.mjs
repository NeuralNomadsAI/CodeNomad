import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {actorWindow,assertActorActivity} from './web-mission-activity.mjs'
import {checkLifecycle,lifecycleFixture} from './web-mission-lifecycle.mjs'
import {checkCleanupRetry,checkRecoveryAndDelete,recoveryCleanupFixture} from './web-mission-recovery-cleanup.mjs'

const digest=rows=>createHash('sha256').update(`[${rows.join(',')}]`,'utf16le').digest('base64url')
const summary=(id,title,revision)=>JSON.stringify({
  id,title,objective:`Objectif ${title} 🦀`,status:'active',coordinatorSessionId:'ses_existing',
  actorCount:1,updatedAt:revision,revision,
})
const initial=[summary('alpha','Alpha 🦀',1),...Array.from({length:49},(_,i)=>summary(`row-${i}`,`Suite ${i}`,1)),summary('beta','Bêta',1)]
const revised=[summary('alpha','Alpha révisée 🦀',2),...initial.slice(1,50),summary('gamma','Gamma',2)]
const tasks=Array.from({length:52},(_,order)=>({
  id:`tsk-${order}`,key:`task-${order}`,title:order===0?'Vérifier la fiche 🦀':order===50?'Tâche suivante':'Étape '+order,
  status:order===50?'needs-input':'ready',blockedBy:order===50?['task-0']:[],role:'specialist',
  order,createdAt:1,updatedAt:1,dependents:order===0?1:0,reportCount:0,outstandingExecution:false,
}))
const taskOrder=digest(tasks.map(task=>JSON.stringify(task.key)))
const attention={counts:{notifications:0,blocked:1,failed:0,recovery:0},omitted:1,sequence:digest(['"task-50"'])}
const taskPage=(offset,end)=>({order:taskOrder,offset,end,total:tasks.length,counts:{ready:51,'needs-input':1},reports:0,attention})
const descriptor={digest:digest([]),characters:2,total:0,array:true}

export function missionsFixture({page,messages,artifact,project}){
  let summaries=initial, corrupt=false, held, gammaRevision=6
  const reads=[]
  const lifecycle=lifecycleFixture()
  const recovery=recoveryCleanupFixture()
  function release(){held?.release()}
  async function route(route,path){
    if(path==='/api/meta'){
      const response=await route.fetch({maxRedirects:0})
      const meta=await response.json()
      await route.fulfill({response,json:{...meta,capabilities:[...new Set([...(meta.capabilities??[]),'missions'])]}})
      return true
    }
    if(path.endsWith('/missions/gamma/control')){
      await lifecycle.reply(route,gammaRevision,value=>{gammaRevision=value})
      return true
    }
    if(await recovery.route(route,path))return true
    if(!path.endsWith('/missions/panel-page'))return false
    const request=route.request().postDataJSON()
    if(request.field==='control'){
      const rows=lifecycle.rows(request.part).map(row=>JSON.stringify(row))
      const {offset,order}=request.window
      const selected=rows.slice(offset,offset+50), actual=digest(rows)
      assert(!order||order===actual)
      await route.fulfill({json:{available:true,version:1,projectID:'fixture-project',source:'mission',missionID:'gamma',
        revision:gammaRevision,field:'control',part:request.part,discardedEvents:0,controlUnavailable:false,
        notificationUnavailable:false,cleanupUnavailable:false,window:{order:actual,offset,end:offset+selected.length,total:rows.length},
        page:{digest:digest(selected),total:selected.length,pieces:selected.map((text,index)=>({index,offset:0,characters:text.length,text}))},
      }})
      return true
    }
    if(['mission','tasks','activity'].includes(request.source)){
      const task=request.task
      const missionID=request.missionID??task.missionID
      const offset=task?.offset??0
      reads.push({path,source:request.source,missionID,offset,order:task?.order})
      const missionRevision=missionID==='alpha'?recovery.alphaRevision():gammaRevision
      const header={root:{
        version:1,id:missionID,projectID:'fixture-project',projectCanonical:'/fixture',title:`Fiche ${missionID}`,
        excerpt:'Objectif de la fiche 🦀',template:'custom',status:'active',revision:missionRevision,createdAt:1,updatedAt:1,
        coordinatorSessionId:'ses_existing',historyTruncated:false,bodies:{},
      },collections:{actors:descriptor,history:descriptor,reports:descriptor},
       tasks:{page:{...taskPage(0,50),attention:{...attention,keys:['task-50']}},pins:['tsk-51'],reportPins:[],version:taskOrder}}
      if(missionID!=='gamma'){
        header.tasks={page:{order:digest([]),offset:0,end:0,total:0,reports:0,counts:{}},pins:[],reportPins:[],version:digest([])}
        if(missionID==='alpha'){
          header.coordinator=recovery.alphaHeader().coordinator
          header.root.runState='running'
        }
      }else{
        const {runState,control}=lifecycle.header()
        header.root.runState=runState
        if(control)header.control=control
      }
      const live=request.source==='activity'
      const row=request.header?header:live
        ?(missionID==='alpha'?recovery.alphaActorWindow(taskOrder):actorWindow(missionID,missionRevision,taskOrder)):
        task.attention===0?{taskPage:{...taskPage(0,0),attention:{...attention,offset:0,end:1}},tasks:[tasks[50]],reports:[]}:
        task.ids?{taskPage:taskPage(0,0),tasks:[tasks[51]],reports:[]}:
        {taskPage:taskPage(offset,Math.min(offset+50,tasks.length)),tasks:tasks.slice(offset,offset+50),reports:[]}
      if(task)assert.equal(task.order,taskOrder)
      // The first task response races a revision advance; the next header must join that revision.
      if(missionID==='gamma'&&task?.offset===0&&gammaRevision===6)gammaRevision++
      const text=JSON.stringify(row)
      const responseRevision=missionID==='alpha'?recovery.alphaRevision():gammaRevision
      await route.fulfill({json:{available:true,version:1,projectID:'fixture-project',source:request.source,missionID,revision:responseRevision,
        ...(request.header?{header:true}:live?{phase:'observed',observedAt:Date.now()}:{}),
        discardedEvents:0,controlUnavailable:false,notificationUnavailable:false,cleanupUnavailable:false,
        page:{digest:digest([text]),total:1,pieces:[{index:0,offset:0,characters:text.length,text}]},
      }})
      return true
    }
    const {source,window:{offset,order}}=request
    reads.push({path,source,offset,order})
    const activeSummaries=recovery.alphaTombstoned()?summaries.filter(row=>JSON.parse(row).id!=='alpha'):summaries
    const rows=source==='summaries'?activeSummaries:recovery.cleanups()
    const actualOrder=digest(rows)
    if(order&&order!==actualOrder){
      await route.fulfill({status:200,json:{available:false,reason:'changed'}})
      return true
    }
    const selected=rows.slice(offset,offset+50), hash=digest(selected)
    const json={available:true,version:1,projectID:'fixture-project',source,discardedEvents:0,
      controlUnavailable:false,notificationUnavailable:false,cleanupUnavailable:false,
      ...(request.initial?{finishHighWater:0}:{}),
      window:{order:actualOrder,offset,end:offset+selected.length,total:rows.length},
      page:{digest:source==='summaries'&&corrupt?digest([]):hash,total:selected.length,
        pieces:selected.map((text,index)=>({index,offset:0,characters:text.length,text})),
      },
    }
    const pending=source==='summaries'?held:null
    if(pending){pending.arrive();await pending.gate}
    try{await route.fulfill({json})}
    catch(error){if(!pending)throw error} // The panel can abort a held fetch upon hiding.
    finally{pending?.settled()}
    return true
  }
  async function check(press){
    assert.equal(await page.evaluate(()=>globalThis.crypto.subtle),undefined)
    const tab=key=>messages[`instanceShell.rightPanel.tabs.${key}`]
    const more=messages['missionsPanel.pages.more'], retry=messages['missionsPanel.reader.retry']
    const refresh=messages['missions.control.refresh'], search=messages['missionsPanel.picker.search']
    const row=name=>page.getByRole('listitem',{name,exact:true})
    const filter=async value=>{
      const input=page.locator('textarea:focus,input:focus')
      for(let i=0;i<72;i++){
        if(await input.count()&&await input.getAttribute('aria-label')===search){await input.fill(value);return}
        await page.keyboard.press('Tab')
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)))
      }
      assert.fail('Mission search must be reachable by keyboard')
    }
    const right=messages['window.menu.rightPanel']
    const toggle=page.getByRole('button',{name:right,exact:true})
    if(await toggle.getAttribute('aria-expanded')!=='true')await press(right)
    await page.getByRole('tab',{name:tab('missions'),exact:true}).waitFor()
    assert.equal(reads.length,0,'Status must not request Mission directory pages')
    await press(tab('missions'),'tab')
    await row('Alpha 🦀').waitFor()
    await filter('Gamma')
    await row('Alpha 🦀').waitFor({state:'detached'})
    await page.waitForFunction(({search,help})=>{
      const id=document.querySelector('canvas[aria-activedescendant]')?.getAttribute('aria-activedescendant')
      const field=id&&document.getElementById(id)
      return field?.getAttribute('aria-label')===search&&field.getAttribute('aria-description')===help
    },{search,help:messages['missionsPanel.pages.searchLoaded']})
    assert.equal(await page.getByText(messages['missionsPanel.picker.noMatch'],{exact:true}).count(),0)
    await page.getByText('Nettoyage vérifié',{exact:true}).waitFor()
    await page.getByText(messages['missions.cleanup.documentPending'],{exact:true}).waitFor()
    await checkCleanupRetry(page,messages)
    await press(more)
    await page.getByText(messages['missionsPanel.picker.noMatch'],{exact:true}).waitFor()
    await filter('Bêta')
    await row('Bêta').waitFor()
    assert(!reads.some(read=>read.source==='mission'||read.source==='tasks'),'Directory discovery does not prefetch maps')
    await press('Bêta','listitem')

    // A bad digest never overwrites the retained rows. Retry reads the same first window.
    summaries=revised
    corrupt=true
    await press(refresh)
    await page.getByRole('button',{name:retry,exact:true}).waitFor()
    await row('Bêta').waitFor()
    corrupt=false
    await press(retry)
    await page.getByRole('button',{name:more,exact:true}).waitFor()
    await row('Bêta').waitFor()
    summaries=[...revised.slice(0,50),summary('gamma','Gamma',3)]
    await press(more)
    await page.getByRole('button',{name:retry,exact:true}).waitFor()
    assert.equal(reads.filter(r=>r.source==='summaries').at(-1).offset,50)
    await press(retry)
    await page.getByRole('button',{name:more,exact:true}).waitFor()
    assert.deepEqual(reads.filter(r=>r.source==='summaries').at(-1),{
      path:reads[0].path,source:'summaries',offset:0,order:undefined,
    })
    await row('Bêta').waitFor()
    await press(more)
    await row('Bêta').waitFor({state:'detached'})
    await filter('Gamma')
    await row('Gamma').waitFor()
    await press('Gamma','listitem')
    await page.getByRole('heading',{name:'Fiche gamma',exact:true}).waitFor()
    await assertActorActivity(page,messages)
    assert.equal(await page.getByRole('heading',{name:'Fiche beta',exact:true}).count(),0)
    await row('Vérifier la fiche 🦀').waitFor()
    assert.equal(reads.filter(read=>read.source==='mission'&&read.missionID==='gamma').length,2)
    assert.equal(await row('Étape 51').count(),0,'The far task is outside the virtual viewport')
    const box=await row('Vérifier la fiche 🦀').boundingBox()
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
    const scrollTail=async()=>{
      for(let step=0;step<12&&await row('Étape 51').count()===0;step++){
        await page.mouse.wheel(0,700)
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      }
      await row('Étape 51').waitFor()
    }
    await scrollTail()
    assert.equal(await row('Tâche suivante').count(),0)
    const detail=page.getByRole('region',{name:messages['missions.control.overview'],exact:true})
    const attentionLabel=messages['missionsPanel.tasks.attention.one'].replace('{count}','1')
    const attentionAction=detail.getByRole('button',{name:attentionLabel,exact:true})
    await attentionAction.waitFor()
    const moreTasks=detail.getByRole('button',{name:more,exact:true})
    const numbered=page.waitForResponse(response=>response.url().endsWith('/missions/panel-page')&&response.request().postDataJSON()?.task?.offset===50)
    await moreTasks.dispatchEvent('click')
    await numbered
    await scrollTail()
    await row('Tâche suivante').waitFor()
    await attentionAction.waitFor({state:'detached'})
    assert.equal(await row('Étape 51').count(),1,'A pinned task is reconciled into its numbered window')
    await checkLifecycle(page,messages,lifecycle.calls)
    await page.waitForFunction(folder=>{
      const raw=sessionStorage.getItem('codenomad.rune.alpha.client-state.v1')
      const current=raw&&JSON.parse(raw).session.tabs.find(tab=>tab.folder===folder)
      return current?.viewState?.rightPanelTab==='missions'&&current.viewState.missions?.selected==='gamma'
    },project)

    // Deliver a superseded response after the switch; it must not publish on return.
    let arrive,unblock,settled
    const arrived=new Promise(resolve=>{arrive=resolve})
    const gate=new Promise(resolve=>{unblock=resolve})
    const delivered=new Promise(resolve=>{settled=resolve})
    summaries=[summary('stale','Résultat périmé',4)]
    held={arrive,gate,release:unblock,settled}
    await press(refresh)
    await arrived
    await press(tab('status'),'tab')
    await row('Gamma').waitFor({state:'detached'})
    summaries=[summary('alpha','Alpha à jour 🦀',5),...revised.slice(1)]
    release()
    await delivered
    held=null
    await press(tab('missions'),'tab')
    await row('Gamma').waitFor()
    await filter('Alpha')
    await row('Alpha à jour 🦀').waitFor()
    await row('Gamma').waitFor()
    await filter('')
    assert.equal(await row('Résultat périmé').count(),0)
    await checkRecoveryAndDelete(page,messages,recovery.counts,filter)
    await writeFile(`${artifact}.aria.yml`,await page.locator('body').ariaSnapshot())
    await page.screenshot({path:`${artifact}.png`})
    await writeFile(`${artifact}.json`,JSON.stringify({webCrypto:false,reads},null,2))
    await press(tab('status'),'tab')
  }
  return {route,check,release}
}
