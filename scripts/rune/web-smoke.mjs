// Attach only to an explicitly supplied isolated loopback server. Never starts a server.
import assert from 'node:assert/strict'
import {mkdir, readFile, realpath, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {assertRenderedTextContrast} from './text-contrast.mjs'
import {privateWebFixture,bundleAssetPaths,workspacePolicy,fulfillWorkspaceCreation} from './web-workspace-policy.mjs'
import {mobileClientHints, mobileContext, mobileInteraction, mobileViewport} from './web-mobile.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const {values} = parseArgs({options: {url: {type: 'string'}, out: {type: 'string', default: 'target/rune-web-smoke'},
  executable: {type: 'string'}, locale: {type: 'string', default: 'fr'}, 'storage-state': {type: 'string'}, connected:{type:'boolean'}, workspace:{type:'string'},project:{type:'string'},mobile:{type:'boolean'}}})
const url = new URL(values.url)
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use an isolated loopback server URL')
assert(!url.username && !url.password && ['http:', 'https:'].includes(url.protocol), 'Server URL must omit credentials')
if(values.connected){assert(values.workspace&&values.project&&values['storage-state']);url.searchParams.delete('scene')}
else url.searchParams.set('scene', 'synthetic')
if(values.mobile)assert(values.connected && url.protocol==='https:')
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
  const assets=await bundleAssetPaths(path.resolve(root,process.env.RUNE_WEB_DIR??(values.connected?'target/rune-web-connected':'target/rune-web')))
  if(values.mobile)assets.add('/remote-pair')
try {
  const android=mobileContext(browser)
  const sizes=values.mobile?[['phone',android.viewport.width,android.viewport.height,true],['phone-dpr1-control',390,844,true]]:
    [['desktop',960,760,false],['tablet',768,1024,true],['phone',390,844,true]]
  for (const [name, width, height, touch] of sizes) {
    const control=name==='phone-dpr1-control'
    for (const colorScheme of control?['light']:['light','dark']) {
      const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch, colorScheme,
        ...(values.mobile?{...android,ignoreHTTPSErrors:true,...(control?{deviceScaleFactor:1}:{})}:{}),
        ...(values['storage-state'] ? {storageState: values['storage-state']} : {})})
      const page = await context.newPage()
      page.setDefaultTimeout(15000)
      if(values.mobile){
        await page.addInitScript(mobileViewport)
      }
      const errors = [], forbiddenRequests = [], routes=[], history=[]
      let measured
      const policy=workspacePolicy({origin:url.origin,project:values.project,assets})
      let eventSource=false
      page.on('response',async response=>{
        if(!values.connected)return
        const request=response.request(),pathname=new URL(response.url()).pathname
        if(pathname==='/api/events'&&response.status()===200&&request.resourceType()==='eventsource')eventSource=true
        if(pathname.endsWith('/session-history/window')&&response.ok())history.push({input:request.postDataJSON(),body:await response.json().catch(()=>null)})
      })
      page.on('pageerror', error => errors.push({name: error.name, message: error.message}))
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
        }
        await route.continue()
      })
      const started = performance.now()
      try {
        if(values.mobile){
          const cdp=await mobileClientHints(page,browser)
          if(colorScheme==='dark')await cdp.send('Network.emulateNetworkConditions',{
            offline:false,latency:80,downloadThroughput:2_500_000,uploadThroughput:625_000,connectionType:'cellular4g',
          })
        }
        await page.goto(url.href, {waitUntil: 'domcontentloaded', timeout: 60_000})
        await page.waitForFunction(() => ['ready', 'failed'].includes(globalThis.__codenomadRuneBoot?.state), undefined, {timeout: 60_000})
        assert.equal(await page.evaluate(() => globalThis.__codenomadRuneBoot.state), 'ready', 'Shared WASM app must initialize')
        await page.waitForFunction(() => document.querySelector('[data-rune-a11y] button'), undefined, {timeout: 30_000})
        const firstAccessibleMs = performance.now() - started
        assert.equal(await page.locator('html').getAttribute('lang'), values.locale)
        assert.equal(await page.locator('html').getAttribute('dir'), values.locale === 'he' ? 'rtl' : 'ltr')
        if(values.connected){
          const press=async label=>{
            const button=page.getByRole('button',{name:label,exact:true});await button.waitFor({state:'attached'})
            await page.waitForFunction(label=>[...document.querySelectorAll('[data-rune-a11y] button')].some(e=>e.textContent===label&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'),label)
            const box=await button.boundingBox()
            assert(box&&box.width>0&&box.height>0&&box.x>=-1&&box.y>=-1&&box.x+box.width<=width+1&&box.y+box.height<=height+1,`Connected control outside viewport: ${label}`)
            if(values.mobile)await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2)
            else await button.click({force:true})
          }
          const ready=async()=>{await page.getByText(messages['rune.ready'],{exact:true}).waitFor();await page.waitForTimeout(200)}
          const reading=async()=>{await page.waitForFunction(()=>document.querySelector('[data-rune-a11y]')?.textContent.includes('Existing project history')&&document.querySelector('[data-rune-a11y]')?.textContent.includes('Existing answer'),undefined,{timeout:30000});await ready()}
          await press(messages['folderSelection.servers.dialog.connect'])
          await press(values.project)
          await press('Existing history');await reading()
          await press(messages['sessionList.header.title'])
          await press(messages['rune.more'])
          await press('Another session')
          await page.waitForFunction(()=>document.querySelector('[data-rune-a11y]')?.textContent.includes('Another session')&&!document.querySelector('[data-rune-a11y]')?.textContent.includes('Existing project history'))
          await ready()
          await press(messages['sessionList.header.title'])
          await press('Existing history');await reading()
          await page.waitForFunction(label=>[...document.querySelectorAll('[data-rune-a11y] button')].some(e=>e.textContent===label&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'),messages['sessionList.header.title'])
        }else{
        // Keyboard input is scoped to this headless page and goes through Rune's DOM bridge.
        let focused = false
        for (let tab = 0; tab < 12; tab++) {
          await page.keyboard.press('Tab')
          await page.waitForTimeout(30)
          focused = await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA')
          if (focused) break
        }
        assert(focused, 'Rune composer must be reachable through keyboard focus')
        const text = 'Rune web\nDeuxième ligne 🦀'
        await page.locator('textarea:focus').fill(text)
        await page.waitForFunction(expected => document.activeElement?.value === expected, text)
        assert.equal(await page.locator('textarea:focus').getAttribute('aria-label'), messages['rune.prompt'])
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
          const nodes = [...document.querySelectorAll('[data-rune-a11y] p, [data-rune-a11y] h1, [data-rune-a11y] h2')]
          const crop = (name, predicate) => {
            const node = nodes.find(node => predicate(node.textContent ?? ''))
            if (!node) throw Error(`Missing drawn accessibility text region: ${name}`)
            const box = node.getBoundingClientRect()
            return {name, rect: [box.x, box.y, box.width, box.height], surface: 'surface-canvas'}
          }
          return [crop('header', text => text.startsWith(title.label)), crop('transcript', text => text.includes(title.connected?'Existing answer':'fn main()'))]
        }, {label:messages['window.title.main'],connected:values.connected})
        const composerBox = await page.getByRole('group', {name: messages['rune.prompt'], exact: true}).boundingBox()
        const sendBox = await page.getByRole('button', {name: messages['promptInput.overlay.send'], exact: true}).boundingBox()
        assert(composerBox && sendBox, 'Composer group and action expose their drawn bounds')
        const {['space-md']: md, ['space-sm']: sm} = palette.numbers[colorScheme]
        if(!values.connected)textRegions.push({name: 'composer', surface: 'surface-field', inset: sm,
          rect: [composerBox.x + md, composerBox.y + md, composerBox.width - md * 2, sendBox.y - sm - composerBox.y - md]})
        const textContrast = await assertRenderedTextContrast(imagePage, png, textRegions, palette[colorScheme])
        measured = await page.evaluate(() => ({boot: globalThis.__codenomadRuneBoot,
          viewport: {width: innerWidth, height: innerHeight, touch: matchMedia('(pointer:coarse)').matches,
            dpr:devicePixelRatio,platform:navigator.userAgentData?.platform,mobile:navigator.userAgentData?.mobile},
          canvases: [...document.querySelectorAll('canvas')].map(canvas => ({width: canvas.width, height: canvas.height})),
          resources: performance.getEntriesByType('resource').filter(entry => /\.(wasm|ttf|js)(?:$|\?)/.test(entry.name))
            .map(entry => ({path: new URL(entry.name).pathname, durationMs: entry.duration, transferBytes: entry.transferSize, encodedBodyBytes: entry.encodedBodySize})),
        }))
        if(values.mobile)measured.android=await mobileInteraction(page,{
          prompt:messages['rune.prompt'], send:messages['promptInput.overlay.send'],
          latest:messages['rune.latest'], older:messages['rune.older'],
        })
        if(values.mobile){
          measured.network=colorScheme==='dark'?{rttMs:80,downloadBytesPerSecond:2_500_000,uploadBytesPerSecond:625_000}:'loopback'
          assert.deepEqual(measured.viewport,{width,height,touch:true,dpr:control?1:android.deviceScaleFactor,platform:'Android',mobile:true})
          const {width:backingWidth,height:backingHeight}=measured.canvases[0]
          assert(Math.abs(backingWidth-width*measured.viewport.dpr)<=1 && Math.abs(backingHeight-height*measured.viewport.dpr)<=1)
          assert.equal(measured.android.touchScroll.moved,true,'Physical touch dispatch must move the portrait transcript')
        }
        assert.equal(forbiddenRequests.length, 0, 'Synthetic web smoke must stay offline from API and external origins')
        assert.equal(errors.length, 0, 'Web app must initialize and handle multiline input without JS exceptions')
        if(values.connected){
          assert(eventSource,'Real browser EventSource must connect')
          const existing=history.filter(row=>row.input.sessionID==='ses_existing')
          assert(existing.length>=2)
          for(const row of existing){
            const bodies=row.body.messages.map(message=>message.text??message.content?.[0]?.text)
            assert.deepEqual(values.mobile?bodies.slice(-2):bodies,['Existing project history','Existing answer'])
          }
          assert(history.some(row=>row.input.sessionID==='ses_another'&&row.body.messages.length===0))
          assert(routes.some(row=>row.query.includes('cursor=')))
          const inventory=async()=>{const response=await context.request.get(new URL('/api/workspaces',url).href);assert(response.ok());const rows=await response.json();assert(Array.isArray(rows)&&rows.length<=128);return rows.map(row=>row.id)}
          const before=await inventory(),owned=[...policy.workspaces],retained=before.filter(id=>!policy.workspaces.has(id))
          assert(owned.length>0&&owned.every(id=>before.includes(id)),'Browser must own its admitted occurrences')
          // Closing a browser context skips pagehide; use the product's ordinary departure first.
          const departure=values.mobile?new URL('/remote-pair',url).href:'about:blank'
          await page.goto(departure)
          let after
          for(const until=Date.now()+10000;;){
            after=await inventory()
            if(owned.every(id=>!after.includes(id)))break
            assert(Date.now()<until,'Normal browser departure must release its owned occurrences')
            await page.waitForTimeout(25)
          }
          assert(retained.every(id=>after.includes(id)),'Departure must preserve every unowned fixture record')
          if(values.mobile)assert.equal(await page.evaluate(()=>sessionStorage.getItem('codenomad.rune.alpha.records-released')),'1')
          measured.departure={owned,retained,ownedRemoved:true,unownedPreserved:true}
        }
        records.push({name, colorScheme, width, height, emulatedTouch: touch, firstAccessibleMs, canvasBounds: canvas, textContrast, routes,history,eventSource,...measured, pass: true})
      } catch (error) {
        await page.screenshot({path: path.join(out, `${name}-${colorScheme}-failure.png`)}).catch(() => {})
        await writeFile(path.join(out, `${name}-${colorScheme}-failure.json`), JSON.stringify({error: error.message, errors, forbiddenRequests,routes,history,measured,mirror:await page.locator('body').ariaSnapshot()}, null, 2))
        throw error
      } finally {await context.close()}
    }
  }
} finally {
  await browser.close()
  await writeFile(path.join(out, 'smoke-report.json'), JSON.stringify({platform: process.platform, browser: 'Chromium headless',
    scene: values.connected?'connected':'synthetic', records, pending: ['real phone keyboard/IME/autocorrect/dictation', 'screen reader on physical device', 'phone power and sustained performance',...(values.connected?[]:['Rust-server connected session flow'])]}, null, 2) + '\n')
}
console.log(`Rune web smoke evidence: ${out}`)
