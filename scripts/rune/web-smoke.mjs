// Attach only to an explicitly supplied isolated loopback server. Never starts a server.
import assert from 'node:assert/strict'
import {mkdir, readFile, realpath, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {assertRenderedTextContrast} from './text-contrast.mjs'
import {privateWebFixture,bundleAssetPaths,workspacePolicy,fulfillWorkspaceCreation} from './web-workspace-policy.mjs'
import {mobileClientHints, mobileContext, mobileInteraction} from './web-mobile.mjs'
import {mobileLive, revokedLauncher} from './web-live.mjs'
import {focusRing, longPaste} from './web-paste.mjs'
import {missionsFixture} from './web-missions.mjs'
import {historySearch} from './web-history-search.mjs'
import {markerFilters} from './web-marker-filters.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const {values} = parseArgs({options: {url: {type: 'string'}, out: {type: 'string', default: 'target/rune-web-smoke'},
  executable: {type: 'string'}, locale: {type: 'string', default: 'fr'}, 'storage-state': {type: 'string'}, connected:{type:'boolean'}, workspace:{type:'string'},project:{type:'string'},mobile:{type:'boolean'},timeline:{type:'boolean'},'touch-history':{type:'boolean'},'history-search':{type:'boolean'},'same-origin-pairing':{type:'boolean'},missions:{type:'boolean'},'paste-only':{type:'boolean'}}})
const url = new URL(values.url)
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use an isolated loopback server URL')
assert(!url.username && !url.password && ['http:', 'https:'].includes(url.protocol), 'Server URL must omit credentials')
if(values.connected){assert(values.workspace&&values.project&&values['storage-state']);url.searchParams.delete('scene')}
else url.searchParams.set('scene', values['paste-only'] ? 'synthetic-paste' : 'synthetic')
if(values.mobile)assert(values.connected && url.protocol==='https:')
if(values['paste-only'])assert(!values.connected)
if(values.missions)assert(values.connected&&!values.mobile&&url.protocol==='http:')
url.searchParams.set('locale', values.locale)
const catalogueIndex = JSON.parse(await readFile(path.join(root, 'crates/rune-theme-codenomad/assets/catalogues.json'), 'utf8'))
assert(catalogueIndex.locales.includes(values.locale), 'Select a supported locale from the generated catalogue')
const messages = JSON.parse(await readFile(path.join(root, `crates/rune-theme-codenomad/assets/catalogues/${values.locale}.json`), 'utf8'))
const out = path.resolve(root, values.out)
const relativeOut = path.relative(path.join(root, 'target'), out)
assert(relativeOut && relativeOut !== '..' && !relativeOut.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeOut), 'Smoke output must stay inside this checkout target directory')
let privateScope
if(values.connected){
  privateScope=await privateWebFixture({root,project:values.project,storageState:values['storage-state'],out,origin:url.origin})
}
await mkdir(out, {recursive: true})
if(privateScope)assert(privateScope.inside(privateScope.profile,await realpath(out)),'Output link escapes fixture')
const browser = await chromium.launch({headless: true, ...(values.executable ? {executablePath: values.executable} : {}),
  args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader']})
const records = []
const imagePage = await browser.newPage()
const palette = JSON.parse(await readFile(path.join(root, 'crates/rune-theme-codenomad/assets/theme.json'), 'utf8'))
// The authenticated fixture returns an empty UI state, selecting the product's default palettes.
const connectedPalettes = values.connected
  ? JSON.parse(await readFile(path.join(root, 'crates/rune-theme-codenomad/assets/palettes.json'), 'utf8'))
  : null
  const assets=await bundleAssetPaths(path.resolve(root,process.env.RUNE_WEB_DIR??(values.connected?'target/rune-web-connected':'target/rune-web')))
  if(values.mobile)assets.add('/remote-pair')
try {
  const android=mobileContext(browser)
  const sizes=values.missions?[['desktop',1200,900,false]]:values['touch-history']?[['phone',390,844,true]]:values.mobile?[['phone',android.viewport.width,android.viewport.height,true],['phone-dpr1-control',390,844,true]]:
    [['desktop',values.timeline||values['history-search']?1400:960,760,false],['tablet',768,1024,true],['phone',390,844,true]]
  for (const [name, width, height, touch] of sizes) {
    const control=name==='phone-dpr1-control'
    for (const colorScheme of control?['light']:['light','dark']) {
      const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch, colorScheme,
        ...(values.mobile?{...android,ignoreHTTPSErrors:true,...(control?{deviceScaleFactor:1}:{})}:{}),
        ...(values['storage-state'] ? {storageState: values['storage-state']} : {})})
      const page = await context.newPage()
      page.setDefaultTimeout(15000)
      const missions=values.missions?missionsFixture({page,messages,artifact:path.join(out,`missions-${colorScheme}`),project:values.project}):null
      if(missions)await context.addInitScript(()=>Object.defineProperty(Crypto.prototype,'subtle',{value:undefined}))
      const errors = [], forbiddenRequests = [], routes=[], history=[]
      let holdOlder
      let holdAnchor
      let measured
      const policy=workspacePolicy({origin:url.origin,project:values.project,assets,missions:!!missions,markerFilters:values.timeline})
      let eventSource=0
      let releaseLinked
      const beforeLinked=values.mobile?new Promise(resolve=>{releaseLinked=resolve}):null
      let markLinked
      const linkedRequested=values.mobile?new Promise(resolve=>{markLinked=resolve}):null
      const failLinkedPage=values.mobile&&!control&&colorScheme==='light'
      const linkedReads=[]
      let linkedContinuationRecovered
      let linkedAcrossSwitch
      page.on('response',async response=>{
        if(!values.connected)return
        const request=response.request(),pathname=new URL(response.url()).pathname
        if(pathname==='/api/events'&&response.status()===200&&request.resourceType()==='eventsource')eventSource++
        if(pathname.endsWith('/session-history/window')&&response.ok())history.push({input:request.postDataJSON(),body:await response.json().catch(()=>null)})
      })
      page.on('pageerror', error => errors.push({name: error.name, message: error.message}))
      if(values['history-search'])page.on('console', message=>{
        if(message.type()==='error'&&/panic|token|panicked/i.test(message.text()))errors.push({name:'Rune',message:message.text()})
      })
      // Connected scenes admit only their private creations; synthetic scenes refuse all API access.
      await context.route('**/*', async route => {
        const requested = new URL(route.request().url())
        const req=route.request(),p=requested.pathname
        const protectedRoute=/^\/(api|workspaces)(?:\/|$)/.test(p)
        if (!await policy.request(req,{allowApi:values.connected===true})) {
          forbiddenRequests.push({origin: requested.origin, path: requested.pathname})
          return route.abort('blockedbyclient')
        }
        if(protectedRoute){
          assert(routes.length<4000,'Protected browser request bound')
          const entry={method:req.method(),path:p,query:requested.search,cookie:true};routes.push(entry)
          if(req.method()==='POST'&&p==='/api/workspaces'){
            try{Object.assign(entry,await fulfillWorkspaceCreation(route,policy));return}
            catch{errors.push({name:'WorkspaceAdmission',message:'Private workspace response was refused before delivery'});return route.abort('blockedbyclient')}
          }
          if(missions&&await missions.route(route,p))return
        }
        if(values.mobile&&req.method()==='GET'&&p.endsWith('/worktrees')){
          markLinked()
          await beforeLinked
        }
        if(p.endsWith('/session-history/window')){
          const kind=req.postDataJSON()?.target?.kind
          if(holdOlder&&kind==='before'){
            const release=holdOlder;holdOlder=undefined
            await release
            return route.continue().catch(()=>{})
          }
          if(holdAnchor&&kind==='around'){
            const held=holdAnchor;holdAnchor=undefined
            await held.release.promise
            return route.continue().catch(()=>{})
          }
        }
        if(values.mobile&&req.method()==='GET'&&p.endsWith('/instance/api/session')&&
          requested.searchParams.get('directory')===path.join(path.dirname(values.project),'linked')){
          const cursor=requested.searchParams.get('cursor')
          linkedReads.push(cursor)
          if(failLinkedPage&&cursor&&linkedReads.length===2)return route.fulfill({status:503})
        }
        await route.continue()
      })
      const started = performance.now()
      try {
        let network
         if(values.mobile){
          const cdp=await mobileClientHints(page,browser)
          if(colorScheme==='dark'){
            network=cdp
            await cdp.send('Network.emulateNetworkConditions',{
              offline:false,latency:80,downloadThroughput:2_500_000,uploadThroughput:625_000,connectionType:'cellular4g',
            })
          }
        }
        await page.goto(url.href, {waitUntil: 'domcontentloaded', timeout: 60_000})
        await page.waitForFunction(() => ['ready', 'failed'].includes(globalThis.__codenomadRuneBoot?.state), undefined, {timeout: 60_000})
        assert.equal(await page.evaluate(() => globalThis.__codenomadRuneBoot.state), 'ready', 'Shared WASM app must initialize')
        await page.waitForFunction(() => document.querySelector('[data-rune-a11y] button'), undefined, {timeout: 30_000})
        const firstAccessibleMs = performance.now() - started
        if(network)await network.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1})
        assert.equal(await page.locator('html').getAttribute('lang'), values.locale)
        assert.equal(await page.locator('html').getAttribute('dir'), values.locale === 'he' ? 'rtl' : 'ltr')
        if(values.connected){
          const press=async (label,role='button')=>{
            const button=page.getByRole(role,{name:label,exact:true});await button.waitFor({state:'attached'})
            await button.scrollIntoViewIfNeeded()
            const box=await button.boundingBox()
            assert(box&&box.width>0&&box.height>0&&box.x>=-1&&box.y>=-1&&box.x+box.width<=width+1&&box.y+box.height<=height+1,`Connected control outside viewport: ${label}`)
            if(values.mobile)await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2)
            else await button.click({force:true})
          }
          const left=messages['window.menu.leftPanel']
          const sessions=page.getByRole('region',{name:left,exact:true})
          const openSessions=async()=>{
            const toggle=page.getByRole('button',{name:left,exact:true})
            await toggle.waitFor()
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
            if(await toggle.getAttribute('aria-expanded')!=='true')await press(left)
            await sessions.waitFor()
          }
          const row=name=>sessions.getByRole('listitem',{name,exact:true})
          const select=async(name,id)=>{
            await openSessions()
            const window=page.waitForResponse(res=>res.url().endsWith('/session-history/window')&&res.ok()&&res.request().postDataJSON()?.sessionID===id)
            await press(name,'listitem')
            assert.equal((await (await window).json()).status,'window')
            await page.getByRole('heading',{name,exact:true}).waitFor()
          }
          const reading=async()=>await page.waitForFunction(()=>document.querySelector('[data-rune-a11y]')?.textContent.includes('Existing project history')&&document.querySelector('[data-rune-a11y]')?.textContent.includes('Existing answer'),undefined,{timeout:30000})
          await press(messages['folderSelection.servers.dialog.connect'])
          await press(values.project)
          await openSessions()
          if(values.mobile){
            await row('Existing history').waitFor()
            if(colorScheme==='dark'){
              await linkedRequested
              await press(messages['instanceTabs.new.ariaLabel'])
              const blank=page.getByRole('tab',{name:messages['instanceTabs.new.ariaLabel'],exact:true})
              await page.waitForFunction(tab=>[...document.querySelectorAll('[role=tab][aria-selected=true]')].some(el=>el.textContent===tab),messages['instanceTabs.new.ariaLabel'])
              assert.equal(await blank.getAttribute('aria-selected'),'true')
              const continuation=page.waitForResponse(response=>{
                const requested=new URL(response.url())
                return requested.pathname.endsWith('/instance/api/session')&&requested.searchParams.has('cursor')&&
                  requested.searchParams.get('directory')===path.join(path.dirname(values.project),'linked')&&response.ok()
              })
              void continuation.catch(()=>{})
              releaseLinked()
              await continuation
              await press(values.project,'tab')
              await openSessions()
              linkedAcrossSwitch=true
            }else releaseLinked()
            await row('Linked checkout session').waitFor()
            if(failLinkedPage){
              await sessions.getByText(messages['rune.list_error'],{exact:true}).waitFor()
              assert.equal(await row('Linked checkout next page').count(),0,'The acquired first page remains visible after the failed continuation')
              await press(messages['rune.refresh'])
            }
            await row('Linked checkout next page').waitFor()
            if(failLinkedPage){
              assert(linkedReads[1])
              assert.deepEqual(linkedReads,[null,linkedReads[1],linkedReads[1]],'Refresh resumes the precise linked cursor')
              linkedContinuationRecovered=true
            }
            assert.equal(await row('Another session').count(),0)
            await press(messages['sessionList.filter.ariaLabel'])
            await page.locator('textarea:focus').fill('Another session')
            await row('Another session').waitFor()
            assert(routes.some(row=>row.query.includes('search=Another+session')),'Use the native search before loading the next ordinary page')
            await press(messages['sessionList.filter.ariaLabel'])
            await row('Existing history').waitFor()
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
          }
           if(!values['history-search']){
           await press(messages['rune.more'])
          if(values.mobile){
            await row('Another session').waitFor()
            await select('Linked checkout next page','ses_linked_next')
            await page.getByText('Linked checkout answer',{exact:true}).waitFor()
          }
           await select('Another session','ses_another')
           await page.waitForFunction(()=>document.querySelector('[data-rune-a11y]')?.textContent.includes('Another session')&&!document.querySelector('[data-rune-a11y]')?.textContent.includes('Existing project history'))
           }
          await select('Existing history','ses_existing');await reading()
          if(values['touch-history']){
            const cdp=await context.newCDPSession(page)
            const release=Promise.withResolvers()
            const path=res=>res.url().endsWith('/session-history/window')&&res.postDataJSON()?.target?.kind==='before'
            const requestedBody=history.findLast(r=>r.input.sessionID==='ses_existing'&&r.input.target.kind==='latest').body
            const requested=page.waitForRequest(path)
            const received=page.waitForResponse(res=>res.ok()&&path(res.request()))
            void requested.catch(()=>{})
            void received.catch(()=>{})
            const loading=page.locator('[data-rune-a11y]').getByText(messages['history.navigation.loading'],{exact:true}).first()
            holdOlder=release.promise
            const touchAt=(type,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:y?[{x:180,y}]:[]})
            try{
              await touchAt('touchStart',132)
              for(let y=156;y<=588;y+=24){
                await touchAt('touchMove',y)
                await page.evaluate(()=>new Promise(requestAnimationFrame))
              }
              assert.deepEqual((await requested).postDataJSON().target,requestedBody.older)
              await loading.waitFor()
              await touchAt('touchEnd')
              // Let the real renderer settle touch momentum before releasing the held HTTP read.
              await page.waitForTimeout(800)
              await loading.waitFor()
            }finally{
              await touchAt('touchEnd').catch(()=>{})
              release.resolve()
            }
            assert.equal((await (await received).json()).status,'window')
            await loading.waitFor({state:'detached'})
            assert.equal(history.filter(item=>item.input.target.kind==='before').length,1)
            await press(messages['rune.latest'])
            await reading()
          }
          if(values.timeline&&name==='desktop'){
            const rail=page.getByRole('navigation',{name:messages['messageTimeline.ariaLabel']})
            const box=await rail.boundingBox()
            assert(box,'The conversation must mount the timeline')
            const outline=page.waitForResponse(res=>res.url().endsWith('/session-history/outline')&&res.ok())
            const tool=rail.getByRole('button',{name:'read',exact:true})
            await page.mouse.move(box.x+10,box.y+10)
            await page.mouse.wheel(0,-100000)
            // The index can arrive before or after the normal latest-window response.
            await Promise.race([outline,tool.waitFor({state:'attached'})])
            await page.mouse.wheel(0,-100000)
            await tool.waitFor()
            const toolBox=await tool.boundingBox()
            assert(toolBox)
            const pages=()=>routes.filter(route=>route.path.endsWith('/session-history/window')).length
            const noPage=pages()
            const tip=page.locator('[data-rune-a11y] p').and(page.getByText('Indexed tool excerpt message-00000',{exact:true}))
            await page.mouse.move(box.x-420,box.y+190)
            const cdp=await context.newCDPSession(page)
            const touchPoint={x:toolBox.x+toolBox.width/2,y:toolBox.y+toolBox.height/2}
            await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touchPoint]})
            try{
              await page.waitForTimeout(280)
              assert.equal(await tip.count(),0,'Holding a touch must not open a preview')
            }finally{
              await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]})
              await cdp.detach()
            }
            await page.mouse.move(touchPoint.x,touchPoint.y)
            await tip.waitFor()
            const described=tool.and(rail.locator('[aria-description$="Final token"]'))
            await described.waitFor()
            assert.equal(await described.getAttribute('aria-description'),
              'Indexed tool excerpt message-00000 '+'Additional visible text. '.repeat(25)+'Final token')
            assert.equal(pages(),noPage,'Preview must not page the transcript')
            const tipBox=await tip.boundingBox()
            assert(tipBox&&tipBox.x>=0&&tipBox.y>=0&&tipBox.x+tipBox.width<=width+1&&tipBox.y+tipBox.height<=height+1)
            await page.mouse.move(tipBox.x+tipBox.width/2,tipBox.y+tipBox.height/2)
            await page.waitForTimeout(200) // More than the close grace period after leaving the marker.
            await tip.waitFor()
            await page.keyboard.press('Escape')
            await tip.waitFor({state:'detached'})
            await page.mouse.move(box.x-420,box.y+190)
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
            const revisited=await tool.boundingBox()
            assert(revisited)
            await page.mouse.move(revisited.x+revisited.width/2,revisited.y+revisited.height/2,{steps:8})
            await tip.waitFor()
            await page.mouse.wheel(0,96)
            await tip.waitFor({state:'detached'})
            await page.mouse.wheel(0,-100000)
            await tool.waitFor()
            await page.mouse.move(box.x-40,box.y+25)
            const run=tool.locator('xpath=following-sibling::button[1]')
            await run.waitFor()
            const before=history.filter(r=>r.input.target.kind==='around').length
            const result=page.waitForResponse(res=>res.url().endsWith('/session-history/window')&&res.ok()
              &&res.request().postDataJSON()?.target?.kind==='around')
            await run.click({force:true})
            assert.equal((await result).request().postDataJSON().target.messageID,'message-00000')
            const exact=page.getByRole('paragraph').filter({hasText:'Exact position in the old message'})
            await exact.waitFor()
            assert(Math.abs((await exact.boundingBox()).y-box.y)<8,'The text block, not its message header, must land at the reading line')
            assert.equal(history.filter(r=>r.input.target.kind==='around').length,before+1)
            const reasoning=run.locator('xpath=following-sibling::button[1]')
            await reasoning.and(rail.getByRole('button',{name:'**Second fixture reasoning**',exact:true})).waitFor()
            const reasoningBox=await reasoning.boundingBox()
            assert(reasoningBox)
            await page.mouse.click(reasoningBox.x+reasoningBox.width/2,reasoningBox.y+reasoningBox.height/2)
            const group=page.getByText('Second fixture reasoning',{exact:true})
            await group.waitFor()
            assert(Math.abs((await group.boundingBox()).y-box.y)<16,'The second reasoning run must land on its own group')
            await reasoning.and(rail.locator(`[aria-description^="${messages['messageTimeline.current']}"]`)).waitFor()
            assert.equal(history.filter(r=>r.input.target.kind==='around').length,before+1,'A resident jump uses no window')
            await page.mouse.move(box.x-40,box.y+25)
            await reasoning.and(rail.locator(`[aria-description="${messages['messageTimeline.current']}"]`)).waitFor()
            await page.keyboard.press('Shift+Tab')
            // The mirror buttons are not DOM tab stops; Rune keeps focus on its canvas.
            await page.waitForFunction(label=>{
              const id=document.querySelector('canvas[aria-activedescendant]')?.getAttribute('aria-activedescendant')
              return document.getElementById(id)?.getAttribute('aria-label')===label
            },await run.textContent())
            const focusedPreview=run.and(rail.locator('[aria-description*="Exact position in the old message"]'))
            await focusedPreview.waitFor()
            await page.setViewportSize({width:width-40,height})
            await focusedPreview.waitFor({state:'detached'})
            await page.setViewportSize({width,height})
            assert.equal(history.filter(r=>r.input.target.kind==='around').length,before+1,'Keyboard preview and resize stay local')
            for(const passage of ['Native compacted passage','Native conversation context']){
              await rail.getByRole('button',{name:passage,exact:true}).click({force:true})
              const content=page.getByRole('paragraph').filter({hasText:passage})
              await content.waitFor()
              assert(Math.abs((await content.boundingBox()).y-box.y)<65,'Native context must land at its dedicated block')
            }
            await press(messages['rune.latest'])
            await reading()
            const older=page.getByRole('button',{name:messages['rune.older'],exact:true})
            const resident=rail.getByRole('button',{name:'Existing answer',exact:true})
            await page.mouse.move(box.x+10,box.y+10)
            await page.mouse.wheel(0,100000)
            await resident.waitFor()
            const release=Promise.withResolvers()
            holdOlder=release.promise
            try{
              const started=page.waitForRequest(req=>req.url().endsWith('/session-history/window')&&req.postDataJSON()?.target?.kind==='before')
              await older.click({force:true})
              await started
              await resident.click({force:true})
              await resident.and(rail.locator(`[aria-description^="${messages['messageTimeline.current']}"]`)).waitFor()
            }finally{release.resolve()}
            await reading()
            const visible=history.findLast(r=>r.input.target.kind==='latest')
            assert(visible?.body?.older?.messageID,'Latest window must expose an older cursor')
            await page.mouse.wheel(0,-100000)
            await run.waitFor()
            const held={release:Promise.withResolvers()}
            holdAnchor=held
            try{
              const anchor=page.waitForRequest(req=>req.url().endsWith('/session-history/window')&&req.postDataJSON()?.target?.kind==='around')
              await run.click({force:true})
              await anchor
              const started=page.waitForRequest(req=>req.url().endsWith('/session-history/window')&&req.postDataJSON()?.target?.kind==='before')
              const olderWindow=page.waitForResponse(res=>res.url().endsWith('/session-history/window')&&res.ok()
                &&res.request().postDataJSON()?.target?.kind==='before')
              await older.click({force:true})
              assert.deepEqual((await started).postDataJSON().target,visible.body.older)
              await olderWindow
            }finally{held.release.resolve();holdAnchor=undefined}
            await press(messages['rune.latest'])
            await reading()
            const readEdge=kind=>page.waitForResponse(res=>res.ok()&&res.url().endsWith('/session-history/window')
              &&res.request().postDataJSON()?.target?.kind===kind)
            const oldestRead=readEdge('oldest')
            await press(messages['messageSection.scroll.toFirstAriaLabel'])
            const firstWindow=await (await oldestRead).json()
            assert.equal(firstWindow.older,null)
            assert.equal(firstWindow.messages[0].id,'message-00000')
            await page.getByRole('paragraph').filter({hasText:'Lead before the anchor'}).waitFor()
            const firstBlock=await page.getByRole('paragraph').filter({hasText:'Lead before the anchor'}).boundingBox()
            assert(firstBlock)
            await page.mouse.move(firstBlock.x+10,firstBlock.y+10)
            const forward=readEdge('after')
            await page.mouse.wheel(0,100000)
            await page.getByRole('paragraph').filter({hasText:'Fixture passage 196'}).waitFor()
            await page.mouse.wheel(0,150)
            const forwardResponse=await forward
            assert.deepEqual(forwardResponse.request().postDataJSON().target,firstWindow.newer)
            const forwardWindow=await forwardResponse.json()
            await page.getByRole('paragraph').filter({hasText:'Fixture passage 196'}).waitFor()
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
            const backward=readEdge('before')
            await page.mouse.wheel(0,-100000)
            await page.mouse.wheel(0,-150)
            assert.deepEqual((await backward).request().postDataJSON().target,forwardWindow.older)
            await page.getByRole('paragraph').filter({hasText:'Fixture passage 181'}).waitFor()
            await press(messages['rune.latest'])
            await reading()
            await markerFilters(page,messages,url,values.project,{touch:false,pages})
            // The text mirror updates before the newly mounted glyphs finish fading in.
            await page.waitForTimeout(250)
          }
          if(values.timeline&&name==='tablet'){
            const pages=()=>routes.filter(route=>route.path.endsWith('/session-history/window')).length
            await markerFilters(page,messages,url,values.project,{touch:true,pages})
          }
          if(missions)await missions.check(press)
         }else{
        // The DOM editing proxy is ready before the browser presents the GPU handover.
        // Start the synthetic interactions on the canvas that will be sampled.
        const renderer = await page.waitForFunction(() => ['web.handover.done', 'web.gpu.failed', 'web.handover.failed']
          .find(name => performance.getEntriesByName(name).length))
        const rendererMark = await renderer.jsonValue()
        await renderer.dispose()
        // Enter from the field boundary: the transcript has its own variable number of Tab stops.
        const group = await page.getByRole('group', {name: messages['rune.prompt'], exact: true}).boundingBox()
        const action = await page.getByRole('button', {name: messages['promptInput.overlay.send'], exact: true}).boundingBox()
        assert(group && action && action.y > group.y, 'Composer field must have a visible area above its actions')
        const x = group.x + group.width / 2, y = (group.y + action.y) / 2
        if (touch) await page.touchscreen.tap(x, y)
        else await page.mouse.click(x, y)
        await page.locator('textarea:focus').waitFor({state: 'attached'})
        const captureFocus = async state => {
          // The editing proxy can receive DOM focus before the canvas presents that frame.
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          return page.screenshot({path:path.join(out, `${name}-${colorScheme}-${state}.png`),scale:'css'})
        }
        const focused = values['paste-only'] ? await captureFocus('focus') : null
        await page.keyboard.press('Tab')
        await page.waitForFunction(() => document.activeElement?.tagName !== 'TEXTAREA')
        const unfocused = values['paste-only'] ? await captureFocus('blur') : null
        await page.keyboard.press('Shift+Tab')
        await page.locator('textarea:focus').waitFor({state: 'attached'})
        const text = 'Rune web\nDeuxième ligne 🦀'
        await page.locator('textarea:focus').fill(text)
         await page.waitForFunction(expected => document.activeElement?.value === expected, text)
         assert.equal(await page.locator('textarea:focus').getAttribute('aria-label'), messages['rune.prompt'])
         if(values['paste-only']) {
           const {['space-md']: inset} = palette.numbers[colorScheme]
           const ring = await focusRing(imagePage, [unfocused, focused], group, inset, palette[colorScheme]['focus-ring-color'])
           const paste = await longPaste(page, messages)
           assert.deepEqual(forbiddenRequests, [])
           assert.deepEqual(errors, [])
           records.push({name, colorScheme, width, height, emulatedTouch: touch, renderer: rendererMark, longPaste: paste, focusRing: ring, pass: true})
           continue
         }
        }
        const canvas = await page.locator('canvas').first().boundingBox()
        assert(canvas && canvas.width > 0 && canvas.height > 0, 'Rune must draw an actual canvas')
        assert(canvas.width <= width + 1 && canvas.height <= height + 1, 'Canvas must follow the supplied viewport')
        const snapshot = await page.locator('body').ariaSnapshot()
        assert(snapshot.includes(messages['rune.latest']), 'Latest control must appear in the real accessibility mirror')
        await writeFile(path.join(out, `${name}-${colorScheme}.aria.yml`), snapshot)
        if(!values.connected)await page.waitForLoadState('networkidle', {timeout: 30_000})
        const png = await page.screenshot({path: path.join(out, `${name}-${colorScheme}.png`),scale:'css'})
        const textRegions = await page.evaluate(title => {
          const nodes = [...document.querySelectorAll('[data-rune-a11y] p, [data-rune-a11y] h1, [data-rune-a11y] h2, [data-rune-a11y] [role=heading]')]
          const crop = (name, predicate, surface='surface-canvas', text='text-primary') => {
            const node = nodes.find(node => predicate(node.textContent ?? ''))
            if (!node) throw Error(`Missing drawn accessibility text region: ${name}`)
            const box = node.getBoundingClientRect()
            return {name, rect: [box.x, box.y, box.width, box.height], surface, text}
          }
          return [...(title.connected?[crop('header', text => text==='Existing history','surface-shade-light','text-muted')]:[]),
            crop('transcript', text => text.includes(title.connected?'Existing answer':'Synthetic message 9998'))]
        }, {connected:values.connected})
        const composerBox = await page.getByRole('group', {name: messages['rune.prompt'], exact: true}).boundingBox()
        const sendBox = await page.getByRole('button', {name: messages['promptInput.overlay.send'], exact: true}).boundingBox()
        assert(composerBox && sendBox, 'Composer group and action expose their drawn bounds')
        const {['space-md']: md, ['space-sm']: sm} = palette.numbers[colorScheme]
        if(!values.connected)textRegions.push({name: 'composer', surface: 'surface-field', inset: sm,
          rect: [composerBox.x + md, composerBox.y + md, composerBox.width - md * 2, sendBox.y - sm - composerBox.y - md]})
         const colors = connectedPalettes
           ? connectedPalettes.find(p => p.id === (colorScheme === 'dark' ? 'mist' : 'porcelain'))?.colors
           : palette[colorScheme]
         assert(colors, `Missing contrast palette for ${colorScheme}`)
         const textContrast = await assertRenderedTextContrast(imagePage, png, textRegions, colors)
        measured = await page.evaluate(() => ({boot: globalThis.__codenomadRuneBoot,
          viewport: {width: innerWidth, height: innerHeight, touch: matchMedia('(pointer:coarse)').matches,
            dpr:devicePixelRatio,platform:navigator.userAgentData?.platform,mobile:navigator.userAgentData?.mobile},
          canvases: [...document.querySelectorAll('canvas')].map(canvas => ({width: canvas.width, height: canvas.height})),
          resources: performance.getEntriesByType('resource').filter(entry => /\.(wasm|ttf|js)(?:$|\?)/.test(entry.name))
            .map(entry => ({path: new URL(entry.name).pathname, durationMs: entry.duration, transferBytes: entry.transferSize, encodedBodyBytes: entry.encodedBodySize})),
        }))
        if(values.mobile)measured.android=await mobileInteraction(page,{
          prompt:messages['rune.prompt'], send:messages['promptInput.overlay.send'],
          latest:messages['rune.latest'],
        },imagePage,palette.numbers[colorScheme],colors)
        if(values.mobile){
          measured.linkedContinuationRecovered=linkedContinuationRecovered
          measured.linkedAcrossSwitch=linkedAcrossSwitch
          measured.network=colorScheme==='dark'?{rttMs:80,downloadBytesPerSecond:2_500_000,uploadBytesPerSecond:625_000}:'loopback'
          assert.deepEqual(measured.viewport,{width,height,touch:true,dpr:control?1:android.deviceScaleFactor,platform:'Android',mobile:true})
          const {width:backingWidth,height:backingHeight}=measured.canvases[0]
          assert(Math.abs(backingWidth-width*measured.viewport.dpr)<=1 && Math.abs(backingHeight-height*measured.viewport.dpr)<=1)
          assert.equal(measured.android.touchScroll.moved,true,'Physical touch dispatch must move the portrait transcript')
          measured.live=await mobileLive({page,context,url,messages,revoke:control,
            eventSources:()=>eventSource,workspaces:policy.workspaces,fromLink:!values['same-origin-pairing']})
         }
         assert.equal(forbiddenRequests.length, 0, 'Synthetic web smoke must stay offline from API and external origins')
        assert.equal(errors.length, 0, 'Web app must initialize and handle multiline input without JS exceptions')
        if(values.connected){
          assert(eventSource,'Real browser EventSource must connect')
          const existing=history.filter(row=>row.input.sessionID==='ses_existing')
          assert(existing.length>=1)
          for(const row of existing){
             if((values.mobile||values.timeline||values['touch-history'])&&(row.body.status!=='window'||!row.body.latest))continue
            const bodies=row.body.messages.map(message=>message.text??message.content?.[0]?.text)
             if(values.mobile||values.timeline||values['touch-history']||values['history-search'])assert(bodies.includes('Existing project history')&&bodies.includes('Existing answer'))
            else assert.deepEqual(bodies,['Existing project history','Existing answer'])
          }
          if(!values['history-search']){
            assert(history.some(row=>row.input.sessionID==='ses_another'&&row.body.messages.length===0))
            assert(routes.some(row=>row.query.includes('cursor=')))
          }
          if(values['history-search']&&(name==='desktop'||name==='phone'))await historySearch(page,messages,touch,()=>{
            const held={release:Promise.withResolvers()}
            holdAnchor=held
            return ()=>{held.release.resolve();holdAnchor=undefined}
          })
          const inventory=async()=>{const response=await context.request.get(new URL('/api/workspaces',url).href);assert(response.ok());const rows=await response.json();assert(Array.isArray(rows)&&rows.length<=128);return rows.map(row=>row.id)}
          const before=await inventory(),owned=[...policy.workspaces],retained=before.filter(id=>!policy.workspaces.has(id))
          assert(owned.length>0&&owned.every(id=>before.includes(id)),'Browser must own its admitted occurrences')
          // Closing a browser context skips pagehide; use the product's ordinary departure first.
          const departure=values.mobile?new URL('/remote-pair',url).href:'about:blank'
          if(values.mobile)await page.waitForFunction(()=>sessionStorage.getItem('codenomad.rune.alpha.client-state.v1'))
          await page.goto(departure)
          let after
          for(const until=Date.now()+10000;;){
            after=await inventory()
            if(owned.every(id=>!after.includes(id)))break
            if(Date.now()>=until){
              const stage=await page.evaluate(()=>sessionStorage.getItem('codenomad.rune.alpha.records-released'))
              assert.fail(`Normal browser departure must release its owned occurrences (stage: ${stage})`)
            }
            await page.waitForTimeout(25)
          }
          assert(retained.every(id=>after.includes(id)),'Departure must preserve every unowned fixture record')
          if(values.mobile)assert.equal(await page.evaluate(()=>sessionStorage.getItem('codenomad.rune.alpha.records-released')),'1')
          measured.departure={owned,retained,ownedRemoved:true,unownedPreserved:true}
          if(values.mobile&&control){
            Object.assign(measured,await revokedLauncher({context,url,messages}))
            assert.equal(forbiddenRequests.length,0,'Launcher recovery may not submit a password')
          }
        }
        records.push({name, colorScheme, width, height, emulatedTouch: touch, firstAccessibleMs, canvasBounds: canvas, textContrast, routes,history,eventSource,...measured,
          ...(values.mobile?{requiredChecksPassed:true,knownGaps:[
            ...(measured.live.older.status==='known-gap'?['older-button-disabled-state']:[]),
            ...(measured.passwordProxy?.status==='known-gap'?['password-input-bridge-proxy']:[]),
          ]}:{pass:true})})
      } catch (error) {
        await page.screenshot({path: path.join(out, `${name}-${colorScheme}-failure.png`)}).catch(() => {})
        await writeFile(path.join(out, `${name}-${colorScheme}-failure.json`), JSON.stringify({error: error.message, errors, forbiddenRequests,routes,history,measured,mirror:await page.locator('body').ariaSnapshot(),
          marks: await page.evaluate(() => performance.getEntriesByType('mark').map(({name,startTime}) => ({name,startTime})))}, null, 2))
        throw error
       } finally {missions?.release();releaseLinked?.();await context.close()}
    }
  }
} finally {
  await browser.close()
  await writeFile(path.join(out, 'smoke-report.json'), JSON.stringify({platform: process.platform, browser: 'Chromium headless',
    scene: values.connected?'connected':'synthetic', pairingMode:values.mobile?(values['same-origin-pairing']?'same-origin-control':'cross-origin-link'):undefined, records, pending: ['real phone keyboard/IME/autocorrect/dictation', 'screen reader on physical device', 'phone power and sustained performance',...(values.connected?[]:['Rust-server connected session flow'])]}, null, 2) + '\n')
}
console.log(`Rune web smoke evidence: ${out}`)
