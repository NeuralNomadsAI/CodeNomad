import assert from 'node:assert/strict'

const OUTLINES='codenomad.rune.alpha.outlines.v1'
const STATE='codenomad.rune.alpha.client-state.v1'
const outlineRequest=request=>request.method()==='POST'&&request.url().endsWith('/session-history/outline')

export async function outlineRestore({page,m,boot,connect,draft,holdNext}){
  const rail=page.getByRole('navigation',{name:m['messageTimeline.ariaLabel']})
  const tool=rail.getByRole('button',{name:'read',exact:true})
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
    release.resolve()
  }
  const delta=await (await fresh).json()
  assert.equal(delta.checkpoints[0].changed,false)
  assert(delta.entries.every(row=>row.seq>delta.checkpoints[0].through))
  await page.evaluate(({key,disk})=>{
    const items=JSON.parse(disk);items[0][0]='0'.repeat(64)
    sessionStorage.setItem(key,JSON.stringify(items))
  },{key:OUTLINES,disk})
  const cold=page.waitForRequest(outlineRequest)
  await reload()
  assert.equal((await cold).postDataJSON().known,undefined,'Reject the corrupt cache and read cold')
  await scrollToHead()
  await draft()
  return {cold:true,known:offered.known.length,unchanged:1,corruptFallback:true,draftPreserved:true}
}
