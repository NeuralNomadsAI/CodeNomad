import assert from 'node:assert/strict'
import {installPngReader} from './png-pixels.mjs'

export async function historySearch(page, messages) {
  const press=(root,key)=>root.getByRole('button',{name:messages[key]??key,exact:true}).click({force:true})
  await press(page,'messageSection.search.ariaLabel')
  const search=page.getByRole('region',{name:messages['messageSection.search.ariaLabel']})
  const input=page.locator('textarea').and(page.getByRole('textbox',{name:messages['messageSection.search.ariaLabel'],exact:true}))
  await input.waitFor({state:'attached'})
  const read=(route)=>page.waitForResponse(response=>response.url().endsWith(`/session-history/${route}`)
    && (route==='window'||response.request().postDataJSON()?.query==='Existing'))
  const [literal]=await Promise.all([read('query'),input.fill('Existing')])
  assert(literal.ok(),`Literal broker status ${literal.status()}`)
  await search.getByRole('button',{name:'Existing answer',exact:true}).waitFor()
  const title=search.getByText(messages['messageSection.search.ariaLabel'],{exact:true})
  const start=await title.boundingBox()
  assert(start)
  await page.mouse.move(start.x+8,start.y+start.height/2)
  await page.mouse.down()
  // Move the window away from the transcript area sampled for active-match ink.
  const height=page.viewportSize().height
  await page.mouse.move(start.x+48,height-20,{steps:5})
  await page.mouse.up()
  await title.evaluate((element,start)=>new Promise((resolve,reject)=>{
    const until=performance.now()+3000
    const sample=now=>{
      if(element.getBoundingClientRect().top>start+80)resolve()
      else if(now>=until)reject(Error('Dragging the toolbar must move the search window'))
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }),start.y)
  let windows=0
  const count=request=>{if(request.url().endsWith('/session-history/window'))windows++}
  page.on('request',count)
  try{
    await press(search,'Existing answer')
    assert.equal(windows,0,'A resident result needs no window')
    const technical=search.getByRole('checkbox',{name:messages['history.technical'],exact:true})
    await Promise.all([read('query'),technical.click({force:true})])
    assert.equal(await technical.getAttribute('aria-checked'),'true')
    await installPngReader(page)
    for(const [hit,body] of [
      ['Existing technical tool match','Found Existing technical tool match'],
      ['Existing reasoning match','Existing reasoning match in the opened card'],
    ]){
      await press(search,hit)
      await page.getByText(body,{exact:true}).and(page.locator('p, pre, code')).first().waitFor()
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
    const picker=search.getByRole('button',{name:`${messages['history.scope']}: ${messages['history.session']}`,exact:true})
    await picker.click({force:true})
    const workspace=page.getByRole('option',{name:messages['history.workspace'],exact:true})
    const [ranked]=await Promise.all([read('ranked'),workspace.click({force:true})])
    if(!ranked.ok())assert.fail(`Ranked broker status ${ranked.status()}: ${await ranked.text()}`)
    await search.getByRole('button',{name:'Existing ranked destination',exact:true}).waitFor()
    const first=search.getByRole('button',{name:'Existing ranked destination',exact:true})
    await search.locator('[aria-description="Another session · history-fixture"]').and(first).waitFor()
    assert.deepEqual(await search.getByRole('button').filter({hasText:/^Existing /}).allTextContents(),
      ['Existing ranked destination','Existing answer'])
    const preview=page.waitForResponse(response=>response.url().endsWith('/session/ses_another/message/message-00000'))
    await press(search,'Existing ranked destination')
    assert((await preview).ok())
    assert.equal(windows,0,'Preview must not read a transcript window')
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    const [destination]=await Promise.all([read('window'),press(search,'history.openSession')])
    const requested=destination.request().postDataJSON()
    assert.deepEqual(requested,{sessionID:'ses_another',target:{kind:'around',messageID:'message-00000'}})
    await page.getByRole('heading',{name:'Another session',exact:true}).waitFor()
    await page.getByRole('paragraph').filter({hasText:'Existing ranked destination'}).waitFor()
    assert.equal(await search.count(),0,'The previous search belongs to its source view')
  }finally{page.off('request',count)}
}
