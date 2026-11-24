import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {chromium} from 'playwright'
import {launchFixture} from '../../packages/rune-app/fixtures/fixture-host.mjs'

const graphics=['--enable-unsafe-webgpu','--use-angle=swiftshader']

export function launchChromium(executablePath,env){
  return chromium.launch({headless:true,executablePath,env,args:graphics})
}

export async function launchOwnedChromium({executablePath=chromium.executablePath(),profile,env}){
  const data=path.join(profile,'chromium')
  const host=launchFixture(executablePath,[
    ...graphics,'--headless=new','--disable-background-networking','--disable-component-update',
    '--disable-extensions','--disable-sync','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--user-data-dir=${data}`,
    'about:blank',
  ],{cwd:profile,env})
  let browser
  try{
    const port=await host.ready(()=>host.output().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1])
    const [record,id]=(await readFile(path.join(data,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/)
    assert.equal(record,port)
    assert.match(id,/^\/devtools\/browser\/[a-f\d-]+$/i)
    browser=await chromium.connectOverCDP(`ws://127.0.0.1:${port}${id}`,{timeout:15000})
  }catch(error){
    await host.stop()
    throw error
  }
  return {browser,pid:await host.pid(),async close(){
    try{
      await host.stop(async()=>{const session=await browser.newBrowserCDPSession();await session.send('Browser.close')})
    }finally{await browser.close()}
    return host.child.exitCode===0
  }}
}

export async function activateControl(page,control,{touch=false,rect,timeout}={}){
  if(!touch)return control.click({force:true,timeout})
  const box=rect??await control.boundingBox({timeout})
  assert(box,'Expected a laid-out control')
  await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2)
}

/** Wait until a mirrored Rune control is enabled and its rect stays stable past
 * Rune's deferred web accessibility mirror settle window (#1670, ~150 ms). */
export async function waitSettledControl(page,target,{settleMs=200,timeoutMs=20000,label}={}){
  let previous=null
  let stableSince=0
  let lastState=null
  for(const until=Date.now()+timeoutMs;;){
    const state=await target.evaluateAll(nodes=>{
      if(nodes.length!==1)return {count:nodes.length}
      const el=nodes[0]
      const rect=el.getBoundingClientRect()
      return {
        count:1,connected:el.isConnected,disabled:Boolean(el.disabled),
        ariaDisabled:el.getAttribute('aria-disabled'),
        box:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
      }
    }).catch(()=>null)
    lastState=state
    if(state&&state.count===1&&state.connected&&!state.disabled&&state.ariaDisabled!=='true'&&state.box.width>0&&state.box.height>0){
      const same=previous&&previous.x===state.box.x&&previous.y===state.box.y&&previous.width===state.box.width&&previous.height===state.box.height
      if(same){
        if(Date.now()-stableSince>=settleMs)return state.box
      }else{
        previous=state.box
        stableSince=Date.now()
      }
    }else{
      previous=null
      stableSince=0
    }
    assert(Date.now()<until,label?`Control "${label}" not ready: ${JSON.stringify(lastState)}`:'Control remained unavailable or disabled')
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)))
  }
}
