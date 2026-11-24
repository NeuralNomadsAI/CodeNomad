import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {originGuardProxy,resolveWorktreePackage} from '../native-fixture-http.mjs'
import {launchFixture} from '../../packages/rune-app/fixtures/fixture-host.mjs'

const {chromium}=await import(resolveWorktreePackage('playwright'))
const graphics=['--enable-unsafe-webgpu','--use-angle=swiftshader']

export function launchChromium(executablePath,env){
  return chromium.launch({headless:true,executablePath,env,args:graphics})
}

export async function launchOwnedChromium({executablePath=chromium.executablePath(),profile,env,origin}){
  const data=path.join(profile,'chromium')
  const guard=origin?await originGuardProxy(new URL(origin).origin):null
  const networkArgs=guard?[
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    `--proxy-server=http://127.0.0.1:${guard.port}`,
    '--proxy-bypass-list=<-loopback>',
  ]:[]
  let host,browser
  try{
    host=launchFixture(executablePath,[
      ...graphics,...networkArgs,'--headless=new','--disable-background-networking','--disable-component-update',
      '--disable-extensions','--disable-sync','--no-first-run','--no-default-browser-check',
      '--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--user-data-dir=${data}`,
      'about:blank',
    ],{cwd:profile,env})
    const port=await host.ready(()=>host.output().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1])
    const [record,id]=(await readFile(path.join(data,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/)
    assert.equal(record,port)
    assert.match(id,/^\/devtools\/browser\/[a-f\d-]+$/i)
    browser=await chromium.connectOverCDP(`ws://127.0.0.1:${port}${id}`,{timeout:15000})
  }catch(error){
    try{await host?.stop()}finally{await guard?.close()}
    throw error
  }
  return {browser,pid:await host.pid(),async close(){
    try{
      try{
        await host.stop(async()=>{const session=await browser.newBrowserCDPSession();await session.send('Browser.close')})
      }finally{await browser.close()}
    }finally{await guard?.close()}
    return host.child.exitCode===0
  }}
}

export async function activateControl(page,control,{touch=false,rect,timeout}={}){
  if(!touch)return control.click({force:true,timeout})
  const box=rect??await control.boundingBox({timeout})
  assert(box,'Expected a laid-out control')
  await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2)
}
