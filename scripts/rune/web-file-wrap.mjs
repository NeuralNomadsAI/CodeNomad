import assert from 'node:assert/strict'
import path from 'node:path'
import {bundleAssetPaths, workspacePolicy} from './web-workspace-policy.mjs'

const file='wrap.txt', key='opencode-session-right-panel-files-word-wrap-v1'
const windowKey='codenomad.rune.alpha.client-state.v1'
const wrapKey=on=>`instanceShell.filesShell.${on?'disable':'enable'}WordWrap`

export async function fileWrapBrowser({values,m,out,browser,storageState,fulfillWorkspaceCreation,writeOutput,recordCleanupError,url,root}) {
  assert(browser&&typeof fulfillWorkspaceCreation==='function'&&typeof writeOutput==='function','Attested browser, fulfillWorkspaceCreation, and writeOutput required for fileWrapBrowser')
  const assets=await bundleAssetPaths(path.resolve(root,process.env.RUNE_WEB_DIR??'target/rune-web-connected'))
  const policy=workspacePolicy({origin:url.origin,project:values.project,assets})
  const proof={headless:true,origin:url.origin,stages:[],refused:[],reads:[],errors:[]}
  let context,primaryError=null,passed=false
  try {
    context=await browser.newContext({viewport:{width:1280,height:900},colorScheme:'light',storageState})
    await context.route('**/*',async route=>{
      const req=route.request(),u=new URL(req.url()),p=u.pathname
      let allowed=await policy.request(req)
      if(!allowed&&u.origin===url.origin&&req.method()==='GET'&&(await req.allHeaders()).cookie){
        const [,id,operation]=p.match(/^\/api\/workspaces\/([^/]+)\/(files(?:\/preview)?)$/)??[]
        const [,nativeId]=p.match(/^\/workspaces\/([^/]+)\/instance\/api\/(?:location|command)$/)??[]
        if(policy.workspaces.has(id)){
          allowed=u.searchParams.size===2&&u.searchParams.get('directory')===values.project
            &&u.searchParams.get('path')===(operation==='files'?'.':file)
          if(allowed)proof.reads.push({operation,workspace:id})
        }else if(policy.workspaces.has(nativeId)){
          allowed=u.searchParams.size===1&&u.searchParams.get('location[directory]')===values.project
        }
      }
      if(!allowed){proof.refused.push(`${req.method()} ${p}`);return route.abort('blockedbyclient')}
      if(req.method()==='POST'&&p==='/api/workspaces')return fulfillWorkspaceCreation(route,policy)
      return route.continue()
    })

    const mirror=page=>page.locator('[data-rune-a11y]')
    const button=(page,name)=>mirror(page).getByRole('button',{name,exact:true})
    const press=async locator=>{
      await locator.waitFor({state:'attached'})
      for(const deadline=Date.now()+20000;await locator.evaluate(el=>el.disabled||el.getAttribute('aria-disabled')==='true');){
        assert(Date.now()<deadline,'Product control remained disabled')
        await new Promise(resolve=>setTimeout(resolve,20))
      }
      await locator.click({force:true})
    }
    const boot=async page=>{
      await page.waitForFunction(()=>globalThis.__codenomadRuneBoot?.state==='ready',undefined,{timeout:60000})
      // Interact with the final canvas, including when a restored tab replaces the launcher.
      await (await page.waitForFunction(()=>['web.handover.done','web.gpu.failed','web.handover.failed']
        .some(name=>performance.getEntriesByName(name).length))).dispose()
      await press(button(page,m['folderSelection.servers.dialog.connect']))
    }
    const heading=page=>mirror(page).getByRole('heading',{name:'Existing history',exact:true})
    const enter=async page=>{
      await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:60000})
      await boot(page)
      for(const deadline=Date.now()+20000;;){
        const input=page.locator('textarea:focus')
        if(await input.count()&&await input.getAttribute('aria-label')===m['instanceInfo.labels.folder']){
          await input.fill(values.project)
          await page.keyboard.press('Enter')
          break
        }
        assert(Date.now()<deadline,'Real project path textarea must be focusable')
        await page.keyboard.press('Tab')
        await page.waitForTimeout(20)
      }
      await mirror(page).getByRole('tab',{name:values.project,exact:true}).waitFor()
      const label=m['window.menu.leftPanel'],left=button(page,label)
      await left.waitFor()
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      if(await left.getAttribute('aria-expanded')!=='true')await press(left)
      await press(mirror(page).getByRole('region',{name:label,exact:true}).getByRole('listitem',{name:'Existing history',exact:true}))
      await heading(page).waitFor()
    }
    const open=async page=>{
      const right=button(page,m['window.menu.rightPanel'])
      await right.waitFor()
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      const files=mirror(page).getByRole('tab',{name:m['instanceShell.rightPanel.tabs.files'],exact:true})
      if(await right.getAttribute('aria-expanded')!=='true')await press(right)
      await files.waitFor()
      if(await files.getAttribute('aria-selected')!=='true')await press(files)
      await press(button(page,`${m['filesPanel.viewer']} · ${file}`))
    }
    const observe=async (page,on,stage)=>{
      const label=m[wrapKey(on)]
      await button(page,label).waitFor()
      assert.equal(await button(page,m[wrapKey(!on)]).count(),0)
      proof.stages.push({stage,label,value:await page.evaluate(key=>localStorage.getItem(key),key)})
    }
    const a=await context.newPage(),b=await context.newPage()
    for(const page of [a,b]){
      page.setDefaultTimeout(20000)
      page.on('pageerror',error=>proof.errors.push(error.message))
      await enter(page)
      await open(page)
      await observe(page,false,page===a?'a-default':'b-default')
    }
    assert.equal(await b.evaluate(()=>window.opener),null,'B must be an independent tab')
    await press(button(a,m[wrapKey(false)]))
    await observe(a,true,'a-toggle-on')
    assert.equal(await b.evaluate(key=>localStorage.getItem(key),key),'on','Tabs must share actual localStorage')
    await press(button(b,m['gitPanel.backChat']))
    await open(b)
    await observe(b,true,'b-reopened-on')

    await b.reload({waitUntil:'domcontentloaded',timeout:60000})
    await boot(b)
    await heading(b).waitFor()
    await open(b)
    await observe(b,true,'b-reloaded-on')
    await press(button(b,m[wrapKey(true)]))
    await observe(b,false,'b-toggle-off')
    assert.equal(await a.evaluate(key=>localStorage.getItem(key),key),'off')
    await press(button(a,m['gitPanel.backChat']))
    await open(a)
    await observe(a,false,'a-reopened-off')

    const ids=await Promise.all([a,b].map(page=>page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)).session.tabs[0].workspaceId,windowKey)))
    assert.notEqual(ids[0],ids[1],'Tabs own different workspace records')
    assert(proof.reads.some(read=>read.operation==='files/preview'))
    assert.deepEqual(proof.refused,[])
    assert.deepEqual(proof.errors,[])
    proof.result='pass'
    passed=true
  }catch(error){
    primaryError=error
    proof.result='fail'
    proof.failure=error?.message??String(error)
    await Promise.allSettled(context?.pages().map(async(page,index)=>{
      await writeOutput(`file-wrap-tab-${index}.aria.yml`,await page.locator('body').ariaSnapshot({timeout:2000}))
    })??[])
    throw error
  }finally{
    let cleanupError=null
    try{await context?.close()}catch(closeError){
      recordCleanupError?.('file-wrap context.close',closeError)
      ;(proof.cleanupErrors??=[]).push(`context.close: ${closeError.message}`)
      if(proof.result==='pass'){proof.result='fail';proof.failure=closeError.message}
      cleanupError??=closeError
    }
    try{await writeOutput('file-wrap-proof.json',JSON.stringify(proof,null,2))}catch(writeError){
      recordCleanupError?.('file-wrap proof write',writeError)
      cleanupError??=writeError
    }
    if(!primaryError&&cleanupError)throw cleanupError
  }
  if(passed)console.log(JSON.stringify({runner:'web-file-wrap',result:proof.result,out}))
}
