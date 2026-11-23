import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {writeFile} from 'node:fs/promises'

const digest=rows=>createHash('sha256').update(`[${rows.join(',')}]`,'utf16le').digest('base64url')
const summary=(id,title,revision)=>JSON.stringify({
  id,title,objective:`Objectif ${title} 🦀`,status:'active',coordinatorSessionId:'ses_existing',
  actorCount:1,updatedAt:revision,revision,
})
const initial=[summary('alpha','Alpha 🦀',1),...Array.from({length:49},(_,i)=>summary(`row-${i}`,`Suite ${i}`,1)),summary('beta','Bêta',1)]
const revised=[summary('alpha','Alpha révisée 🦀',2),...initial.slice(1,50),summary('gamma','Gamma',2)]
const cleanup=JSON.stringify({
  missionID:'old',deletionID:'cleanup',requestID:'request',expectedRevision:1,
  deleteManagedSessions:false,objective:'Nettoyage vérifié',createdAt:1,removed:0,retained:1,pending:0,reasons:[],
})

export function missionsFixture({page,messages,artifact,project}){
  let summaries=initial, corrupt=false, held
  const reads=[]
  function release(){held?.release()}
  async function route(route,path){
    if(path==='/api/meta'){
      const response=await route.fetch({maxRedirects:0})
      const meta=await response.json()
      await route.fulfill({response,json:{...meta,capabilities:[...new Set([...(meta.capabilities??[]),'missions'])]}})
      return true
    }
    if(!path.endsWith('/missions/panel-page'))return false
    const request=route.request().postDataJSON()
    const {source,window:{offset,order}}=request
    reads.push({path,source,offset,order})
    const rows=source==='summaries'?summaries:[cleanup]
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
    await press(more)
    await page.getByText(messages['missionsPanel.picker.noMatch'],{exact:true}).waitFor()
    await filter('Bêta')
    await row('Bêta').waitFor()
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
    await writeFile(`${artifact}.aria.yml`,await page.locator('body').ariaSnapshot())
    await page.screenshot({path:`${artifact}.png`})
    await writeFile(`${artifact}.json`,JSON.stringify({webCrypto:false,reads},null,2))
    await press(tab('status'),'tab')
  }
  return {route,check,release}
}
