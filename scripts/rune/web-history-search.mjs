import assert from 'node:assert/strict'

export async function historySearch(page, messages) {
  const press=(root,key)=>root.getByRole('button',{name:messages[key]??key,exact:true}).click({force:true})
  await press(page,'messageSection.search.ariaLabel')
  const search=page.getByRole('region',{name:messages['messageSection.search.ariaLabel']})
  const input=page.getByRole('textbox',{name:messages['messageSection.search.ariaLabel'],exact:true})
  await input.waitFor({state:'attached'})
  const read=(route)=>page.waitForResponse(response=>response.url().endsWith(`/session-history/${route}`)
    && (route==='window'||response.request().postDataJSON()?.query==='Existing'))
  const [literal]=await Promise.all([read('query'),page.keyboard.insertText('Existing')])
  assert(literal.ok())
  let windows=0
  const count=request=>{if(request.url().endsWith('/session-history/window'))windows++}
  page.on('request',count)
  try{
    await press(search,'Existing answer')
    assert.equal(windows,0,'A resident result needs no window')
    const [ranked]=await Promise.all([read('ranked'),press(search,'history.workspace')])
    assert(ranked.ok())
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
