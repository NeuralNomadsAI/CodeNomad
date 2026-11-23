import assert from 'node:assert/strict'

const OUTLINES='codenomad.rune.alpha.outlines.v1'
const STATE='codenomad.rune.alpha.client-state.v1'
const outlineRequest=request=>request.method()==='POST'&&request.url().endsWith('/session-history/outline')

export async function outlineRestore({page,m,boot,connect,draft,holdNext}){
  const rail=page.getByRole('navigation',{name:m['messageTimeline.ariaLabel']})
  const tool=rail.getByRole('button',{name:'read',exact:true})
  const deltaMarker=rail.getByRole('button',{name:'outline-delta',exact:true})
  const passage=page.getByRole('paragraph').filter({hasText:/^Existing project history$/})
  const scrollToHead=async()=>{
    await rail.waitFor()
    const box=await rail.boundingBox()
    assert(box)
    await page.mouse.move(box.x+8,box.y+15)
    await page.mouse.wheel(0,-100000)
    await tool.waitFor()
  }
  await scrollToHead()
  await page.waitForFunction(({outlines,state})=>{
    const saved=JSON.parse(sessionStorage.getItem(state)??'null')
    return sessionStorage.getItem(outlines)&&!!saved?.session?.tabs?.some(t=>t.drafts?.ses_existing)
  },{outlines:OUTLINES,state:STATE})
  const disk=await page.evaluate(key=>sessionStorage.getItem(key),OUTLINES)
  assert(!disk.includes('Existing project history')&&!disk.includes('Tool output'),'The outline must omit message bodies')
  const [[hash,serialized]]=JSON.parse(disk)
  assert.match(hash,/^[a-f0-9]{64}$/)
  const saved=JSON.parse(serialized)
  assert.equal(saved.format,1)
  assert.equal(saved.metadata.identity.session,'ses_existing')
  assert.equal(saved.metadata.checkpoints.length,2)
  const reload=async()=>{
    await page.reload({waitUntil:'domcontentloaded',timeout:60000})
    await boot()
    await connect()
  }
  const release=Promise.withResolvers()
  holdNext(release.promise)
  const revalidating=page.waitForRequest(outlineRequest)
  const fresh=page.waitForResponse(response=>outlineRequest(response.request()))
  void fresh.catch(()=>{})
  let offered
  try{
    await reload()
    offered=(await revalidating).postDataJSON()
    assert.deepEqual(offered.known,saved.metadata.checkpoints)
    await scrollToHead()
    await draft()
  }finally{
    release.resolve(503)
  }
  assert.equal((await fresh).status(),503)
  const error=page.getByText(m['history.navigation.outlineUnavailable'],{exact:true})
  await error.waitFor()
  await tool.waitFor()
  const retry=page.getByRole('button',{name:m['messageSection.search.retry'],exact:true})
  const resume=Promise.withResolvers()
  holdNext(resume.promise)
  const refreshed=page.waitForResponse(response=>outlineRequest(response.request()))
  void refreshed.catch(()=>{})
  let before
  try{
    await retry.click({force:true})
    await error.waitFor({state:'detached'})
    await passage.waitFor()
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    before=await passage.boundingBox()
    assert(before&&before.height>0&&before.y>=0)
    assert.equal(await deltaMarker.count(),0)
  }finally{resume.resolve()}
  const result=await refreshed
  assert.deepEqual(result.request().postDataJSON().known,offered.known)
  const delta=await result.json()
  assert.equal(delta.checkpoints[0].changed,false)
  assert(delta.entries.every(row=>row.seq>delta.checkpoints[0].through))
  await deltaMarker.waitFor()
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  const after=await passage.boundingBox()
  assert(after&&Math.abs(after.y-before.y)<=1,'The delta must leave the transcript reading position unchanged')
  await page.evaluate(({key,disk})=>{
    const items=JSON.parse(disk);items[0][0]='0'.repeat(64)
    sessionStorage.setItem(key,JSON.stringify(items))
  },{key:OUTLINES,disk})
  const cold=page.waitForRequest(outlineRequest)
  await reload()
  assert.equal((await cold).postDataJSON().known,undefined,'Reject the corrupt cache and read cold')
  await scrollToHead()
  await draft()
  return {cold:true,known:offered.known.length,unchanged:1,retainedOn503:true,deltaPainted:true,
    readingPosition:[before.y,after.y],corruptFallback:true,draftPreserved:true}
}
