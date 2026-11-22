// Real Chrome and Android software keyboard on an explicitly owned headless emulator.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {createHash,X509Certificate} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {promisify} from 'node:util'
import {_android} from 'playwright'
import {bundleAssetPaths,workspacePolicy,fulfillWorkspaceCreation} from './web-workspace-policy.mjs'
import {command,mobileLive,navigatePair} from './web-live.mjs'

const [origin,profile,project,bundle]=process.argv.slice(2)
const {RUNE_ANDROID_ADB:adb,RUNE_ANDROID_SERIAL:serial,RUNE_ANDROID_ADB_PORT:port}=process.env
assert(adb&&path.isAbsolute(adb)&&/^emulator-\d+$/.test(serial)&&Number(port)>1024)
assert(Number(port)!==5037,'Use a dedicated ADB server for the disposable emulator')
assert.match(origin,/^https:\/\/127\.0\.0\.1:\d+$/)
assert(process.send&&path.basename(profile).startsWith('launcher-'))
const auth=new X509Certificate(await readFile(path.join(profile,'identity.data/tls/server-cert.pem')))
const pin=createHash('sha256').update(auth.publicKey.export({type:'spki',format:'der'})).digest('base64')
const messages=JSON.parse(await readFile(new URL('../../crates/rune-theme-codenomad/assets/catalogues/fr.json',import.meta.url),'utf8'))
const run=(...args)=>promisify(execFile)(adb,['-P',port,'-s',serial,...args],{timeout:15000,windowsHide:true})
const [device,...others]=await _android.devices({port:Number(port),omitDriverInstall:true})
assert(device?.serial()===serial&&!others.length,'Use a dedicated ADB server with the single named emulator')
const target=`tcp:${new URL(origin).port}`
let context, page, cdp
const metrics=page=>page.evaluate(()=>({height:visualViewport.height,layout:innerHeight,
  canvas:document.querySelector('canvas')?.getBoundingClientRect().height,
  dpr:devicePixelRatio,mobile:navigator.userAgentData?.mobile,ua:navigator.userAgent,
  active:document.activeElement?.tagName,inputMode:document.activeElement?.inputMode}))
try {
  await run('reverse',target,target)
  await run('shell','am','set-debug-app','--persistent','com.android.chrome')
  context=await device.launchBrowser({noDefaultViewport:true,
    args:[`--ignore-certificate-errors-spki-list=${pin}`,'--disable-background-networking']})
  page=context.pages()[0]??await context.newPage()
  page.setDefaultTimeout(20000)
  const link=new URL(await command('pair'))
  assert.equal(link.origin,origin)
  link.searchParams.set('locale','fr')
  await navigatePair(page,link)
  const assets=await bundleAssetPaths(bundle); assets.add('/remote-pair')
  const policy=workspacePolicy({origin,project,assets})
  const forbidden=[], errors=[]
  let events=0
  page.on('pageerror',error=>errors.push(error.message))
  page.on('response',response=>{
    if(response.url().startsWith(`${origin}/api/events?`)&&response.status()===200&&response.request().resourceType()==='eventsource')events++
  })
  await page.route('**/*',async route=>{
    const req=route.request(),p=new URL(req.url()).pathname
    if(!await policy.request(req)){forbidden.push(p);return route.abort()}
    if(req.method()==='POST'&&p==='/api/workspaces'){
      try{return await fulfillWorkspaceCreation(route,policy)}
      catch{errors.push('Private workspace response was refused before delivery');return route.abort()}
    }
    return route.continue()
  })
  const url=new URL('/?locale=fr',origin)
  await page.goto(url.href,{waitUntil:'domcontentloaded'})
  await page.waitForFunction(()=>globalThis.__codenomadRuneBoot?.state==='ready',undefined,{timeout:60000})
  cdp=await context.newCDPSession(page)
  const tap=async(x,y)=>{
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]})
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
  }
  const hit=async locator=>{const box=await locator.boundingBox();assert(box);await tap(box.x+box.width/2,box.y+box.height/2)}
  const button=name=>page.getByRole('button',{name,exact:true})
  await hit(button(messages['folderSelection.servers.dialog.connect']))
  await hit(button(project))
  await hit(button('Existing history'))
  await page.getByText(messages['rune.ready'],{exact:true}).waitFor()
  await page.getByText('Existing answer',{exact:true}).waitFor()
  const group=page.getByRole('group',{name:messages['rune.prompt'],exact:true})
  const viewport=()=>metrics(page)
  const hierarchy='/data/local/tmp/codenomad-rune-web.xml'
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
  const first=await group.boundingBox();assert(first)
  await run('shell','input','tap',String(Math.round(Number(content[1])+(first.x+first.width/2)*before.dpr)),
    String(Math.round(Number(content[2])+(first.y+first.height/2)*before.dpr)))
  const editor=page.locator('textarea:focus')
  await editor.waitFor()
  await page.waitForFunction(height=>visualViewport.height<height-100,before.height)
  await page.waitForFunction(()=>Math.abs(document.querySelector('canvas').getBoundingClientRect().height-visualViewport.height)<1)
  const keyboard=await viewport()
  assert.match((await run('shell','dumpsys','input_method')).stdout,/mInputShown=true/)
  const send=await button(messages['promptInput.overlay.send']).boundingBox()
  assert(send&&send.y+send.height<=keyboard.height+1)
  await cdp.send('Input.imeSetComposition',{text:'かな',selectionStart:2,selectionEnd:2})
  await cdp.send('Input.insertText',{text:'仮名'})
  assert.equal(await editor.inputValue(),'仮名')
  await page.screenshot({path:path.join(profile,'android-ime.png')})
  await device.screenshot({path:path.join(profile,'android-gboard.png')})
  await run('shell','input','keyevent','KEYCODE_BACK')
  await page.waitForFunction(height=>visualViewport.height>=height-1,before.height)
  await hit(group)
  assert.equal(await editor.inputValue(),'仮名')
  await run('shell','input','keyevent','KEYCODE_BACK')
  await page.waitForFunction(height=>visualViewport.height>=height-1,before.height)
  const live=await mobileLive({page,context,url,messages,revoke:false,eventSources:()=>events,tap})
  assert.deepEqual(forbidden,[])
  assert.deepEqual(errors,[])
  await writeFile(path.join(profile,'android-proof.json'),JSON.stringify({before,keyboard,live},null,2))
} catch(error) {
  await page?.screenshot({path:path.join(profile,'android-failure.png')}).catch(()=>{})
  if(page)await writeFile(path.join(profile,'android-failure.json'),JSON.stringify({
    viewport:await metrics(page).catch(()=>null),ime:(await run('shell','dumpsys','input_method')).stdout.split('\n')
      .filter(line=>/mInputShown|mShowRequested|mCurFocusedWindow|mCurAttribute|mCurMethodId/.test(line))},null,2))
  throw error
} finally {
  await cdp?.detach().catch(()=>{})
  await context?.close().catch(()=>{})
  await run('shell','am','force-stop','com.android.chrome').catch(()=>{})
  await run('shell','am','clear-debug-app').catch(()=>{})
  await run('shell','rm','-f','/data/local/tmp/codenomad-rune-web.xml').catch(()=>{})
  await run('reverse','--remove',target).catch(()=>{})
  await device.close()
}
