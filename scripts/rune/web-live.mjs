import assert from 'node:assert/strict'

export function command(action) {
  assert(process.send,'Run the mobile smoke through launcher-fixture.mjs')
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error(`No fixture acknowledgement: ${action}`)),15000)
    process.once('message', ({value,error})=>{
      clearTimeout(timer)
      if(error)reject(Error(error))
      else resolve(value)
    })
    process.send(action)
  })
}

export async function mobileLive({page,context,url,messages,revoke,eventSources,tap=(x,y)=>page.touchscreen.tap(x,y)}){
  const text=value=>page.getByText(value,{exact:true})
  const before=eventSources()
  assert(before>0)
  await command('live')
  await text('Mobile live SSE only').waitFor()
  await command('cut')
  await text(messages['rune.reconnecting']).waitFor()
  assert.equal(await text(messages['authRecovery.pairingTitle']).count(),0)
  await command('resume')
  await text('Mobile recovered history').waitFor()
  await text(messages['rune.ready']).waitFor()
  const evidence={live:true,recovered:true}
  if(revoke){
    const draft='Draft across device revocation'
    const group=page.getByRole('group',{name:messages['rune.prompt'],exact:true})
    const focus=async()=>{
      const box=await group.boundingBox();assert(box)
      await tap(box.x+box.width/2,box.y+box.height/2)
      const editor=page.locator('textarea:focus')
      await editor.waitFor({timeout:2500})
      return editor
    }
    await (await focus()).fill(draft)
    await command('revoke')
    const dialog=page.getByRole('dialog',{name:messages['authRecovery.pairingTitle']})
    await dialog.waitFor()
    await text(messages['authRecovery.pairing']).waitFor()
    const check=dialog.getByRole('button',{name:messages['authRecovery.check'],exact:true})
    const denied=page.waitForResponse(response=>response.url()===`${url.origin}/api/auth/status`&&response.ok())
    await check.click({force:true})
    assert.equal((await (await denied).json()).pairingRequired,true)
    const again=new URL(await command('pair'))
    assert.equal(again.origin,url.origin)
    assert.equal(again.pathname,'/remote-pair')
    again.searchParams.set('locale','he')
    const tab=await context.newPage()
    try {
      await navigatePair(tab, again)
    } finally { await tab.close() }
    await page.bringToFront()
    if(await dialog.count())await check.click({force:true,timeout:2500}).catch(async error=>{
      if(await dialog.count())throw error
    })
    await dialog.waitFor({state:'detached'})
    await text(messages['rune.ready']).waitFor()
    assert.equal(await (await focus()).inputValue(),draft)
    assert(eventSources()>before,'Re-pairing must open a new real EventSource')
    assert.equal(page.url(),url.href,'Original document stays on its conversation')
    evidence.repairedWithDraft=true
  }
  await command('reset')
  return evidence
}

export async function navigatePair(tab, url){
  const pairPath='/api/remote-control/pair'
  await tab.route('**/*', route=>{
    const req=route.request(), requested=new URL(req.url())
    const exchange=requested.pathname===pairPath&&req.method()==='POST'&&req.postDataJSON()?.code===url.hash.slice(1)
    return requested.origin===url.origin&&(exchange||req.method()==='GET'&&['/remote-pair','/'].includes(requested.pathname))
      ?route.continue():route.abort()
  })
  try {
    const exchange=tab.waitForResponse(response=>new URL(response.url()).pathname===pairPath)
    await tab.goto(url.href,{waitUntil:'commit'})
    assert.equal((await exchange).status(),200)
    await tab.waitForURL(target=>target.pathname==='/' && target.searchParams.get('locale')===url.searchParams.get('locale'))
  } finally { await tab.unrouteAll() }
}
