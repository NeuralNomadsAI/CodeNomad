// Real Chrome and Android software keyboard on an explicitly owned headless emulator.
import assert from 'node:assert/strict'
import {createHash,X509Certificate} from 'node:crypto'
import {readFile,readdir,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {_android} from 'playwright'
import {createAttestedFetch,verifyLoopbackListenerOwner,verifyPrivateFixtureServer} from '../native-fixture-http.mjs'
import {androidDevice,hierarchy} from '../../packages/rune-app/fixtures/android-device.mjs'
import {bundleAssetPaths,workspacePolicy} from './web-workspace-policy.mjs'
import {command,navigatePair} from './web-live.mjs'
import {androidLive,androidPrompt} from './web-android-contract.mjs'
import {chromeMemory,scrollMeasure} from './web-android-metrics.mjs'
import {observeRenderer,traceSwipe} from './web-android-trace.mjs'
import {observeGpu,gpuState,chromeGraphicsReport,observeBoot,bootActivity} from './web-android-gpu.mjs'

const root=fileURLToPath(new URL('../../',import.meta.url))
const [origin,profile,project,bundle,rawServerPid,rawLauncherPid]=process.argv.slice(2)
const useTs=process.env.RUNE_ANDROID_TS_SERVER==='1'
assert.match(origin,useTs?/^https:\/\/rune-server\.fixture\.test:\d+$/:/^https:\/\/127\.0\.0\.1:\d+$/)
assert(process.send&&path.basename(profile).startsWith('launcher-'))
let currentServerPid=Number(rawServerPid)
const launcherPid=Number(rawLauncherPid)
assert(Number.isSafeInteger(currentServerPid)&&currentServerPid>0,'Android fixture requires owned server PID')
assert(Number.isSafeInteger(launcherPid)&&launcherPid>0,'Android fixture requires private launcher PID')
await verifyLoopbackListenerOwner(Number(new URL(origin).port),currentServerPid)
let currentServerStartId=(await verifyPrivateFixtureServer({targetPid:currentServerPid,launcherPid,profile,root})).targetStartId
const caCert=await readFile(path.join(profile,'identity.data/tls/ca-cert.pem'))
const auth=new X509Certificate(await readFile(path.join(profile,'identity.data/tls/server-cert.pem')))
const pin=createHash('sha256').update(auth.publicKey.export({type:'spki',format:'der'})).digest('base64')
const solid=process.env.RUNE_ANDROID_SOLID_DIR
const comparison=Boolean(process.env.RUNE_ANDROID_COMPARE)
const trace=process.env.RUNE_ANDROID_TRACE
const gpuProbe=process.env.RUNE_ANDROID_GPU_PROBE
const bootControl=process.env.RUNE_ANDROID_BOOT_CONTROL
assert(!bootControl||gpuProbe==='only'&&['cpu-only','no-webgl'].includes(bootControl))
const scrollOnly=process.env.RUNE_ANDROID_SAMPLE==='scroll'
const locale=comparison?'en':'fr'
const messages=JSON.parse(await readFile(new URL(`../../crates/rune-theme-codenomad/assets/catalogues/${locale}.json`,import.meta.url),'utf8'))
const {serial,port,run}=androidDevice(process.env)
let attestedFetch, device, openedDevices=[], context, page, cdp
const evidence={timings:{},memory:{}}
const attestedFulfillWorkspaceCreation=async(route,policy)=>{
  const req=route.request()
  const headers={...(await req.allHeaders())}
  delete headers['host'];delete headers['content-length']
  const res=await attestedFetch(req.url(),{method:req.method(),headers,body:req.postDataBuffer()??undefined,signal:AbortSignal.timeout(30000)})
  const bytes=Buffer.from(await res.arrayBuffer())
  assert(bytes.length<=1048576,'Workspace response exceeds fixture admission bound')
  if(res.ok&&policy)policy.admit(req.postDataJSON(),JSON.parse(bytes.toString('utf8')),req.url())
  const outHeaders=Object.fromEntries(res.headers.entries())
  const setCookies=res.headers.getSetCookie?.()??(outHeaders['set-cookie']?[outHeaders['set-cookie']]:[])
  if(setCookies.length)outHeaders['set-cookie']=setCookies.join('\n')
  await route.fulfill({status:res.status,headers:outHeaders,body:bytes})
  return {status:res.status,admitted:res.ok}
}
const metrics=page=>page.evaluate(()=>({height:visualViewport.height,top:visualViewport.offsetTop,layout:innerHeight,
  canvas:document.querySelector('canvas')?.getBoundingClientRect().height,
  dpr:devicePixelRatio,mobile:navigator.userAgentData?.mobile,ua:navigator.userAgent,
  active:document.activeElement?.tagName,inputMode:document.activeElement?.inputMode}))
async function runAndroid() {
  attestedFetch=createAttestedFetch(origin,Number(new URL(origin).port),currentServerPid,{ca:caCert,targetStartId:currentServerStartId})
  openedDevices=await _android.devices({port:Number(port),omitDriverInstall:true})
  const [matched,...others]=openedDevices
  assert(matched?.serial()===serial&&!others.length,'Use a dedicated ADB server with the single named emulator')
  device=matched
  context=await device.launchBrowser({noDefaultViewport:true,serviceWorkers:'block',
    args:[`--ignore-certificate-errors-spki-list=${pin}`,'--disable-background-networking',
      ...(useTs?['--host-resolver-rules="MAP rune-server.fixture.test 127.0.0.1"']:[]),
      ...(process.env.RUNE_ANDROID_GPU_CHROME_FLAGS?.split(' ').filter(Boolean)??[])]})
  page=context.pages()[0]??await context.newPage()
  const httpErrors=[]
  let events=0
  evidence.httpErrors=httpErrors
  if(solid)page.on('console',msg=>{if(msg.type()==='error'||msg.type()==='warning')httpErrors.push(msg.text().slice(0,300))})
  page.on('requestfailed',req=>{
    if(solid&&req.url().startsWith(origin))httpErrors.push(`${req.failure()?.errorText} ${new URL(req.url()).pathname}`)
  })
  page.on('response',response=>{
    const url=new URL(response.url())
    if(url.origin!==origin)return
    if(solid&&response.status()>=400)httpErrors.push(`${response.status()} ${response.request().method()} ${url.pathname}`)
    if(url.pathname==='/api/events'&&response.ok()&&
      response.headers()['content-type']?.startsWith('text/event-stream'))events++
  })
  const recordCpu=trace==='1',shaderMarks=trace==='stutter'
  if(recordCpu||shaderMarks||gpuProbe)await page.addInitScript(observeRenderer,{recordCpu,shaderMarks})
  if(gpuProbe)await page.addInitScript(observeGpu)
  if(gpuProbe==='only')await page.addInitScript(observeBoot,bootControl)
  const gpuLog=[]
  if(gpuProbe){
    evidence.gpuLog=gpuLog
    page.on('console',msg=>{if(gpuLog.length<50&&/gpu|adapter|vulkan|dawn|webgl|rune:/i.test(msg.text()))gpuLog.push(msg.text())})
  }
  page.setDefaultTimeout(20000)
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.fallback():route.abort())
  cdp=await context.newCDPSession(page)
  if(comparison)await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]})
  await cdp.send('Performance.enable')
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled',{cacheDisabled:true})
  await cdp.send('Network.setBypassServiceWorker',{bypass:true})
  evidence.memory.blank=await chromeMemory(run,cdp)
  const link=new URL(await command('pair'))
  assert.equal(link.origin,origin)
  link.searchParams.set('locale',locale)
  const assets=solid?new Set((await readdir(path.join(solid,'assets'))).map(file=>`/assets/${file}`)):await bundleAssetPaths(bundle)
  assets.add('/remote-pair')
  const start=performance.now()
  await navigatePair(page,link,{fromLink:!useTs,assets,waitForRune:!solid,returnLocale:solid?null:locale})
  const connect=solid?page.locator('.folder-home-root').first():page.getByRole('button',{name:messages['folderSelection.servers.dialog.connect'],exact:true})
  const paint=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  await connect.waitFor()
  await paint()
  evidence.timings.pairingToLauncherMs=performance.now()-start
  evidence.timings.landingNavigationToLauncherMs=await page.evaluate(()=>performance.now())
  evidence.timings.moduleReadyMs=await page.evaluate(()=>globalThis.__codenomadRuneBoot?.moduleReadyMs)
  if(gpuProbe==='only'){
    const first=await gpuState(page)
    const startup=await bootActivity(page)
    assert(startup.wasm.responseEnd>0,'The launcher boot probe must capture the WASM response')
    await page.screenshot({path:path.join(profile,'android-launcher.png')})
    if(bootControl!=='cpu-only'){
      try {
        await page.waitForFunction(()=>performance.getEntriesByType('mark').some(e=>/web\.(gpu\.failed|handover\.(done|failed))$/.test(e.name)),
          undefined,{timeout:15000})
      }catch(error){if(error.name!=='TimeoutError')throw error}
    }
    const state=await gpuState(page,!bootControl)
    const chrome=bootControl?undefined:await chromeGraphicsReport(context,page)
    await writeFile(path.join(profile,'android-gpu.json'),JSON.stringify({...state,first,startup,bootControl,timings:evidence.timings,chrome,gpuLog},null,2))
    return
  }
  if(gpuProbe==='webgl'){
    await page.waitForFunction(()=>performance.getEntriesByName('web.handover.done').length||
      performance.getEntriesByName('web.gpu.failed').length||performance.getEntriesByName('web.handover.failed').length,
      undefined,{timeout:15000})
    evidence.gpu=await gpuState(page)
    assertWebGL(evidence.gpu)
  }
  evidence.memory.launcher=await chromeMemory(run,cdp)
  const policy=workspacePolicy({origin,project,assets,androidPrompt})
  const forbidden=[], errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.route('**/*',async route=>{
    const req=route.request(),p=new URL(req.url()).pathname
    if(solid){
      if(new URL(req.url()).origin!==origin)return route.abort()
      if(req.method()==='POST'&&p==='/api/workspaces'){
        try{return await attestedFulfillWorkspaceCreation(route,null)}
        catch{errors.push('Private workspace response was refused before delivery');return route.abort()}
      }
      return route.continue()
    }
    if(!await policy.request(req)){forbidden.push(p);return route.abort()}
    if(req.method()==='POST'&&p==='/api/workspaces'){
      try{return await attestedFulfillWorkspaceCreation(route,policy)}
      catch{errors.push('Private workspace response was refused before delivery');return route.abort()}
    }
    return route.continue()
  })
  const url=new URL(`/?locale=${locale}`,origin)
  const tap=async(x,y)=>{
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]})
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
  }
  const center=async locator=>{
    await locator.scrollIntoViewIfNeeded()
    const box=await locator.boundingBox();assert(box)
    return [box.x+box.width/2,box.y+box.height/2]
  }
  const hit=async locator=>tap(...await center(locator))
  const button=name=>page.getByRole('button',{name,exact:true})
  const left=messages['window.menu.leftPanel']
  const row=solid?page.locator('.session-item-base[data-session-id="ses_existing"] .session-item-select'):
    page.getByRole('region',{name:left,exact:true}).getByRole('listitem',{name:'Existing history',exact:true})
  if(solid){
    const folder=page.getByRole('button',{name:'This computer',exact:true}).first()
    await folder.click()
    await page.getByRole('option',{name:'synthetic Select'}).getByRole('button',{name:'Select',exact:true}).click()
  }else{
    await hit(connect)
    await hit(button(project))
  }
  if(!await row.isVisible()){
    await button(left).waitFor()
    if(await button(left).getAttribute('aria-expanded')!=='true')await hit(button(left))
  }
  const sessionTarget=await center(row)
  const opened=performance.now()
  await tap(...sessionTarget)
  await page.getByText('Existing answer',{exact:true}).waitFor()
  await paint()
  evidence.timings.selectConversationToAnswerMs=performance.now()-opened
  evidence.memory.conversation=await chromeMemory(run,cdp)
  if(gpuProbe==='webgl')assertWebGL(await gpuState(page))
  const group=solid?page.locator('textarea.prompt-input:visible').first():page.getByRole('group',{name:messages['rune.prompt'],exact:true})
  const viewport=()=>metrics(page)
  const dump=async()=>{
    await run('shell','uiautomator','dump',hierarchy)
    return (await run('shell','cat',hierarchy)).stdout
  }
  let xml=await dump()
  const onboarding=xml.includes('Chrome notifications make things easier')&&
    xml.match(/resource-id="com\.android\.chrome:id\/negative_button"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
  if(onboarding){
    await run('shell','input','tap',String((Number(onboarding[1])+Number(onboarding[3]))/2),
      String((Number(onboarding[2])+Number(onboarding[4]))/2))
    xml=await dump()
  }
  const before=await viewport()
  assert(before.mobile&&before.ua.includes('Android'),'Use the real Android Chrome viewport')
  const content=xml.match(/(?:class="android\.webkit\.WebView"|resource-id="com\.android\.chrome:id\/(?:compositor_view_holder|content_frame)")[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
  if(!content)await writeFile(path.join(profile,'android-view-hierarchy.xml'),xml)
  assert(content,'Find the browser content origin in the Android window')
  const sx=x=>String(Math.round(Number(content[1])+x*before.dpr))
  const sy=y=>String(Math.round(Number(content[2])+y*before.dpr))
  const swipe=()=>run('shell','input','swipe',sx(160),sy(270),sx(160),sy(575),'480')
  const latest=button(solid?'Scroll to latest message':messages['rune.latest'])
  const goLatest=()=>solid?latest.click():hit(latest)
  evidence.scroll=await scrollMeasure(page,swipe,solid?'.message-stream p':undefined)
  await goLatest()
  await page.getByText('Existing answer',{exact:true}).waitFor()
  if(trace) {
    evidence.profiledScroll=await traceSwipe(page,cdp,profile,()=>scrollMeasure(page,swipe,solid?'.message-stream p':undefined),trace)
    await goLatest()
    await page.getByText('Existing answer',{exact:true}).waitFor()
  }
  if(scrollOnly){
    if(gpuProbe==='webgl'){
      evidence.gpuAfterScroll=await gpuState(page)
      assertWebGL(evidence.gpuAfterScroll)
    }
    assert.deepEqual(forbidden,[])
    assert.deepEqual(errors,[])
    await writeFile(path.join(profile,'android-proof.json'),JSON.stringify({before,...evidence},null,2))
    return
  }
  const tapComposer=async()=>{
    const field=await group.boundingBox();assert(field)
    const {point}=evidence.scroll
    await run('shell','input','tap',sx(field.x+field.width/2+160-point.x),
      sy(field.y+field.height/2+270-point.y))
  }
  await tapComposer()
  const editor=page.locator('textarea:focus')
  await editor.waitFor()
  await page.waitForFunction(height=>visualViewport.height<height-100,before.height)
  if(!solid)await page.waitForFunction(()=>Math.abs(document.querySelector('canvas').getBoundingClientRect().height-visualViewport.height)<1)
  await paint()
  const keyboard=await viewport()
  const ime=(await run('shell','settings','get','secure','default_input_method')).stdout.trim()
  const sendButton=button(solid?'Send message':messages['promptInput.overlay.send'])
  const send=await sendButton.boundingBox()
  assert(send)
  evidence.sendVisibleWithKeyboard=send.y>=keyboard.top-1&&send.y+send.height<=keyboard.top+keyboard.height+1
  if(!solid)assert(evidence.sendVisibleWithKeyboard,'Rune Send must stay in the reduced viewport')
  if(comparison)await cdp.send('Input.insertText',{text:androidPrompt})
  else {
    await cdp.send('Input.insertText',{text:androidPrompt.slice(0,-2)})
    await cdp.send('Input.imeSetComposition',{text:'かな',selectionStart:2,selectionEnd:2})
    await cdp.send('Input.insertText',{text:'仮名'})
  }
  assert.equal(await editor.inputValue(),androidPrompt)
  await page.screenshot({path:path.join(profile,'android-ime.png')})
  await device.screenshot({path:path.join(profile,'android-gboard.png')})
  await run('shell','input','keyevent','KEYCODE_BACK')
  await page.waitForFunction(height=>visualViewport.height>=height-1,before.height)
  if(!await editor.count())await tapComposer()
  assert.equal(await editor.inputValue(),androidPrompt)
  evidence.memory.beforeSend=await chromeMemory(run,cdp)
  const outgoing=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/session/ses_existing/prompt'))
  void outgoing.catch(()=>{})
  const sendTarget=await center(sendButton)
  const sent=performance.now()
  await tap(...sendTarget)
  const accepted=await outgoing
  assert(accepted.ok(),`Android prompt admission returned ${accepted.status()}`)
  const live=evidence.live={promptAccepted:accepted.status()}
  await page.getByText(androidLive,{exact:true}).waitFor()
  await paint()
  live.liveOnlyBeforeCut=true
  evidence.timings.sendToLiveReplyMs=performance.now()-sent
  const documentStarted=await page.evaluate(()=>performance.timeOrigin)
  const cut=performance.now()
  await command('cut')
  const connecting=solid?page.getByText(messages['instanceShell.connection.connecting'],{exact:true}):page.getByRole('img',{name:messages['instanceShell.connection.connecting'],exact:true})
  const recovering=solid?page.getByText(messages['instanceShell.connection.disconnected'],{exact:true}).or(connecting).first():connecting
  if(!comparison)await recovering.waitFor()
  const resume=performance.now()
  await command('resume')
  await page.getByText('Mobile recovered history',{exact:true}).waitFor()
  await recovering.waitFor({state:'hidden'})
  await paint()
  live.recovered=true
  evidence.timings.cutToRecoveryMs=performance.now()-cut
  evidence.timings.releaseToRecoveredHistoryMs=performance.now()-resume
  evidence.memory.afterCut=await chromeMemory(run,cdp)
  assert(events>0)
  const previous=[...policy.workspaces],beforeRestart=events,restart=performance.now()
  evidence.restart=await command('restart')
  const restartedPid=Number(evidence.restart?.serverPid)
  assert(Number.isSafeInteger(restartedPid)&&restartedPid>0,'Restarted Android fixture must report owned server PID')
  await verifyLoopbackListenerOwner(Number(new URL(origin).port),restartedPid)
  const restartedStartId=(await verifyPrivateFixtureServer({targetPid:restartedPid,launcherPid,profile,root})).targetStartId
  const previousFetch=attestedFetch
  currentServerPid=restartedPid
  currentServerStartId=restartedStartId
  attestedFetch=createAttestedFetch(origin,Number(new URL(origin).port),currentServerPid,{ca:caCert,targetStartId:currentServerStartId})
  await previousFetch?.close().catch(()=>{})
  try { await page.getByText('Mobile Rust restart history',{exact:true}).waitFor({timeout:45000}) }
  catch(error){evidence.restartWaitMs=performance.now()-restart;throw error}
  await recovering.waitFor({state:'hidden'})
  await paint()
  evidence.timings.rustRestartToHistoryMs=performance.now()-restart
  const fresh=[...policy.workspaces].filter(id=>!previous.includes(id))
  if(!solid)assert.equal(fresh.length,1)
  assert(events>beforeRestart)
  if(!solid)assert.equal(page.url(),url.href)
  assert.equal(await page.evaluate(()=>performance.timeOrigin),documentStarted,'Recovery must preserve the browser document')
  evidence.memory.recovered=await chromeMemory(run,cdp)
  live.recoveredAfterRustRestart=true
  if(gpuProbe==='webgl'){
    evidence.gpuAfterRecovery=await gpuState(page)
    assertWebGL(evidence.gpuAfterRecovery)
  }
  assert.deepEqual(forbidden,[])
  assert.deepEqual(errors,[])
  await writeFile(path.join(profile,'android-proof.json'),JSON.stringify({before,keyboard,ime,...evidence},null,2))
}
function assertWebGL(state) {
  assert(state.contexts?.includes('webgl2')&&!state.contexts.includes('webgpu')&&
    state.marks.some(mark=>mark.name==='web.handover.done')&&
    !state.marks.some(mark=>['web.gpu.lost','web.gpu.failed','web.handover.failed'].includes(mark.name))&&
    state.canvases.filter(canvas=>canvas.opacity==='1'&&canvas.width>300).length===1,
  `Expected a completed WebGL2 handover without CPU fallback: ${JSON.stringify(state)}`)
}
try {
  await runAndroid()
} catch(error) {
  if(page&&solid)await writeFile(path.join(profile,'android-failure-aria.txt'),await page.locator('body').ariaSnapshot({timeout:2000}).catch(()=>''),'utf8')
  await page?.screenshot({path:path.join(profile,'android-failure.png'),timeout:3000}).catch(()=>{})
  if(page)await writeFile(path.join(profile,'android-failure.json'),JSON.stringify({
    ...evidence,viewport:await metrics(page).catch(()=>null),ime:(await run('shell','dumpsys','-t','2','input_method').catch(()=>({stdout:''}))).stdout
      .split('\n').filter(line=>/mInputShown|mShowRequested|mCurFocusedWindow|mCurAttribute|mCurMethodId/.test(line))},null,2))
  throw error
} finally {
  await attestedFetch?.close().catch(()=>{})
  await cdp?.detach().catch(()=>{})
  await context?.close().catch(()=>{})
  for(const opened of openedDevices){await opened?.close().catch(()=>{})}
}
