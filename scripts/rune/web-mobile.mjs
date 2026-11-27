import assert from 'node:assert/strict'
import {mkdir,readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {createAttestedFetch,probeProcessIdentity,verifyLoopbackListenerOwner} from '../native-fixture-http.mjs'
import {launchOwnedChromium} from './web-chromium.mjs'
import {bundleAssetPaths,privateChromiumEnv} from './web-workspace-policy.mjs'
import {isExpectedWaitError, now, withBudget} from './web-budget.mjs'
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

export async function pairFixture({origin, targetPid, profile: fixtureProfile, pairingUrl, storage, manifest, ui, fromLink=true}) {
  const url = new URL(pairingUrl)
  assert.match(origin, /^https:\/\/127\.0\.0\.1:\d+$/)
  assert(Number.isSafeInteger(targetPid) && targetPid > 0, 'Attested target PID required for mobile pairing')
  assert(typeof fixtureProfile === 'string' && fixtureProfile.length > 0, 'Isolated profile path required for mobile pairing')
  assert.equal(url.origin, origin)
  assert.equal(url.pathname, '/remote-pair')
  assert.match(url.hash, /^#[\w-]{32}$/)
  await verifyLoopbackListenerOwner(Number(url.port), targetPid)
  const pairProfile = path.join(fixtureProfile, 'pair-chromium')
  await mkdir(pairProfile, {recursive: true})
  const ca = await readFile(path.join(fixtureProfile, 'identity.data/tls/ca-cert.pem')).catch(() => undefined)
  const targetProbe = await probeProcessIdentity(targetPid, {refresh: true})
  assert(targetProbe.status === 'ok' && targetProbe.identity?.startId, 'Unable to attest mobile pairing server incarnation')
  const targetStartId = targetProbe.identity.startId
  const chromiumEnv = await privateChromiumEnv(pairProfile)
  let ownedBrowser, attestedFetch, primaryError = null
  try {
    ownedBrowser = await launchOwnedChromium({profile: pairProfile, env: chromiumEnv, origin, targetPid, targetStartId})
    attestedFetch = createAttestedFetch(origin, Number(url.port), targetPid, {...(ca ? {ca} : {allowSelfSigned: true}), targetStartId})
    const browser = ownedBrowser.browser
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
    const cookieHeader = async () => (await context.cookies(origin)).map(c => `${c.name}=${c.value}`).join('; ')
    const get = async (pathname, options = {}) => {
      const cookie = await cookieHeader()
      return attestedFetch(new URL(pathname, origin).href, {
        redirect: 'manual', ...options,
        headers: {...(cookie ? {cookie} : {}), ...options.headers},
        signal: AbortSignal.timeout(15000),
      })
    }
    const entryHeaders={accept:'text/html',referer:'https://rune-pair-source.test/'}
    const entry = async method => {
      const cookie = await cookieHeader()
      return attestedFetch(`${origin}/`, {
        method, redirect: 'manual',
        headers: {...entryHeaders, ...(cookie ? {cookie} : {})},
        signal: AbortSignal.timeout(15000),
      })
    }
    assert.equal((await get('/api/workspaces')).status, 401)
    assert.deepEqual(await (await get('/api/auth/status')).json(), {authenticated:false,pairingRequired:true})
    const redirect = await get('/', {headers:{accept:'text/html'}})
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('location'), '/remote-pair')
    if(fromLink)for(const method of ['GET','HEAD']){
      const response=await entry(method)
      assert.equal(response.status,302,`${method} from an external page must redirect before pairing`)
      assert.equal(response.headers.get('location'),'/remote-pair')
      if(method==='HEAD')assert.equal((await response.arrayBuffer()).byteLength,0)
    }
    const guide = await get('/remote-pair')
    assert.equal(guide.headers.get('cache-control'), 'no-store')
    assert.equal(guide.headers.get('referrer-policy'), 'no-referrer')
    await page.goto(`${origin}/remote-pair?locale=he`)
    await page.waitForFunction(() => document.documentElement.lang==='he' && document.documentElement.dir==='rtl')
    const pairViewport = await page.locator('meta[name="viewport"]').getAttribute('content')
    assert(pairViewport?.split(',').includes('viewport-fit=cover'), `Pairing viewport must include viewport-fit=cover: ${pairViewport}`)
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
    await navigatePair(page,url,{fromLink,assets})
    const cookies = await context.cookies()
    assert(cookies.some(c => c.name === '__Host-codenomad_device' && c.secure && c.httpOnly && c.sameSite === 'Lax'))
    assert.equal((await (await get('/api/auth/status')).json()).authenticated, true)
    assert.equal((await get('/api/workspaces')).status, 200)
    const pairedEntry={}
    if(fromLink)for(const method of ['GET','HEAD']){
      const response=await entry(method)
      assert.equal(response.status,200,`${method} from an external page must serve the client after pairing`)
      assert.match(response.headers.get('content-type')??'',/^text\/html/)
      const body=Buffer.from(await response.arrayBuffer())
      if(method==='GET')assert.match(body.toString('utf8'),/\.\/boot\.js/)
      else assert.equal(body.length,0)
      pairedEntry[method]=response.status
    }
    for (const pathname of ['/login', '/api/remote-control/devices', '/snippets/missing.js', '/app.d.ts', '/app_bg.wasm.br']) {
      assert.equal((await get(pathname)).status, 404, pathname)
    }
    const wasm = await get('/app_bg.wasm', {headers: {'accept-encoding': 'br'}})
    assert.equal(wasm.status, 200)
    assert.equal(wasm.headers.get('content-type'), 'application/wasm')
    assert.equal(wasm.headers.get('content-encoding'), 'br')
    const cached = await get('/app_bg.wasm', {cache: 'force-cache', headers:{'accept-encoding': 'br', 'if-none-match': wasm.headers.get('etag')}})
    assert.equal(cached.status, 304)
    const rawWasm = await get('/app_bg.wasm', {headers: {'accept-encoding': 'identity'}})
    assert.equal(rawWasm.status, 200)
    assert.equal(rawWasm.headers.get('content-type'), 'application/wasm')
    assert.equal(rawWasm.headers.get('content-encoding'), null)
    assert.notEqual(rawWasm.headers.get('etag'), wasm.headers.get('etag'))
    const rawCached = await get('/app_bg.wasm', {cache: 'force-cache', headers: {'accept-encoding': 'identity', 'if-none-match': rawWasm.headers.get('etag')}})
    assert.equal(rawCached.status, 304)
    assert.equal((await get('/app_bg.wasm',{headers:{origin:'https://foreign.invalid'}})).status,403)
    const serverAssetCookie = await cookieHeader()
    const serverAsset = await attestedFetch.request({
      path: '/app_bg.wasm',
      method: 'GET',
      headers: { ...(serverAssetCookie ? { cookie: serverAssetCookie } : {}), 'x-codenomad-server-request': '1' },
      signal: AbortSignal.timeout(15000),
    })
    await serverAsset.body.dump()
    assert.equal(serverAsset.statusCode, 404)
    const expectedWasmSha = manifest.files.find(row => row.file === 'app_bg.wasm').sha256
    const sha256 = createHash('sha256').update(Buffer.from(await wasm.arrayBuffer())).digest('hex')
    assert.equal(sha256, expectedWasmSha)
    assert.equal(createHash('sha256').update(Buffer.from(await rawWasm.arrayBuffer())).digest('hex'), expectedWasmSha)
    await context.storageState({path:storage})
    return {origin, sha256, paired:true, crossOriginLink:fromLink, clientBootReady:true, pairedEntry}
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    await attestedFetch?.close().catch(() => {})
    if (ownedBrowser) {
      try {
        await ownedBrowser.close()
      } catch (closeError) {
        console.error(`Failed to close pairing browser: ${closeError.message}`)
        if (!primaryError) throw closeError
      }
    }
  }
}

export async function mobileTabBar(page, labels) {
  const viewport = page.viewportSize()
  const buttons = labels.map(name => page.getByRole('button', {name, exact: true}))
  await Promise.all(buttons.map(button => button.waitFor({state: 'attached'})))
  const rtl = await page.locator('html').getAttribute('dir') === 'rtl'
  const rounding = 0.5 // Rune's mirror projects subpixel bounds at fractional DPR.
  const measure = async width => {
    await page.setViewportSize({...viewport, width})
    // The trailing action reaches the new edge only after Rune has updated the mirror.
    if (!rtl) await buttons.at(-1).evaluate((button, width) => new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000
      function frame(now) {
        if (Math.abs(button.getBoundingClientRect().right - width) < 0.5) resolve()
        else if (now >= deadline) reject(Error(`Tab bar mirror did not reach the ${width}px viewport edge`))
        else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }), width)
    const boxes = await Promise.all(buttons.map(button => button.boundingBox()))
    for (const [i, a] of boxes.entries()) {
      const name = labels[i]
      assert(a && a.width >= 43.99 && a.height >= 43.99, `${width}px: ${name} needs a 44px touch target: ${JSON.stringify(a)}`)
      assert(a.x >= -rounding && a.y >= -rounding && a.x + a.width <= width + rounding && a.y + a.height <= viewport.height + rounding,
        `${width}px: ${name} is outside the viewport: ${JSON.stringify(a)}`)
      assert(Math.abs(a.y - boxes[0].y) < 0.5, `${width}px: ${name} must share the tab bar row`)
      for (const [j, b] of boxes.slice(0, i).entries()) {
        assert(a.x >= b.x + b.width - rounding || b.x >= a.x + a.width - rounding,
        `${width}px: ${name} overlaps ${labels[j]}: ${JSON.stringify([a, b])}`)
      }
    }
    const [plus] = boxes
    assert((rtl ? width - plus.x - plus.width : plus.x) >= 44, `${width}px: the tab list must retain visible space`)
    return {width, boxes}
  }
  const measured = []
  for (const width of [...[320, 390, 430].filter(width => width !== viewport.width), viewport.width]) {
    measured.push(await measure(width))
  }
  return measured
}

export async function mobileInteraction(page, labels, imagePage, theme, colors) {
  const cdp = await page.context().newCDPSession(page)
  const evidence = {}
  async function probe(name, check) {
    evidence[name] = await check()
  }
  const role = (type, name) => page.getByRole(type, {name, exact:true})
  const composer = role('group', labels.prompt)
  const send = role('button', labels.send)
  const editor = page.locator('textarea:focus')
  const pad=theme['space-md'],gap=theme['space-sm']
  const line=2*gap+Math.ceil(theme['font-size-base']*theme['line-height-normal'])
  async function tryFieldRect(deadline){
    const run=ms=>composer.evaluate(el=>{
      const r=el.getBoundingClientRect()
      const actions=Math.min(...[...el.querySelectorAll('button,[role="button"]')].map(button=>button.getBoundingClientRect().top))
      return {x:r.x,y:r.y,width:r.width,height:r.height,actions}
    },undefined,ms!==undefined?{timeout:Math.max(1,ms)}:undefined)
    let box
    try{
      box=deadline!==undefined?await withBudget(deadline,'composer rect',run):await run()
    }catch(err){
      if(isExpectedWaitError(err))return null
      throw err
    }
    if(!box||!Number.isFinite(box.actions)||box.width<=0||box.height<=0||(deadline!==undefined&&now()>=deadline))return null
    const x=Math.ceil(box.x+pad),y=Math.ceil(box.y+pad)
    const width=Math.floor(box.x+box.width-pad)-x,height=Math.floor(box.actions-gap)-y
    return width>0&&height>0?{x,y,width,height}:null
  }
  async function fieldRect(){
    const rect=await tryFieldRect()
    assert(rect,'Composer field must expose non-empty bounds')
    return rect
  }
  const inkClip=field=>({...field,height:Math.min(line,field.height)})
  const capture=async clip=>`data:image/png;base64,${(await page.screenshot({clip,scale:'css'})).toString('base64')}`
  async function glyphMatch(baseline, reference, candidate, startX=0, align=0, resized=false){
    return imagePage.evaluate(async ([baseline,reference,candidate,startX,align,colors])=>{
      const [a,b,c]=await globalThis.__codenomadReadPngs([baseline,reference,candidate?.flat?candidate.png:candidate])
      if(candidate?.flat){
        const canvas=document.createElement('canvas')
        canvas.width=c.width;canvas.height=c.height
        const ctx=canvas.getContext('2d')
        ctx.fillStyle=candidate.flat;ctx.fillRect(0,0,c.width,c.height)
        c.pixels=ctx.getImageData(0,0,c.width,c.height).data
      }
      const contrast=colors&&globalThis.__codenomadTextContrast(colors['surface-field'],colors['text-primary'])
      const isInk=(image,i)=>contrast.matches(image.pixels.subarray(i,i+3))
      const glyphs=[]
      for(let i=0;i<a.pixels.length;i+=4){
        const x=i/4%a.width,y=Math.floor(i/4/a.width)
        if(x<startX)continue
        if(contrast ? !isInk(b,i)||isInk(a,i) : ![0,1,2].some(k=>Math.abs(a.pixels[i+k]-b.pixels[i+k])>28))continue
        glyphs.push({i,x,y})
      }
      let best={matched:-1}
      for(let dy=-align;dy<=align;dy++)for(let dx=-align;dx<=align;dx++){
        let matched=0,minX=a.width,maxX=0,minY=a.height,maxY=0
        let minContrast=Infinity
        for(const {i,x,y} of glyphs){
          if(x+dx<0||x+dx>=c.width||y+dy<0||y+dy>=c.height)continue
          const at=((y+dy)*c.width+x+dx)*4
          if(contrast ? !isInk(c,at) : ![0,1,2].every(k=>Math.abs(c.pixels[at+k]-b.pixels[i+k])<=36)||
            ![0,1,2].some(k=>Math.abs(c.pixels[at+k]-a.pixels[i+k])>20))continue
          minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y)
          if(contrast)minContrast=Math.min(minContrast,contrast.ratio(c.pixels.subarray(at,at+3)))
          matched++
        }
        if(matched>best.matched)best={matched,referencePixels:glyphs.length,width:maxX-minX+1,height:maxY-minY+1,lastX:maxX,dx,dy,
          ...(contrast?{minimumMatchedContrast:matched?minContrast:null}:{})}
      }
      return best
    },[baseline,reference,candidate,startX,align,resized?colors:null])
  }
  function looksLikeGlyphs(match){
    return match.matched>=25&&match.matched>=match.referencePixels*0.5&&match.width>=8&&match.height>=4
  }
  const center = async locator => {
    const rect = await locator.boundingBox()
    assert(rect && rect.width && rect.height)
    return {x:Math.round(rect.x + rect.width / 2),y:Math.round(rect.y + rect.height / 2)}
  }
  const fieldCenter = async () => {
    const field = await fieldRect()
    return {x:Math.round(field.x + field.width / 2),y:Math.round(field.y + field.height / 2)}
  }
  const rowSample = () => page.evaluate(() => [...document.querySelectorAll('[data-rune-a11y] p')]
    .filter(n => n.textContent.startsWith('Mobile history row '))
    .map(n => [n.textContent,Math.round(n.getBoundingClientRect().top)])
    .filter(([,y]) => y >= 64 && y < innerHeight-130))
  const hasMovedUp = (prev, rows) => {
    if (!rows.length) return false
    const prevByLabel = new Map(prev)
    let shared = false
    for (const [label, top] of rows) {
      const oldTop = prevByLabel.get(label)
      if (oldTop !== undefined) {
        shared = true
        if (top - oldTop >= 20) return true
      }
    }
    if (shared) return false
    const rowIndex = label => {
      const match = /^Mobile history row (\d+)$/.exec(label)
      return match ? Number(match[1]) : null
    }
    const beforeTop = rowIndex(prev[0][0]), afterTop = rowIndex(rows[0][0])
    return beforeTop !== null && afterTop !== null && afterTop < beforeTop
  }
  const waitValue = async value => {
    try {
      await page.waitForFunction(value =>
        document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.value === value,
        value, {polling: 50, timeout: 10_000})
    } catch (error) {
      const state = await page.evaluate(() => ({
        activeTag: document.activeElement?.tagName ?? null,
        activeValue: typeof document.activeElement?.value === 'string' ? document.activeElement.value : null,
        textareas: [...document.querySelectorAll('textarea')].map(el => ({inert: el.inert, value: el.value})),
      })).catch(() => null)
      throw new Error(`${error.message} (expected=${JSON.stringify(value)}, state=${JSON.stringify(state)})`, {cause: error})
    }
  }
  const text = 'été 日本語 🦀'
  let blank,paintedDraft
  try {
    await probe('touchScroll', async () => {
      const before = await withBudget(now() + 5000, 'touchScroll before', () => rowSample())
      assert(before.length, 'No visible fixture history rows')
      const y = Math.min(Math.max(before.at(-1)[1], 170), 350)
      // Let Chromium pace the touch sequence; a host round trip after touchStart can turn it into a hold.
      await withBudget(now() + 10000, 'touchScroll gesture', () => cdp.send('Input.synthesizeScrollGesture', {
        x:175,y,yDistance:240,speed:1000,gestureSourceType:'touch',preventFling:true,
      }))
      // DPR 2.75 software WebGL (SwiftShader) renders ~800 ms/frame (~19.5 s for 24 frames);
      // 35 s keeps the full 24-frame sample without timing out under parallel CPU load.
      const frames = await withBudget(now() + 35000, 'touchScroll frames', () => page.evaluate(() => new Promise(resolve => {
        const all = []
        let last = performance.now()
        function frame(at) {
          all.push(at - last)
          last = at
          if (all.length >= 24) resolve(all.slice(1).sort((a,b) => a-b))
          else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      })))
      // Post-scroll accessibility mirror updates flush off-rAF after scroll settle and idle timeout.
      let after = [], moved = false
      const settleDeadline = now() + 1500
      while (now() < settleDeadline) {
        const sample = await withBudget(Math.min(settleDeadline, now() + 250), 'touchScroll mirror', () => rowSample())
          .catch(err => { if (isExpectedWaitError(err)) return null; throw err })
        if (sample) {
          after = sample
          if (hasMovedUp(before, sample)) {
            moved = true
            break
          }
        }
        const wait = Math.min(25, settleDeadline - now())
        if (wait <= 0) break
        await page.waitForTimeout(wait)
      }
      const latest = await withBudget(now() + 5000, 'touchScroll latest', () => center(role('button', labels.latest)))
      await withBudget(now() + 5000, 'touchScroll tap latest', () => page.touchscreen.tap(latest.x, latest.y))
      return {moved,before,after,frameP95Ms:frames[Math.floor(frames.length*0.95)]}
    })
    await probe('touchEditor', async () => {
      const focus = await fieldCenter()
      await page.touchscreen.tap(focus.x,focus.y)
      await editor.waitFor({state:'attached',timeout:10_000})
      assert.equal(await page.locator('[data-rune-menu]').count(),0,'Primary tap on composer must not open a long-press menu')
      blank=await capture(inkClip(await fieldRect()))
      await cdp.send('Input.insertText',{text})
      await waitValue(text)
      return {...await editor.evaluate(el => ({focused:true,name:el.getAttribute('aria-label'),inputMode:el.inputMode,
        autocapitalize:el.autocapitalize,spellcheck:el.spellcheck})),tap:'center'}
    })
    await probe('compositionAndReplacement', async () => {
      const clip=inkClip(await fieldRect())
      let before,prefix
      for(const until=Date.now()+10_000;;){
        before=await capture(clip)
        // Locate the typed prefix by its ink, not by changed focus or field pixels.
        prefix=await glyphMatch(blank,before,before,0,0,true)
        if(looksLikeGlyphs(prefix)&&prefix.width>=30)break
        assert(Date.now()<until,'The initial text must already be painted before starting preedit')
      }
      const startX=prefix.lastX+1
      const composing='かな'
      await cdp.send('Input.imeSetComposition',{text:composing,selectionStart:2,selectionEnd:2})
      await waitValue(text+composing)
      // Keep samples taken before commit; the committed glyphs provide an underline-free reference.
      const samples=[]
      for(let probe=0;probe<3;probe++)samples.push(await capture(clip))
      await cdp.send('Input.insertText',{text:composing})
      await waitValue(text+composing)
      let preedit,reference
      for(const until=Date.now()+10_000;;){
        reference=await capture(clip)
        const matches=await Promise.all(samples.map(sample=>glyphMatch(before,reference,sample,startX)))
        preedit=matches.find(looksLikeGlyphs)
        if(preedit)break
        assert(Date.now()<until,`Rune must paint the committed glyph shapes during preedit: ${JSON.stringify({prefix,startX,matches})}`)
      }
      assert(!looksLikeGlyphs(await glyphMatch(before,reference,before,startX)),'The no-glyph control must fail')
      // An external text service can replace a range without emitting key strokes.
      await editor.evaluate(el => {
        el.setRangeText('Été',0,3,'end')
        el.dispatchEvent(new InputEvent('input',{inputType:'insertReplacementText',data:'Été',bubbles:true}))
      })
      const draft='Été 日本語 🦀かな'
      await waitValue(draft)
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      paintedDraft=await capture(clip)
      await page.keyboard.press('Tab')
      await page.waitForFunction(()=>!document.querySelector('textarea:focus')&&[...document.querySelectorAll('textarea')].every(el=>!el.value))
      const point=await fieldCenter()
      await page.touchscreen.tap(point.x,point.y)
      await waitValue(draft)
      let refocused
      for(const until=Date.now()+10_000;;){
        refocused=await glyphMatch(blank,paintedDraft,await capture(clip))
        if(looksLikeGlyphs(refocused))break
        assert(Date.now()<until,'The committed glyphs must reappear in the painted editor after refocus')
      }
      return {composed:true,replaced:true,preedit,restoredAfterBlur:true,refocused}
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
      const shown = await canvas.boundingBox()
      const viewportBounds = await page.evaluate(() => ({top:visualViewport.offsetTop,bottom:visualViewport.offsetTop+visualViewport.height,
        left:visualViewport.offsetLeft,right:visualViewport.offsetLeft+visualViewport.width}))
      const {top,bottom,left,right}=viewportBounds
      let settled = null, lastField = null, lastButton = null
      // Accessibility mirror updates flush off-rAF after viewport resize settles.
      for(const until=now()+2000;;){
        const remaining=until-now()
        if(remaining<=0) break
        const measured = await withBudget(Math.min(until,now()+250),'composer and send',ms=>composer.evaluate((el,sendLabel)=>{
          const r=el.getBoundingClientRect()
          const buttons=[...el.querySelectorAll('button,[role="button"]')]
          const actions=Math.min(...buttons.map(b=>b.getBoundingClientRect().top))
          const matchSend=buttons.filter(b=>(b.getAttribute('aria-label')??b.textContent??'').trim()===sendLabel)
          if(matchSend.length>1)throw new Error(`Ambiguous send button (${matchSend.length}): ${sendLabel}`)
          const sb=matchSend[0]?matchSend[0].getBoundingClientRect():null
          return {
            group:{x:r.x,y:r.y,width:r.width,height:r.height,actions},
            button:sb?{x:sb.x,y:sb.y,width:sb.width,height:sb.height}:null,
          }
        },labels.send,{timeout:Math.max(1,ms)})).catch(err=>{if(isExpectedWaitError(err))return null;throw err})
        const g = measured?.group
        let candidateField = null
        if(g&&Number.isFinite(g.actions)&&g.width>0&&g.height>0){
          const x=Math.ceil(g.x+pad),y=Math.ceil(g.y+pad)
          const width=Math.floor(g.x+g.width-pad)-x,height=Math.floor(g.actions-gap)-y
          if(width>0&&height>0)candidateField={x,y,width,height}
        }
        const candidateButton = measured?.button ?? null
        lastField = candidateField; lastButton = candidateButton
        if(now()<until&&candidateField&&candidateField.width>0&&candidateField.height>0&&candidateField.y>=top-1&&candidateField.y+candidateField.height<=bottom+1&&candidateField.x>=left-1&&candidateField.x+candidateField.width<=right+1
          &&candidateButton&&candidateButton.width>0&&candidateButton.height>0&&candidateButton.x>=left-1&&candidateButton.x+candidateButton.width<=right+1&&candidateButton.y>=top&&candidateButton.y+candidateButton.height<=bottom+1){
          settled = {field:candidateField, button:candidateButton}
          break
        }
        const wait=Math.min(25,until-now())
        if(wait<=0) break
        await page.waitForTimeout(wait)
      }
      await waitValue(value)
      assert(settled,
        `Composer field and Send button did not settle within 2s in the smaller viewport: ${JSON.stringify({field:lastField,button:lastButton,viewportBounds})}`)
      const {field, button} = settled
      const clip=inkClip(field)
      let draftInk,resizedDraft
      for(const until=Date.now()+10_000;;){
        // CSS screenshots at fractional DPR can round the two crops differently.
        resizedDraft=await capture(clip)
        draftInk=await glyphMatch(blank,paintedDraft,resizedDraft,0,2,true)
        if(looksLikeGlyphs(draftInk))break
        assert(Date.now()<until,`The resized field must paint the known draft: ${JSON.stringify(draftInk)}`)
      }
      const canvasNegative=await glyphMatch(blank,paintedDraft,{png:resizedDraft,flat:colors['surface-canvas']},0,2,true)
      assert(!looksLikeGlyphs(canvasNegative),'A painted surface-canvas without draft text must fail')
      await page.setViewportSize(viewport)
      return {resized:true,canvas:shown,field,button,viewportBounds,draftInk,canvasNegative,retainedDraft:true,fieldVisible:true,sendReachable:true}
    })
    return evidence
  } finally {await cdp.detach()}
}
