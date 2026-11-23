import assert from 'node:assert/strict'
import {installPngReader} from './png-pixels.mjs'

export async function historySearch(page, messages, touch) {
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
  const input=page.locator('textarea').and(page.getByRole('textbox',{name:messages['messageSection.search.ariaLabel'],exact:true}))
  await input.waitFor({state:'attached'})
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
  const count=request=>{if(request.url().endsWith('/session-history/window'))windows++}
  page.on('request',count)
  try{
    await press(search,'Existing answer')
    assert.equal(windows,0,'A resident result needs no window')
    const technical=search.getByRole('checkbox',{name:messages['history.technical'],exact:true})
    await Promise.all([read('query'),activate(technical)])
    assert.equal(await technical.getAttribute('aria-checked'),'true')
    await installPngReader(page)
    for(const [hit,body] of [
      ['Existing technical tool match','Found Existing technical tool match'],
      ['Existing reasoning match','Existing reasoning match in the opened card'],
    ]){
      await press(search,hit)
      await page.getByText(body,{exact:true}).and(page.locator('p, pre, code')).first().waitFor()
      if(touch)continue
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      const screenshot=await page.screenshot()
      const active=await page.evaluate(async png=>{
        const [{pixels}]=await globalThis.__codenomadReadPngs([`data:image/png;base64,${png}`])
        for(let i=0;i<pixels.length;i+=4){
          if(pixels[i]===250&&pixels[i+1]===204&&pixels[i+2]===21)return true
        }
        return false
      },screenshot.toString('base64'))
      assert(active,`The active occurrence is painted for ${hit}`)
    }
    assert.equal(windows,0,'Revealing technical matches must also stay local')
    // Rune exposes the select trigger as a button in the unfocused web mirror.
    const picker=search.getByRole('button',{name:scopeLabel,exact:true})
    await activate(picker)
    const workspace=page.getByRole('option',{name:messages['history.workspace'],exact:true})
    const [ranked]=await Promise.all([read('ranked'),activate(workspace)])
    if(!ranked.ok())assert.fail(`Ranked broker status ${ranked.status()}: ${await ranked.text()}`)
    await search.getByRole('button',{name:'Existing ranked destination',exact:true}).waitFor()
    const first=search.getByRole('button',{name:'Existing ranked destination',exact:true})
    await search.locator('[aria-description="Another session · history-fixture"]').and(first).waitFor()
    assert.deepEqual(await search.getByRole('button').filter({hasText:/^Existing /}).allTextContents(),
      ['Existing ranked destination','Existing answer'])
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
    const preview=page.waitForResponse(response=>response.url().endsWith('/session/ses_another/message/message-00000'))
    await press(search,'Existing ranked destination')
    assert((await preview).ok())
    assert.equal(windows,0,'Preview must not read a transcript window')
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    const open=search.getByRole('button',{name:messages['history.openSession'],exact:true})
    if(touch){
      const bounds=await search.boundingBox(), box=await open.boundingBox()
      assert(bounds&&box&&box.y>=bounds.y&&box.y+box.height<=bounds.y+bounds.height,
        'The open action must be inside the search window before the tap')
    }
    const [destination]=await Promise.all([read('window'),activate(open)])
    const requested=destination.request().postDataJSON()
    assert.deepEqual(requested,{sessionID:'ses_another',target:{kind:'around',messageID:'message-00000'}})
    await page.getByRole('heading',{name:'Another session',exact:true}).waitFor()
    await page.getByRole('paragraph').filter({hasText:'Existing ranked destination'}).waitFor()
    assert.equal(await search.count(),0,'The previous search belongs to its source view')
  }finally{
    page.off('request',count)
    if(touch)await resize(viewport)
  }
}
