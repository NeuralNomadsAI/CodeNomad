import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {chromium} from 'playwright'

const profile = JSON.parse(await readFile(new URL('../../packages/ui/src/lib/native/browser-emulation.json', import.meta.url)))

export function mobileContext(browser) {
  return {
    viewport: profile.mobile, screen: profile.mobile, deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: true, hasTouch: true, userAgent: profile.userAgent.replace('{version}', browser.version()),
  }
}

export async function mobileClientHints(page, browser) {
  const cdp = await page.context().newCDPSession(page)
  const version = browser.version()
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent:mobileContext(browser).userAgent, platform:'Linux armv8l',
    userAgentMetadata:{brands:[{brand:'Chromium',version:version.split('.')[0]}],fullVersion:version,
      platform:'Android',platformVersion:'11.0.0',architecture:'',model:'',mobile:true},
  })
  return cdp
}

export async function pairFixture({origin, pairingUrl, storage, manifest}) {
  const url = new URL(pairingUrl)
  assert.match(origin, /^https:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(url.origin, origin)
  assert.equal(url.pathname, '/remote-pair')
  assert.match(url.hash, /^#[\w-]{32}$/)
  const browser = await chromium.launch({headless:true})
  try {
    const context = await browser.newContext({...mobileContext(browser), ignoreHTTPSErrors:true})
    const page = await context.newPage()
    await mobileClientHints(page,browser)
    const pairPath = '/api/remote-control/pair'
    const assets = new Set(['/', '/remote-pair', ...manifest.files.map(row => `/${row.file}`)])
    await context.route('**/*', route => {
      const req = route.request(), requested = new URL(req.url())
      const pair = req.method() === 'POST' && requested.pathname === pairPath && req.postDataJSON()?.code === url.hash.slice(1)
      return requested.origin === origin && (pair || req.method() === 'GET' && assets.has(requested.pathname))
        ? route.continue() : route.abort()
    })
    const get = (pathname, options) => context.request.get(new URL(pathname, origin).href, {maxRedirects:0,...options})
    assert.equal((await get('/api/workspaces')).status(), 401)
    assert.deepEqual(await (await get('/api/auth/status')).json(), {authenticated:false,pairingRequired:true})
    assert.equal((await get('/app_bg.wasm')).status(), 401)
    const redirect = await get('/', {maxRedirects:0,headers:{accept:'text/html'}})
    assert.equal(redirect.status(), 302)
    assert.equal(redirect.headers().location, '/remote-pair')
    const exchanged = page.waitForResponse(res => new URL(res.url()).pathname === pairPath)
    await page.goto(url.href).catch(error => {if (!String(error).includes('ERR_ABORTED')) throw error})
    assert.equal((await exchanged).status(), 200)
    await page.waitForURL(`${origin}/`)
    const cookies = await context.cookies()
    assert(cookies.some(c => c.name === '__Host-codenomad_device' && c.secure && c.httpOnly && c.sameSite === 'Lax'))
    assert.equal((await (await get('/api/auth/status')).json()).authenticated, true)
    assert.equal((await get('/api/workspaces')).status(), 200)
    for (const pathname of ['/login', '/api/remote-control/devices', '/snippets/missing.js', '/app.d.ts']) {
      assert.equal((await get(pathname)).status(), 404, pathname)
    }
    const wasm = await get('/app_bg.wasm')
    assert.equal(wasm.status(), 200)
    assert.equal(wasm.headers()['content-type'], 'application/wasm')
    assert.equal(wasm.headers()['cache-control'], 'private, no-cache')
    const cached = await get('/app_bg.wasm', {headers:{'if-none-match':wasm.headers().etag}})
    assert.equal(cached.status(), 304)
    assert.equal((await get('/app_bg.wasm',{headers:{origin:'https://foreign.invalid'}})).status(),403)
    assert.equal((await get('/app_bg.wasm',{headers:{'x-codenomad-server-request':'1'}})).status(),404)
    const sha256 = createHash('sha256').update(await wasm.body()).digest('hex')
    assert.equal(sha256, manifest.files.find(row => row.file === 'app_bg.wasm').sha256)
    await context.storageState({path:storage})
    return {origin, sha256, paired:true}
  } finally { await browser.close() }
}

// Explicitly emulate a shrinking visual viewport, not an Android system keyboard.
export function mobileViewport() {
  const viewport = window.visualViewport
  const height = Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'height').get.bind(viewport)
  const offsetTop = Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'offsetTop').get.bind(viewport)
  let lost = 0, pan = 0
  Object.defineProperties(viewport, {
    height: {get: () => height() - lost}, offsetTop: {get: () => offsetTop() + pan},
  })
  window.fixtureViewport = (loss, top = 0) => {
    lost = loss
    pan = top
    viewport.dispatchEvent(new Event('resize'))
  }
}

export async function mobileInteraction(page, labels) {
  const cdp = await page.context().newCDPSession(page)
  const evidence = {}
  async function probe(name, check) {
    try {evidence[name] = await check()}
    catch (error) {evidence[name] = {error:String(error.message).slice(0,400)}}
  }
  const role = (type, name) => page.getByRole(type, {name, exact:true})
  const composer = role('group', labels.prompt)
  const send = role('button', labels.send)
  const editor = page.locator('textarea:focus')
  const center = async locator => {
    const rect = await locator.boundingBox()
    assert(rect && rect.width && rect.height)
    return {x:Math.round(rect.x + rect.width / 2),y:Math.round(rect.y + rect.height / 2)}
  }
  const rowSample = () => page.evaluate(() => [...document.querySelectorAll('[data-rune-a11y] p')]
    .filter(n => n.textContent.startsWith('Mobile history row '))
    .map(n => [n.textContent,Math.round(n.getBoundingClientRect().top)])
    .filter(([,y]) => y >= 64 && y < innerHeight-130))
  const waitValue = value => page.waitForFunction(value =>
    document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.value === value, value, {timeout:2500})
  const text = 'été 日本語 🦀'
  try {
    await probe('touchScroll', async () => {
      const before = await rowSample()
      assert(before.length, 'No visible fixture history rows')
      const y = Math.min(Math.max(before.at(-1)[1], 170), 350)
      const points = step => [{x:175, y:y+step, id:1}]
      await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:points(0)})
      for (const step of [35,90,160,240]) {
        await cdp.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:points(step)})
      }
      await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]})
      const frames = await page.evaluate(() => new Promise(resolve => {
        const all = []
        let last = performance.now()
        function frame(at) {
          all.push(at - last)
          last = at
          if (all.length >= 24) resolve(all.slice(1).sort((a,b) => a-b))
          else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      }))
      const after = await rowSample()
      const latest = await center(role('button', labels.latest))
      await page.touchscreen.tap(latest.x, latest.y)
      return {moved:JSON.stringify(before)!==JSON.stringify(after),before,after,frameP95Ms:frames[Math.floor(frames.length*0.95)]}
    })
    await probe('touchEditor', async () => {
      const focus = await center(composer)
      await page.touchscreen.tap(focus.x,focus.y)
      let tap='center'
      if(!await page.waitForFunction(() => document.activeElement?.tagName==='TEXTAREA',undefined,{timeout:800}).catch(()=>false)){
        tap='first line'
        const bounds=await composer.boundingBox()
        await page.touchscreen.tap(focus.x,Math.round(bounds.y+30))
      }
      if(!await page.waitForFunction(() => document.activeElement?.tagName==='TEXTAREA',undefined,{timeout:800}).catch(()=>false)){
        const target = await page.evaluate(({x,y})=>({at:document.elementFromPoint(x,y)?.tagName,active:document.activeElement?.tagName}),focus)
        return {focused:false,point:focus,...target}
      }
      await cdp.send('Input.insertText',{text})
      await waitValue(text)
      return {...await editor.evaluate(el => ({focused:true,name:el.getAttribute('aria-label'),inputMode:el.inputMode,
        autocapitalize:el.autocapitalize,spellcheck:el.spellcheck})),tap}
    })
    await probe('compositionAndReplacement', async () => {
      let focus = 'touch'
      if(!await editor.count()){
        focus = 'keyboard'
        for(let i=0;i<18&&!await editor.count();i++)await page.keyboard.press('Tab')
        if(await editor.count()){
          await cdp.send('Input.insertText',{text})
          await waitValue(text)
        }
      }
      await editor.waitFor({state:'attached',timeout:2500})
      await cdp.send('Input.imeSetComposition',{text:'かな',selectionStart:2,selectionEnd:2})
      await cdp.send('Input.insertText',{text:'仮名'})
      await waitValue(`${text}仮名`)
      // An external text service can replace a range without emitting key strokes.
      await editor.evaluate(el => {
        el.setRangeText('Été',0,3,'end')
        el.dispatchEvent(new InputEvent('input',{inputType:'insertReplacementText',data:'Été',bubbles:true}))
      })
      await waitValue('Été 日本語 🦀仮名')
      return {focus,composed:true,replaced:true}
    })
    await probe('visualOcclusion', async () => {
      const value = await editor.count()?await editor.inputValue():null
      await page.evaluate(() => window.fixtureViewport(330,50))
      const canvas = page.locator('canvas').first()
      const resized=!!await page.waitForFunction(() =>
        Math.abs(document.querySelector('canvas').getBoundingClientRect().height - visualViewport.height)<1,
      undefined,{timeout:1300}).catch(()=>false)
      const field = await composer.boundingBox(), button = await send.boundingBox()
      const shown = await canvas.boundingBox()
      const {top,bottom} = await page.evaluate(() => ({top:visualViewport.offsetTop,bottom:visualViewport.offsetTop+visualViewport.height}))
      if(value!==null)await waitValue(value)
      return {resized,canvas:shown,field,button,top,bottom,retainedDraft:value!==null,
        sendReachable:button?.y>=top && button?.y+button?.height<=bottom+1}
    })
    await page.evaluate(() => window.fixtureViewport(0))
    evidence.accessibility = await role('button',labels.older).evaluate(el => ({
      olderDisabled:el.disabled || el.getAttribute('aria-disabled')==='true',
      role:el.getAttribute('role') || el.tagName.toLowerCase(),
    }))
    return evidence
  } finally {await cdp.detach()}
}
