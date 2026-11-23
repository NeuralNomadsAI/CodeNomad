import assert from 'node:assert/strict'
import {installPngReader} from './png-pixels.mjs'

export async function historySearch(page, messages) {
  const press=(root,key)=>root.getByRole('button',{name:messages[key]??key,exact:true}).click({force:true})
  await press(page,'messageSection.search.ariaLabel')
  const search=page.getByRole('region',{name:messages['messageSection.search.ariaLabel']})
  const close=await search.getByRole('button',{name:messages['messageSection.search.closeAriaLabel']}).boundingBox()
  assert(close)
  await page.mouse.click(close.x-24,close.y+close.height/2)
  const input=page.locator('textarea:focus')
  await input.waitFor({state:'attached'})
  const read=(route)=>page.waitForResponse(response=>response.url().endsWith(`/session-history/${route}`)
    && (route==='window'||response.request().postDataJSON()?.query==='Existing'))
  const [literal]=await Promise.all([read('query'),input.fill('Existing')])
  assert(literal.ok(),`Literal broker status ${literal.status()}`)
  let windows=0
  const count=request=>{if(request.url().endsWith('/session-history/window'))windows++}
  page.on('request',count)
  try{
    await press(search,'Existing answer')
    assert.equal(windows,0,'A resident result needs no window')
    await Promise.all([read('query'),press(search,'history.technical')])
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
    const [ranked]=await Promise.all([read('ranked'),press(search,'history.workspace')])
    assert(ranked.ok(),`Ranked broker status ${ranked.status()}`)
    await search.getByRole('button',{name:'Existing ranked destination',exact:true}).waitFor()
    assert.deepEqual(await search.getByRole('button').filter({hasText:/^Existing /}).allTextContents(),
      ['Existing ranked destination','Existing answer'])
    const preview=page.waitForResponse(response=>response.url().endsWith('/session/ses_another/message/message-00000'))
    await press(search,'Existing ranked destination')
    assert((await preview).ok())
    assert.equal(windows,0,'Preview must not read a transcript window')
    const [destination]=await Promise.all([read('window'),press(search,'history.openSession')])
    const requested=destination.request().postDataJSON()
    assert.deepEqual(requested,{sessionID:'ses_another',target:{kind:'around',messageID:'message-00000'}})
    await page.getByRole('heading',{name:'Another session',exact:true}).waitFor()
    await page.getByRole('paragraph').filter({hasText:'Existing ranked destination'}).waitFor()
    assert.equal(await search.count(),0,'The previous search belongs to its source view')
  }finally{page.off('request',count)}
}
