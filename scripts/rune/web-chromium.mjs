import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {createAttestedTcpRelay,originGuardProxy,resolveWorktreePackage} from '../native-fixture-http.mjs'
import {launchFixture,until} from '../../packages/rune-app/fixtures/fixture-host.mjs'

const {chromium}=await import(resolveWorktreePackage('playwright'))
const graphics=['--enable-unsafe-webgpu','--use-angle=swiftshader']

export function launchChromium(executablePath,env){
  return chromium.launch({headless:true,executablePath,env,args:graphics})
}

export async function launchOwnedChromium({executablePath=chromium.executablePath(),profile,env,origin,targetPid}){
  const data=path.join(profile,'chromium')
  const guard=origin?await originGuardProxy(new URL(origin).origin,targetPid):null
  const networkArgs=guard?[
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    `--proxy-server=http://127.0.0.1:${guard.port}`,
    '--proxy-bypass-list=<-loopback>',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ]:[]
  let host,browser,pid,cdpRelay
  try{
    host=launchFixture(executablePath,[
      ...graphics,...networkArgs,'--headless=new','--disable-background-networking','--disable-component-update',
      '--disable-extensions','--disable-sync','--no-first-run','--no-default-browser-check',
      '--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--user-data-dir=${data}`,
      'about:blank',
    ],{cwd:profile,env})
    const port=await host.ready(()=>host.output().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1])
    const id=await until(async()=>{
      try{
        const [record,wsPath]=(await readFile(path.join(data,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/)
        if(record===port&&/^\/devtools\/browser\/[a-f\d-]+$/i.test(wsPath))return wsPath
      }catch{}
      return null
    },'DevToolsActivePort matching announced port',15000)
    pid=await host.pid()
    cdpRelay=await createAttestedTcpRelay(Number(port),pid,{requireClientAttestation:true,allowedClientPids:[process.pid]})
    browser=await chromium.connectOverCDP(`ws://127.0.0.1:${cdpRelay.port}${id}`,{timeout:15000})
  }catch(error){
    try{await browser?.close()}catch{}
    try{await cdpRelay?.close()}catch{}
    try{await host?.stop()}finally{await guard?.close()}
    throw error
  }
  return {browser,pid,async close(){
    try{
      try{
        await host.stop(async()=>{const session=await browser.newBrowserCDPSession();await session.send('Browser.close')})
      }finally{
        try{await browser.close()}finally{await cdpRelay?.close()}
      }
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
