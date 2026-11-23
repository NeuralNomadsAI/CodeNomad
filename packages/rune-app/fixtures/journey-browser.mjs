import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {chromium, request} from 'playwright'
import {mobileClientHints, mobileContext} from '../../../scripts/rune/web-mobile.mjs'
import {commit, edited, filename, initial, prompt, reply, title, until} from './journey-host.mjs'

export async function journeyBrowser(host, web, report){
  const {origin,password,profile,project}=host
  const labels=JSON.parse(await readFile(new URL('../../../crates/rune-theme-codenomad/assets/catalogues/en.json',import.meta.url),'utf8'))
  const manifest=JSON.parse(await readFile(path.join(web,'bundle-manifest.json'),'utf8'))
  assert.equal(manifest.testSupport,false,'Use a product WASM artifact')
  const http=await request.newContext({baseURL:origin,timeout:15000})
  let storageState
  try{
    assert.equal((await http.post('/api/auth/login',{data:{username:'codenomad',password}})).status(),200)
    storageState=await http.storageState()
  }finally{await http.dispose()}
  const browser=await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined,
    args:['--enable-unsafe-webgpu','--use-angle=swiftshader']})
  try{
    const context=await browser.newContext({...mobileContext(browser),storageState,serviceWorkers:'block',colorScheme:'light'})
    const refused=[], errors=[]
    await context.route('**/*',route=>{
      const url=new URL(route.request().url())
      if(url.origin===origin)return route.continue()
      refused.push(url.origin)
      return route.abort()
    })
    const page=await context.newPage()
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
      await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2)
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
        assert.deepEqual(refused,[],'No request may leave the private Rust origin')
        assert.deepEqual(errors,[])
      }catch(error){entry.error=error.message}
      const base=path.join(profile,`web-${name}`)
      const proof=await Promise.allSettled([
        mirror().ariaSnapshot({timeout:3000}).catch(()=>page.locator('body').ariaSnapshot({timeout:3000}))
          .then(snapshot=>writeFile(`${base}.aria.yml`,snapshot)),
        page.screenshot({path:`${base}.png`,scale:'css',timeout:20000}),
      ])
      const failures=proof.filter(result=>result.status==='rejected')
      if(failures.length)entry.evidenceError=failures.map(result=>result.reason.message).join('\n')
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
      await panel(right)
      await press(named('tab',label('instanceShell.rightPanel.tabs.files')))
      const loaded=page.waitForResponse(r=>{
        const url=new URL(r.url())
        return r.request().method()==='GET'&&url.pathname.endsWith('/files/preview')&&url.searchParams.get('path')===filename
      })
      void loaded.catch(()=>{})
      await press(preview())
      await panel(right,false)
      const reader=named('region',label('filesPanel.viewer'))
      await reader.getByText(filename,{exact:true}).waitFor()
      await reader.getByRole('button',{name:label('instanceShell.rightPanel.actions.save'),exact:true}).waitFor()
      const result=await loaded
      assert.equal(result.status(),200)
      const file=await result.json()
      assert.equal(file.relativePath,filename)
      assert.equal(Buffer.from(file.contents,'base64').toString('utf8'),edited)
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
      await loaded
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
  }finally{await browser.close()}
}
