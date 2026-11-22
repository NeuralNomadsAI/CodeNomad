import assert from 'node:assert/strict'

export function command(action) {
  assert(process.send,'Run the mobile smoke through launcher-fixture.mjs')
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error(`No fixture acknowledgement: ${action}`)),action==='restart'?45000:15000)
    process.once('message', ({value,error})=>{
      clearTimeout(timer)
      if(error)reject(Error(error))
      else resolve(value)
    })
    process.send(action)
  })
}

export async function mobileLive({page,context,url,messages,revoke,eventSources,workspaces,fromLink=true,tap=(x,y)=>page.touchscreen.tap(x,y)}){
  const text=value=>page.getByText(value,{exact:true})
  const connecting=text(messages['instanceShell.connection.connecting'])
  const before=eventSources()
  assert(before>0)
  await command('live')
  await text('Mobile live SSE only').waitFor()
  await command('cut')
  await connecting.waitFor()
  assert.equal(await text(messages['authRecovery.pairingTitle']).count(),0)
  let older
  if(workspaces){
    const button=page.getByRole('button',{name:messages['rune.older'],exact:true})
    const disabled=await button.evaluate(el=>el.disabled||el.getAttribute('aria-disabled')==='true')
    older={expected:'disabled',observed:disabled?'disabled':'enabled',status:disabled?'pass':'known-gap',
      ...(disabled?{}:{issue:'https://github.com/anomalyco/rune/issues/118'})}
  }
  await command('resume')
  await text('Mobile recovered history').waitFor()
  await connecting.waitFor({state:'hidden'})
  const evidence={live:true,recovered:true,older}
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
    const afterTransport=eventSources()
    const previous=[...workspaces]
    const {older,witness}=await command('restart')
    assert(previous.length&&previous.every(id=>older.includes(id)),'Fixture had the browser-owned workspaces before reboot')
    await text('Mobile Rust restart history').waitFor({timeout:45000})
    await connecting.waitFor({state:'hidden'})
    const inventory=await context.request.get(`${url.origin}/api/workspaces`)
    assert(inventory.ok())
    const ids=(await inventory.json()).map(row=>row.id)
    assert(older.every(id=>!ids.includes(id)),'The restarted listener must not still have the old workspace ids')
    assert(ids.includes(witness),'Reopening by folder must leave the other occurrence intact')
    const fresh=[...workspaces].filter(id=>!previous.includes(id))
    assert(fresh.length===1&&ids.includes(fresh[0]),'Browser must claim exactly one new workspace for the active tab')
    for(const id of previous)workspaces.delete(id)
    assert.equal(await (await focus()).inputValue(),draft)
    assert(eventSources()>afterTransport,'Rust restart must open a new EventSource')
    assert.equal(page.url(),url.href)
    evidence.recoveredAfterRustRestart=true
    const beforeRevoke=eventSources()
    await command('revoke')
    const dialog=page.getByRole('dialog',{name:messages['authRecovery.pairingTitle']})
    await dialog.waitFor()
    await text(messages['rune.pairing_guide']).waitFor()
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
      await navigatePair(tab, again, {fromLink})
    } finally { await tab.close() }
    await page.bringToFront()
    if(await dialog.count())await check.click({force:true,timeout:2500}).catch(async error=>{
      if(await dialog.count())throw error
    })
    await dialog.waitFor({state:'detached'})
    await connecting.waitFor({state:'hidden'})
    assert.equal(await (await focus()).inputValue(),draft)
    assert(eventSources()>beforeRevoke,'Re-pairing must open a new real EventSource')
    assert.equal(page.url(),url.href,'Original document stays on its conversation')
    evidence.repairedWithDraft=true
    evidence.crossOriginRePairLink=fromLink
  }
  await command('reset')
  return evidence
}

export async function navigatePair(tab, url, {fromLink=false}={}){
  const pairPath='/api/remote-control/pair'
  const referrer='https://rune-pair-source.test/'
  let observedReferrer
  const routePair=async route=>{
    const req=route.request(), requested=new URL(req.url())
    if(fromLink&&requested.href===referrer){
      const target=url.href.replaceAll('&','&amp;').replaceAll('"','&quot;')
      return route.fulfill({contentType:'text/html',body:`<a href="${target}">Pair</a>`})
    }
    if(requested.origin===url.origin&&requested.pathname==='/remote-pair'&&req.isNavigationRequest()){
      observedReferrer=(await req.allHeaders()).referer
    }
    const exchange=requested.pathname===pairPath&&req.method()==='POST'&&req.postDataJSON()?.code===url.hash.slice(1)
    return requested.origin===url.origin&&(exchange||req.method()==='GET'&&['/remote-pair','/'].includes(requested.pathname))
      ?route.continue():route.abort()
  }
  await tab.route('**/*', routePair)
  try {
    if(fromLink)await tab.goto(referrer)
    const document=tab.waitForResponse(response=>response.request().isNavigationRequest()&&
      new URL(response.url()).origin===url.origin&&new URL(response.url()).pathname==='/remote-pair')
    void document.catch(()=>{})
    const exchange=tab.waitForResponse(response=>new URL(response.url()).pathname===pairPath)
    void exchange.catch(()=>{})
    if(fromLink)await tab.getByRole('link',{name:'Pair',exact:true}).click({noWaitAfter:true})
    else await tab.goto(url.href,{waitUntil:'commit'})
    assert.equal((await document).status(),200,'Serve the pairing document even with a foreign Referer')
    if(fromLink)assert.equal(observedReferrer,referrer,'Pairing navigation must carry a real cross-origin Referer')
    assert.equal((await exchange).status(),200)
    await tab.waitForURL(target=>target.pathname==='/' && target.searchParams.get('locale')===url.searchParams.get('locale'))
  } finally { await tab.unroute('**/*',routePair) }
}
