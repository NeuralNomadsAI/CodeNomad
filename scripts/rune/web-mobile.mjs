import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {chromium} from 'playwright'
import {bundleAssetPaths} from './web-workspace-policy.mjs'
import {navigatePair} from './web-live.mjs'

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

export async function pairFixture({origin, pairingUrl, storage, manifest, ui, fromLink=true}) {
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
    const assets = await bundleAssetPaths(ui)
    assets.add('/remote-pair')
    await context.route('**/*', route => {
      const req = route.request(), requested = new URL(req.url())
      return requested.origin === origin && req.method() === 'GET' && assets.has(requested.pathname)
        ? route.continue() : route.abort()
    })
    const get = (pathname, options) => context.request.get(new URL(pathname, origin).href, {maxRedirects:0,...options})
    assert.equal((await get('/api/workspaces')).status(), 401)
    assert.deepEqual(await (await get('/api/auth/status')).json(), {authenticated:false,pairingRequired:true})
    const redirect = await get('/', {maxRedirects:0,headers:{accept:'text/html'}})
    assert.equal(redirect.status(), 302)
    assert.equal(redirect.headers().location, '/remote-pair')
    const guide = await get('/remote-pair')
    assert.equal(guide.headers()['cache-control'], 'no-store')
    assert.equal(guide.headers()['referrer-policy'], 'no-referrer')
    await page.goto(`${origin}/remote-pair?locale=he`)
    await page.waitForFunction(() => document.documentElement.lang==='he' && document.documentElement.dir==='rtl')
    assert(await page.getByRole('heading').textContent())
    assert(await page.locator('main').evaluate(el => {
      const sample=document.createElement('div')
      sample.style.background='var(--surface-overlay)'
      document.body.append(sample)
      const matches=getComputedStyle(el).backgroundColor===getComputedStyle(sample).backgroundColor
      sample.remove()
      return matches
    }), 'The pairing card consumes the shared overlay token')
    url.searchParams.set('locale','fr')
    await navigatePair(page,url,{fromLink})
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
    const cached = await get('/app_bg.wasm', {headers:{'if-none-match':wasm.headers().etag}})
    assert.equal(cached.status(), 304)
    assert.equal((await get('/app_bg.wasm',{headers:{origin:'https://foreign.invalid'}})).status(),403)
    assert.equal((await get('/app_bg.wasm',{headers:{'x-codenomad-server-request':'1'}})).status(),404)
    const sha256 = createHash('sha256').update(await wasm.body()).digest('hex')
    assert.equal(sha256, manifest.files.find(row => row.file === 'app_bg.wasm').sha256)
    await context.storageState({path:storage})
    return {origin, sha256, paired:true, crossOriginLink:fromLink}
  } finally { await browser.close() }
}

export async function mobileInteraction(page, labels, imagePage) {
  const cdp = await page.context().newCDPSession(page)
  const evidence = {}
  async function probe(name, check) {
    evidence[name] = await check()
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
      await editor.waitFor({state:'attached',timeout:2500})
      await cdp.send('Input.insertText',{text})
      await waitValue(text)
      return {...await editor.evaluate(el => ({focused:true,name:el.getAttribute('aria-label'),inputMode:el.inputMode,
        autocapitalize:el.autocapitalize,spellcheck:el.spellcheck})),tap:'center'}
    })
    await probe('compositionAndReplacement', async () => {
      const bounds=await composer.boundingBox()
      assert(bounds)
      const clip={x:Math.ceil(bounds.x+2),y:Math.ceil(bounds.y+2),width:Math.floor(bounds.width-4),height:Math.floor(bounds.height/2)-4}
      const capture=async()=>`data:image/png;base64,${(await page.screenshot({clip,scale:'css'})).toString('base64')}`
      const before=await capture()
      await cdp.send('Input.imeSetComposition',{text:'かな',selectionStart:2,selectionEnd:2})
      await waitValue(`${text}かな`)
      let preedit
      for(const until=Date.now()+2500;;){
        preedit=await imagePage.evaluate(async ([before, after])=>{
          const [a,b]=await globalThis.__codenomadReadPngs([before,after])
          let first=a.width,last=0,changed=0
          for(let i=0;i<a.pixels.length;i+=4){
            if(![0,1,2].some(c=>Math.abs(a.pixels[i+c]-b.pixels[i+c])>16))continue
            const x=i/4%a.width
            first=Math.min(first,x);last=Math.max(last,x);changed++
          }
          return {changedInkPixels:changed,inkWidth:last-first+1}
        },[before,await capture()])
        if(preedit.changedInkPixels>=25&&preedit.inkWidth>=8)break
        assert(Date.now()<until,'Rune must paint the preedit before the browser commits it')
      }
      await cdp.send('Input.insertText',{text:'仮名'})
      await waitValue(`${text}仮名`)
      // An external text service can replace a range without emitting key strokes.
      await editor.evaluate(el => {
        el.setRangeText('Été',0,3,'end')
        el.dispatchEvent(new InputEvent('input',{inputType:'insertReplacementText',data:'Été',bubbles:true}))
      })
      await waitValue('Été 日本語 🦀仮名')
      await page.keyboard.press('Tab')
      await page.waitForFunction(()=>!document.querySelector('textarea:focus')&&[...document.querySelectorAll('textarea')].every(el=>!el.value))
      const point=await center(composer)
      await page.touchscreen.tap(point.x,point.y)
      await waitValue('Été 日本語 🦀仮名')
      return {composed:true,replaced:true,preedit,restoredAfterBlur:true}
    })
    await probe('visualOcclusion', async () => {
      const value = await editor.inputValue()
      const viewport = page.viewportSize()
      // resizes-content makes the keyboard shrink the layout viewport in Android Chrome.
      await page.setViewportSize({...viewport,height:viewport.height-330})
      const canvas = page.locator('canvas').first()
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas'), height = visualViewport.height
        return Math.abs(canvas.getBoundingClientRect().height-height)<1 && Math.abs(canvas.height-height*devicePixelRatio)<=1
      })
      const field = await composer.boundingBox(), button = await send.boundingBox()
      const shown = await canvas.boundingBox()
      const viewportBounds = await page.evaluate(() => ({top:visualViewport.offsetTop,bottom:visualViewport.offsetTop+visualViewport.height,
        left:visualViewport.offsetLeft,right:visualViewport.offsetLeft+visualViewport.width}))
      const {top,bottom,left,right}=viewportBounds
      await waitValue(value)
      assert(field&&field.height>0&&field.y>=top-1&&field.y+field.height<=bottom+1&&field.x>=left-1&&field.x+field.width<=right+1,
        'The composer field must stay visible in the smaller viewport')
      assert(button?.y>=top && button?.y+button?.height<=bottom+1,'Send must stay within the smaller viewport')
      await page.setViewportSize(viewport)
      return {resized:true,canvas:shown,field,button,viewportBounds,retainedDraft:true,fieldVisible:true,sendReachable:true}
    })
    return evidence
  } finally {await cdp.detach()}
}
