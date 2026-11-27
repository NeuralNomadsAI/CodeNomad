import assert from 'node:assert/strict'
import {installPngReader} from './png-pixels.mjs'

export async function historySearch(page, messages, touch, {holdNextAnchor, holdNextPreview}) {
  const viewport=page.viewportSize()
  const cdp=touch&&await page.context().newCDPSession(page)
  const resize=async size=>{
    await page.setViewportSize(size)
    await page.waitForFunction(({width,height})=>{
      const box=document.querySelector('canvas')?.getBoundingClientRect()
      return box&&Math.abs(box.width-width)<=1&&Math.abs(box.height-height)<=1
    },size)
  }
  const landscape={width:844,height:390}
  if(touch)await resize(landscape)
  const activate=async locator=>{
    if(!touch)return locator.click({force:true})
    await locator.waitFor()
    const box=await locator.boundingBox()
    assert(box)
    await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2)
  }
  const press=(root,key)=>activate(root.getByRole('button',{name:messages[key]??key,exact:true}))
  await press(page,'messageSection.search.ariaLabel')
  const search=page.getByRole('region',{name:messages['messageSection.search.ariaLabel']})
  const input=page.locator('input[type="search"]').and(page.getByRole('searchbox',{name:messages['messageSection.search.ariaLabel'],exact:true}))
  await input.waitFor({state:'attached'})
  assert.equal(await input.evaluate(el=>el.inputMode),'search')
  assert.equal(await input.getAttribute('enterkeyhint'),'search')
  await input.fill('Ex')
  const minimum=messages['messageSection.search.count.minChars'].replace('{count}','3')
  await search.getByText(minimum,{exact:true}).waitFor()
  await page.locator('[aria-live="polite"]').filter({hasText:minimum}).waitFor({state:'attached'})
  const focusLabel=label=>page.waitForFunction(expected=>{
    const active=document.activeElement
    const id=active?.getAttribute('aria-activedescendant')
    return (id?document.getElementById(id):active)?.getAttribute('aria-label')===expected
  },label)
  const scopeLabel=`${messages['history.scope']}: ${messages['history.session']}`
  const focusOpen=async()=>{
    await page.keyboard.press('Control+f')
    await focusLabel(messages['messageSection.search.ariaLabel'])
    for(let i=0;i<9;i++){
      await page.keyboard.press('Tab')
      await page.evaluate(()=>new Promise(requestAnimationFrame))
      const label=await page.evaluate(()=>{
        const id=document.activeElement?.getAttribute('aria-activedescendant')
        return (id?document.getElementById(id):document.activeElement)?.getAttribute('aria-label')
      })
      if(label===messages['history.openSession'])return
    }
    assert.fail('Tab must reach Open in session')
  }
  for(const label of [messages['messageSection.search.closeAriaLabel'],messages['history.technical'],scopeLabel]){
    await page.keyboard.press('Shift+Tab')
    await focusLabel(label)
  }
  for(const label of [messages['history.technical'],messages['messageSection.search.closeAriaLabel'],messages['messageSection.search.ariaLabel']]){
    await page.keyboard.press('Tab')
    await focusLabel(label)
  }
  const read=(route)=>page.waitForResponse(response=>response.url().endsWith(`/session-history/${route}`)
    && (route==='window'||response.request().postDataJSON()?.query==='Existing'))
  const [literal]=await Promise.all([read('query'),input.fill('Existing')])
  assert(literal.ok(),`Literal broker status ${literal.status()}`)
  await search.getByRole('button',{name:'Existing answer',exact:true}).waitFor()
  const title=search.getByText(messages['messageSection.search.ariaLabel'],{exact:true})
  const start=await title.boundingBox()
  assert(start)
  const x=start.x+8,y=start.y+start.height/2
  const height=page.viewportSize().height
  const distance=touch?28:height-20-y
  if(touch){
    const event=(type,dx,dy)=>cdp.send('Input.dispatchTouchEvent',{
      type,touchPoints:type==='touchEnd'?[]:[{x:x+dx,y:y+dy}],
    })
    await event('touchStart',0,0)
    await event('touchMove',10,14)
    await event('touchMove',40,distance)
    assert(await input.evaluate(el=>el===document.activeElement),'Dragging must keep the real search textarea focused')
    await event('touchEnd')
  }else{
    // Move the window away from the transcript area sampled for active-match ink.
    await page.mouse.move(x,y)
    await page.mouse.down()
    await page.mouse.move(x+40,y+distance,{steps:5})
    assert(await input.evaluate(el=>el===document.activeElement),'Dragging must keep the real search textarea focused')
    await page.mouse.up()
  }
  await title.evaluate((element,start)=>new Promise((resolve,reject)=>{
    const until=performance.now()+3000
    const sample=now=>{
      if(element.getBoundingClientRect().top>start.y+start.moved)resolve()
      else if(now>=until)reject(Error('Dragging the toolbar must move the search window'))
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }),{y:start.y,moved:touch?10:80})
  assert(await input.evaluate(el=>el===document.activeElement),'Releasing the toolbar must keep the query editable')
  let windows=0
  let excerpts=0
  const count=request=>{
    if(request.url().endsWith('/session-history/window'))windows++
    if(request.url().endsWith('/session/ses_another/message/message-00000'))excerpts++
  }
  page.on('request',count)
  try{
    await press(search,'Existing answer')
    assert.equal(windows,0,'A resident result needs no window')
    const technical=search.getByRole('checkbox',{name:messages['history.technical'],exact:true})
    await Promise.all([read('query'),activate(technical)])
    assert.equal(await technical.getAttribute('aria-checked'),'true')
    const rail=page.getByRole('navigation',{name:messages['messageTimeline.ariaLabel']})
    const grep=rail.getByRole('button',{name:'grep',exact:true}).first()
    const toolHit='Existing technical tool match'
    const toolBody=page.getByText('Found Existing technical tool match',{exact:true}).and(page.locator('p, pre, code'))
    const filtered=search.getByText(messages['history.destinationFiltered'],{exact:true})
    const alert=page.getByRole('alert').filter({hasText:messages['history.destinationFiltered']})
    const source=page.getByRole('heading',{name:'Existing history',exact:true})
    const rejected=async()=>{
      await alert.waitFor()
      await source.waitFor()
      assert.equal(await page.getByRole('heading',{name:'Another session',exact:true}).count(),0)
    }
    const setTool=async mode=>{
      const response=await page.request.patch(new URL('/api/storage/config/ui',page.url()).href,{data:{
        settings:{toolCallExpansionDefaults:{tools:{grep:mode}}},
      }})
      assert(response.ok())
    }
    await grep.waitFor()
    await setTool('hidden')
    await grep.waitFor({state:'detached'})
    await press(search,toolHit)
    await filtered.waitFor()
    assert.equal(await toolBody.count(),0,'A filtered search hit must not reveal a tool')
    assert.equal(windows,0,'A refused resident jump must keep its window')
    await setTool('collapsed')
    await grep.waitFor()
    assert.equal(await toolBody.count(),0,'Showing the tool must leave its group collapsed')
    await installPngReader(page)
    const matchInk=async (box, active)=>{
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      return page.evaluate(async ({png,active})=>{
        const [{pixels}]=await globalThis.__codenomadReadPngs([`data:image/png;base64,${png}`])
        // Ranked prose uses translucent ink: sample its rendered blends in both fixture palettes.
        const colors=active?[[250,204,21]]:[[235,213,163],[86,82,74]]
        const tolerance=active?0:2
        let matches=0
        for(let i=0;i<pixels.length;i+=4){
          if(colors.some(([r,g,b])=>Math.abs(pixels[i]-r)<=tolerance&&Math.abs(pixels[i+1]-g)<=tolerance&&Math.abs(pixels[i+2]-b)<=tolerance)
            && ++matches>=(active?1:32))return true
        }
        return false
      },{png:(await page.screenshot(box?{clip:box}:{})).toString('base64'),active})
    }
    for(const [hit,body] of [
      ['Existing technical tool match','Found Existing technical tool match'],
      ['Existing reasoning match','Existing reasoning match in the opened card'],
    ]){
      await press(search,hit)
      await filtered.waitFor({state:'detached'})
      await page.getByText(body,{exact:true}).and(page.locator('p, pre, code')).first().waitFor()
      if(touch)continue
      assert(await matchInk(undefined,true),`The active occurrence is painted for ${hit}`)
    }
    assert.equal(windows,0,'Revealing technical matches must also stay local')
    await press(search,'Existing arguments only')
    await rejected()
    assert.equal(windows,0,'Arguments-only refusal must also stay local')
    await alert.evaluate(el=>new Promise((resolve,reject)=>{
      const until=performance.now()+3000
      const step=now=>{
        const r=el.getBoundingClientRect()
        if(r.width>0&&r.height>0)return resolve()
        if(now>=until)return reject(Error('Alert did not gain layout'))
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }))
    const picker=search.getByRole('combobox',{name:scopeLabel,exact:true})
    await picker.waitFor()
    await picker.evaluate(el=>new Promise((resolve,reject)=>{
      const until=performance.now()+3000
      let prev=null,stableSince=0,frames=0
      const step=now=>{
        const r=el.getBoundingClientRect()
        const same=prev&&Math.abs(r.left-prev.left)<0.5&&Math.abs(r.top-prev.top)<0.5&&Math.abs(r.width-prev.width)<0.5&&Math.abs(r.height-prev.height)<0.5
        if(r.width>0&&r.height>0&&same){
          frames++
          if(frames>=2&&now-stableSince>=120)return resolve()
        }else{
          prev={left:r.left,top:r.top,width:r.width,height:r.height}
          stableSince=now
          frames=0
        }
        if(now>=until)return reject(Error('Select trigger did not settle'))
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }))
    await activate(picker)
    await page.getByRole('listbox').waitFor()
    const workspace=page.getByRole('option',{name:messages['history.workspace'],exact:true})
    const [ranked]=await Promise.all([read('ranked'),activate(workspace)])
    if(!ranked.ok())assert.fail(`Ranked broker status ${ranked.status()}: ${await ranked.text()}`)
    await search.getByRole('button',{name:'Existing ranked destination',exact:true}).waitFor()
    const first=search.getByRole('button',{name:'Existing ranked destination',exact:true})
    await search.locator('[aria-description="Another session · history-linked"]').and(first).waitFor()
    const rankedNames=await search.getByRole('button').filter({hasText:/^Existing /}).allTextContents()
    assert.deepEqual(rankedNames.slice(0,2).sort(),['Existing answer','Existing ranked destination'])
    assert.equal(rankedNames[2],'Existing remote tool match')
    if(!touch){
      const remotePreview=page.waitForResponse(response=>response.url().endsWith('/session/ses_another/message/message-00001'))
      await press(search,'Existing remote tool match')
      assert((await remotePreview).ok())
      const release=holdNextAnchor()
      try{
        const proposed=page.waitForRequest(request=>request.url().endsWith('/session-history/window')
          && request.postDataJSON()?.target?.messageID==='message-00001')
        await focusOpen()
        await page.keyboard.press('Enter')
        assert.equal((await proposed).postDataJSON().sessionID,'ses_another')
        await setTool('hidden')
        await grep.waitFor({state:'detached'})
      }finally{release()}
      await rejected()
      await search.getByRole('group',{name:'Another session',exact:true}).waitFor()
      assert.equal(windows,1,'Only the destination preflight may read a window on refusal')
      await setTool('collapsed')
      await grep.waitFor()
    }
    const beforeOpen=touch?0:1
    if(touch){
      await resize({width:844,height:245})
      const close=search.getByRole('button',{name:messages['messageSection.search.closeAriaLabel'],exact:true})
      const more=search.getByRole('button',{name:messages['history.furtherBack'],exact:true})
      const short=await search.boundingBox(), toolbar=await close.boundingBox()
      assert(short&&toolbar&&short.height<245)
      const bottom=short.y+short.height
      const inside=async locator=>{
        const box=await locator.boundingBox()
        return box&&box.height>0&&box.y+box.height<=bottom
      }
      assert(!await inside(more),'The continuation starts below the short window')
      await cdp.send('Input.synthesizeScrollGesture',{
        x:short.x+short.width/2,y:bottom-18,yDistance:-350,gestureSourceType:'touch',speed:800,preventFling:true,
      })
      await more.waitFor()
      // Rune may still be returning from elastic overscroll after CDP ends the gesture.
      // Tap only once the painted button is stable, rather than chasing it with a second tap.
      await more.evaluate(element=>new Promise((resolve,reject)=>{
        let previous, stable=0
        const deadline=performance.now()+3000
        const sample=now=>{
          const {x,y,width,height}=element.getBoundingClientRect()
          const rect=[x,y,width,height].join()
          stable=width>0&&height>0&&rect===previous?stable+1:0
          previous=rect
          if(stable>=4)resolve()
          else if(now>=deadline)reject(Error('Continuation never settled after the swipe'))
          else requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }))
      assert(await inside(more),'Scrolling the window body reveals the continuation')
      assert.deepEqual(await close.boundingBox(),toolbar,'The toolbar stays fixed while the body scrolls')
      const [older]=await Promise.all([read('ranked'),activate(more)])
      assert(older.ok())
      assert.equal(older.request().postDataJSON().cursor,(await ranked.json()).cursor)
      await search.getByRole('button',{name:'Existing older result',exact:true}).waitFor()
      await resize(landscape)
      await input.fill('Ex')
      await Promise.all([read('ranked'),input.fill('Existing')])
      await first.waitFor()
      // The inter-session preview adds content; return to the original mobile viewport.
      await resize(viewport)
    }
    const releasePreview=holdNextPreview()
    const preview=page.waitForResponse(response=>response.url().endsWith('/session/ses_another/message/message-00000'))
    void preview.catch(()=>{})
    const details=search.getByRole('group',{name:'Another session',exact:true})
    try{
      await press(search,'Existing ranked destination')
      await details.getByText(messages['messageSection.search.searching'],{exact:true}).waitFor()
      assert.equal(windows,beforeOpen,'Loading an excerpt must not page the transcript')
    }finally{
      releasePreview()
    }
    assert((await preview).ok())
    await details.getByText('history-linked',{exact:true}).waitFor()
    await details.getByText(messages['time.relative.hoursAgoShort'].replace('{count}','2'),{exact:true}).waitFor()
    await details.getByText(/Stored preview detail/).waitFor()
    assert.equal(windows,beforeOpen,'Preview must not read a transcript window')
    assert.equal(excerpts,1,'The preview reads the selected message once')
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    const open=search.getByRole('button',{name:messages['history.openSession'],exact:true})
    if(touch){
      const bounds=await search.boundingBox(), box=await open.boundingBox()
      assert(bounds&&box&&box.y>=bounds.y&&box.y+box.height<=bounds.y+bounds.height,
        'The open action must be inside the search window before the tap')
    }
    if(!touch){
      const placement='**/instance/api/session/ses_another'
      const release=Promise.withResolvers()
      let placements=0
      const observe=request=>{if(request.url().endsWith('/instance/api/session/ses_another'))placements++}
      page.on('request',observe)
      const box=await open.boundingBox()
      assert(box)
      const fail=async route=>{
        await release.promise
        await route.fulfill({status:503})
      }
      await page.route(placement,fail,{times:1})
      const placing=page.waitForRequest(request=>request.url().endsWith('/instance/api/session/ses_another'))
      const refused=page.waitForResponse(response=>response.url().endsWith('/instance/api/session/ses_another')&&response.status()===503)
      void refused.catch(()=>{})
      try{
        try{
          await Promise.all([placing,activate(open)])
          // The pinned Rune mirror does not expose Kit button disabled state.
          // Press the same physical point while the real request remains pending.
          await page.mouse.click(box.x+box.width/2,box.y+box.height/2)
        }finally{
          release.resolve()
        }
        await refused
        await details.getByText(messages['history.openFailed'],{exact:true}).waitFor()
        assert.equal(placements,1,'Repeated Open must not bind the destination twice')
        assert.equal(windows,beforeOpen)
      }finally{
        page.off('request',observe)
      }
    }
    if(!touch)await focusOpen()
    const [destination]=await Promise.all([read('window'),touch?activate(open):page.keyboard.press('Enter')])
    const requested=destination.request().postDataJSON()
    assert.deepEqual(requested,{sessionID:'ses_another',target:{kind:'around',messageID:'message-00000'}})
    assert.equal(excerpts,1,'Opening reads the destination window, not a second excerpt')
    await page.getByRole('heading',{name:'Another session',exact:true}).waitFor()
    assert.equal(await search.count(),0,'The previous search belongs to its source view')
    const arrival=page.getByRole('paragraph').filter({hasText:'Existing ranked destination'})
    await arrival.waitFor()
    const box=await arrival.boundingBox()
    assert(box&&await matchInk(box,false),'The destination passage paints the ranked search highlight')
  }finally{
    page.off('request',count)
    if(touch)await resize(viewport)
  }
}
