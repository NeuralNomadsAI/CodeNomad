import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {mobileClientHints, mobileContext} from '../../../scripts/rune/web-mobile.mjs'
import {activateControl,launchOwnedChromium} from '../../../scripts/rune/web-chromium.mjs'
import {createAttestedFetch,redactSecrets} from '../../../scripts/native-fixture-http.mjs'
import {commit, edited, filename, initial, prompt, reply, title, assertPrivateChild} from './journey-host.mjs'
import {signInFixture,until} from './fixture-host.mjs'
import {guardJourney} from './journey-web-policy.mjs'
import {traceJourneyTouch} from './journey-touch-trace.mjs'

export async function journeyBrowser(host, web, report, executablePath){
  const {origin,rustPid,password,profile,project,env}=host
  assert(Number.isSafeInteger(rustPid)&&rustPid>0,'Owned Rust server PID required')
  const labels=JSON.parse(await readFile(new URL('../../../crates/rune-theme-codenomad/assets/catalogues/en.json',import.meta.url),'utf8'))
  const manifest=JSON.parse(await readFile(path.join(web,'bundle-manifest.json'),'utf8'))
  assert.equal(manifest.testSupport,false,'Use a product WASM artifact')
  const http=await signInFixture(origin,password,rustPid)
  let storageState
  try{
    storageState=await http.storageState()
  }finally{await http.dispose()}
  const rustFetch=createAttestedFetch(origin,Number(new URL(origin).port),rustPid)
  const cookieHeader=(storageState?.cookies??[]).map(c=>`${c.name}=${c.value}`).join('; ')
  const browserStorageState={
    ...storageState,
    cookies:(storageState?.cookies??[]).map(c=>({...c,value:'fixture-relay-placeholder'})),
  }
  const owned=await launchOwnedChromium({executablePath,profile,env:assertPrivateChild(env),origin,targetPid:rustPid,injectCookie:cookieHeader})
  const {browser}=owned
  report.chromiumPID=owned.pid
  try{
    const context=await browser.newContext({...mobileContext(browser),storageState:browserStorageState,serviceWorkers:'block',colorScheme:'light'})
    const refused=[], errors=[]
    report.refused=refused
    const reads=await guardJourney(context,{origin,project,web,refused,attestedFetch:rustFetch,cookieHeader})
    const page=await context.newPage()
    await traceJourneyTouch(page,[
      labels['instanceShell.rightPanel.tabs.files'],labels['instanceShell.rightPanel.tabs.status'],
      labels['window.menu.rightPanel'],labels['window.menu.leftPanel'],
      `${labels['filesPanel.viewer']} · ${filename}`,labels['filesPanel.viewer'],
    ])
    const boot=async()=>{
      page.setDefaultTimeout(20000)
      page.on('pageerror',error=>errors.push(error.message))
      page.on('response',response=>{
        if(response.request().method()!=='GET'){
          (report.writes??=[]).push({method:response.request().method(),path:new URL(response.url()).pathname,status:response.status()})
        }
      })
      await mobileClientHints(page,browser)
      await page.goto(`${origin}/?locale=en`,{waitUntil:'domcontentloaded',timeout:60000})
      await page.waitForFunction(()=>globalThis.__codenomadRuneBoot?.state==='ready')
    }
    const mirror=()=>page.locator('[data-rune-a11y]')
    const named=(role,name)=>mirror().getByRole(role,{name,exact:true})
    const button=name=>named('button',name)
    const text=value=>mirror().getByText(value,{exact:true})
    const label=key=>{assert(labels[key],key);return labels[key]}
    let gesture=0
    const logTouch=(control,x,y)=>page.evaluate(gesture=>{window.__journeyTouch.gesture=gesture},
      {id:++gesture,control,x,y})
    async function press(locator){
      const box=await until(async()=>{
        if(await locator.count()!==1||!await locator.isEnabled())return false
        const first=await locator.boundingBox()
        if(!first?.width||!first.height)return false
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
        const next=await locator.boundingBox()
        if(next&&['x','y','width','height'].every(key=>Math.abs(first[key]-next[key])<0.5))return next
        return false
      },`stable, enabled ${locator}`,20000)
      await logTouch(locator.toString(),box.x+box.width/2,box.y+box.height/2)
      await activateControl(page,locator,{touch:true,rect:box})
      return box
    }
    async function editor(name){
      const field=page.locator('textarea:focus')
      for(let i=0;i<35;i++){
        if(await field.count()&&await field.getAttribute('aria-label')===name)return field
        await page.keyboard.press('Tab')
      }
      throw Error(`No focused editor: ${name}`)
    }
    const input=async(name,value)=>(await editor(name)).fill(value)
    async function tapEditor(name,value,x,y){
      await logTouch(name,x,y)
      await page.touchscreen.tap(x,y)
      const field=page.locator('textarea:focus')
      await field.waitFor({state:'attached'})
      assert.equal(await field.getAttribute('aria-label'),name)
      await field.fill(value)
    }
    async function panel(key,open=true){
      const toggle=button(label(key))
      await toggle.waitFor()
      if((await toggle.getAttribute('aria-expanded')==='true')!==open)await press(toggle)
      await named('region',label(key)).waitFor({state:open?'visible':'hidden'})
    }
    async function step(name, action){
      const entry={name,ok:false}, start=performance.now()
      report.steps.push(entry)
      try{
        await action()
        assert.deepEqual(refused,[],'No unadmitted browser request')
        assert.deepEqual(errors,[])
      }catch(error){entry.error=redactSecrets(error.message,[password])}
      entry.touch=await page.evaluate(()=>{
        const trace=window.__journeyTouch
        if(!trace)return []
        trace.gesture=null
        return trace.records.splice(0)
      }).catch(()=>[])
      const base=path.join(report.output,`web-${name}`)
      const proof=await Promise.allSettled([
        mirror().ariaSnapshot({timeout:3000}).catch(()=>page.locator('body').ariaSnapshot({timeout:3000}))
          .then(snapshot=>writeFile(`${base}.aria.yml`,snapshot)),
        page.screenshot({path:`${base}.png`,scale:'css',timeout:20000}),
      ])
      const failures=proof.filter(result=>result.status==='rejected')
      if(failures.length)entry.evidenceError=redactSecrets(failures.map(result=>result.reason.message).join('\n'),[password])
      entry.durationMs=Math.round(performance.now()-start)
      if(entry.error||entry.evidenceError)throw Error(entry.error??entry.evidenceError)
      entry.ok=true
    }
    const response=(method,pattern)=>page.waitForResponse(r=>r.request().method()===method&&r.ok()&&pattern.test(new URL(r.url()).pathname))
    const left='window.menu.leftPanel', right='window.menu.rightPanel'
    const preview=()=>button(`${label('filesPanel.viewer')} · ${filename}`)
    await step('launch',async()=>{
      await boot()
      await button(label('folderSelection.servers.dialog.connect')).waitFor()
    })
    await step('open-project',async()=>{
      await press(button(label('folderSelection.servers.dialog.connect')))
      await input(label('instanceInfo.labels.folder'),project)
      await page.keyboard.press('Enter')
      await named('tab',project).waitFor()
    })
    let id
    await step('new-session',async()=>{
      await panel(left)
      const created=response('POST',/\/instance\/api\/session$/);void created.catch(()=>{})
      await input(label('rune.session_title'),title)
      await page.keyboard.press('Enter')
      id=(await (await created).json()).data.id
      assert.match(id,/^ses_[\w-]+$/)
      report.sessionID=id
      await named('heading',title).waitFor()
    })
    await step('permission',async()=>{
      await input(label('rune.prompt'),prompt)
      await page.keyboard.press('Enter')
      await button(label('rune.allow_once')).waitFor()
      assert.equal(await readFile(path.join(project,filename),'utf8'),initial)
    })
    await step('tool-result',async()=>{
      const allowed=response('POST',new RegExp(`/session/${id}/permission/[^/]+/reply$`));void allowed.catch(()=>{})
      await press(button(label('rune.allow_once')));await allowed
      await text(reply).waitFor()
      await button(`Write ${filename}`).waitFor()
      assert.equal(await readFile(path.join(project,filename),'utf8'),edited)
    })
    await step('files',async()=>{
      const proof=report.filesTouch={requests:[]}
      const isPreview=req=>req.method()==='GET'&&new URL(req.url()).pathname.endsWith('/files/preview')
      const onRequest=req=>{if(isPreview(req))proof.requests.push('sent')}
      const onFailed=req=>{if(isPreview(req))proof.requests.push(req.failure()?.errorText??'failed')}
      page.on('request',onRequest)
      page.on('requestfailed',onFailed)
      try{
        await panel(right)
        const name=label('instanceShell.rightPanel.tabs.files')
        proof.tab=await press(named('tab',name))
        await mirror().getByRole('tab',{name,exact:true,selected:true}).waitFor({timeout:2500})
        proof.preview=await press(preview())
        await panel(right,false)
        const reader=named('region',label('filesPanel.viewer'))
        await reader.getByText(filename,{exact:true}).waitFor()
        await reader.getByRole('button',{name:label('instanceShell.rightPanel.actions.save'),exact:true}).waitFor()
        // Observe the exact response forwarded to Rune; CDP can omit a page-response event.
        const {status,file}=await until(reads.preview,'real file preview response')
        assert.equal(status,200)
        assert.equal(file.relativePath,filename)
        assert.equal(Buffer.from(file.contents,'base64').toString('utf8'),edited)
      }finally{
        page.off('request',onRequest)
        page.off('requestfailed',onFailed)
        proof.after=await page.evaluate(()=>window.__journeyTouch.snapshot())
      }
    })
    const gitMode=async key=>{
      const name=label(key)
      await panel(right)
      await press(named('radio',name))
      await mirror().getByRole('radio',{name,checked:true,exact:true}).waitFor()
    }
    await step('diff',async()=>{
      await gitMode('gitPanel.changes')
      const change=named('group',label('gitPanel.changes'))
      const loaded=response('GET',/\/git-diff$/);void loaded.catch(()=>{})
      await press(change.getByRole('button',{name:`${label('filesPanel.viewer')} · ${filename}`,exact:true}))
      const result=await loaded
      const url=new URL(result.url())
      assert.equal(url.searchParams.get('path'),filename)
      assert.equal(url.searchParams.get('scope'),'unstaged')
      const diffBody=await result.json()
      assert.equal(diffBody.path,filename)
      assert.equal(diffBody.before,initial)
      assert.equal(diffBody.after,edited)
      await panel(right,false)
      const diff=named('region',label('gitPanel.diff'))
      await diff.getByText(initial.trim()).first().waitFor()
      await diff.getByText(edited.trim()).first().waitFor()
    })
    await step('commit',async()=>{
      await panel(right)
      const actions=named('group',label('gitPanel.actions'))
      const stageName=`${label('instanceShell.gitChanges.actions.stage')} · ${filename}`
      const staged=button(`${label('instanceShell.gitChanges.actions.unstage')} · ${filename}`)
      const moved=response('POST',/\/git-stage$/);void moved.catch(()=>{})
      await press(actions.getByRole('button',{name:stageName,exact:true}))
      await moved
      await staged.first().waitFor()
      const submit=button(label('instanceShell.gitChanges.commit.submit'))
      const box=await submit.boundingBox()
      const panelBox=await named('region',label('instanceShell.rightPanel.tabs.files')).boundingBox()
      assert(box&&panelBox&&box.x>panelBox.x,'The commit field sits left of its submit button')
      await tapEditor(label('instanceShell.gitChanges.commit.placeholder'),commit,(panelBox.x+box.x)/2,box.y+box.height/2)
      const wrote=response('POST',/\/git-commit$/);void wrote.catch(()=>{})
      await press(submit)
      await wrote
      await staged.first().waitFor({state:'hidden'})
    })
    await step('search-history',async()=>{
      await gitMode('filesPanel.commits')
      const latest=mirror().getByRole('button',{name:new RegExp(commit)})
      const older=mirror().getByRole('button',{name:/Journey start/})
      await older.waitFor()
      const row=await latest.boundingBox()
      const mode=await named('radio',label('filesPanel.commits')).boundingBox()
      assert(row&&mode,'The loaded-commits filter sits just above the first row')
      await tapEditor(label('gitPanel.filter'),commit,row.x+row.width/2,row.y-mode.height*0.8)
      await latest.waitFor()
      await older.waitFor({state:'hidden'})
    })
    await step('reopen-session',async()=>{
      await panel(right,false)
      const back=button(label('gitPanel.backChat'))
      if(await back.count())await press(back)
      // A browser reload closes the renderer and retains this tab's sessionStorage for restoration.
      await page.reload({waitUntil:'domcontentloaded',timeout:60000})
      await button(label('folderSelection.servers.dialog.connect')).waitFor()
      const restored=page.waitForResponse(r=>r.ok()&&r.url().endsWith('/session-history/window')&&r.request().postDataJSON()?.sessionID===id)
      void restored.catch(()=>{})
      await press(button(label('folderSelection.servers.dialog.connect')))
      await restored
      await named('heading',title).waitFor()
      await text(reply).waitFor()
    })
  }finally{
    try{await rustFetch?.close()}finally{
      try{report.chromiumClosedGracefully=await owned.close()}
      catch(error){report.stage='browser-cleanup';throw error}
    }
  }
}
