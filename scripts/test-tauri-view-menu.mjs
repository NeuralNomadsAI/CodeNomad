// Windows native popup/focus acceptance. Uses synthetic home/config and no OpenCode CLI.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { stopFixtureChild } from './native-fixture-guards.mjs'
import { boundedFixtureOperation } from './fixtures/wsl-fixture-bounds.mjs'

assert.equal(process.platform, 'win32')
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable=process.argv[2] ?? path.join(repo, 'packages/tauri-app/target/release/codenomad-tauri.exe')
const profile=await mkdtemp(path.join(os.tmpdir(), 'opencode', 'tauri-view-menu-'))
console.log(`Evidence: ${profile}`)
const config=path.join(profile, 'config.yaml')
await writeFile(config, JSON.stringify({server:{opencodeBinary:path.join(profile,'missing-opencode.exe')},ui:{locale:'en'}}))
const env=Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(PATH|OPENCODE_.*|XDG_.*|CLI_.*|CODENOMAD_.*|NODE_.*|ELECTRON_.*|WEBVIEW2_.*|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)))
Object.assign(env, {HOME:profile,USERPROFILE:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),
  XDG_CONFIG_HOME:path.join(profile,'config'),XDG_DATA_HOME:path.join(profile,'data'),XDG_STATE_HOME:path.join(profile,'state'),
  OPENCODE_TEST_HOME:profile,OPENCODE_CONFIG_DIR:path.join(profile,'opencode'),CLI_CONFIG:config,
  CLI_HTTP_PORT:'0',CLI_HTTPS_PORT:'0',CODENOMAD_UPDATE_CHANNEL:'menu-fixture',PATH:`${process.env.SystemRoot}\\System32`})
for(const key of ['APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','OPENCODE_CONFIG_DIR']) await mkdir(env[key],{recursive:true})
async function until(fn, message, timeout=15000) {
  const end=Date.now()+timeout
  while(Date.now()<end) { const value=await fn(); if(value) return value; await delay(100) }
  throw Error(message)
}
async function findPort(dir) {
  for(const e of await readdir(dir,{withFileTypes:true}).catch(()=>[])) {
    const file=path.join(dir,e.name)
    if(e.name==='DevToolsActivePort') return +(await readFile(file,'utf8')).split(/\r?\n/)[0]
    if(e.isDirectory()) { const value=await findPort(file); if(value) return value }
  }
}
const child=spawn(executable,[],{cwd:profile,env,stdio:['ignore','pipe','pipe']})
const stopped=new Promise(resolve=>child.once('exit',resolve))
let output='',browser
child.stdout.on('data',c=>{output=(output+c).slice(-1024*1024)})
child.stderr.on('data',c=>{output=(output+c).slice(-1024*1024)})
const native=(action='snapshot',handle=0,index=0,menuHandle=0)=>JSON.parse(execFileSync('pwsh',[
  '-NoProfile','-File',path.join(repo,'scripts/fixtures/tauri-menu-windows.ps1'),'-OwnerPid',String(child.pid),
  '-Action',action,'-Handle',String(handle),'-Index',String(index),'-MenuHandle',String(menuHandle)],{encoding:'utf8',timeout:8000,windowsHide:true}))
const checks=[]
try {
  await boundedFixtureOperation(async () => {
  const port=await until(()=>findPort(profile),'Dynamic CDP unavailable',60000)
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:10000})
  const page=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>/^http:\/\/127\.0\.0\.1:/.test(p.url())),'Fixture backend unavailable',60000)
  page.setDefaultTimeout(10000)
  const fixtureUrl=new URL('/menu-fixture',page.url()).href
  await page.route(fixtureUrl,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Native menu fixture</title><h1>Isolated native menu regression</h1>'}))
  await page.goto(fixtureUrl)
  await page.waitForFunction(()=>Boolean(window.__TAURI__?.core))
  const local=await until(()=>native().windows.find(w=>w.title==='CodeNomad'),'Local fixture window unavailable')
  native('focus',local.handle)
  // Same-origin fixture uses the real native IPC and event dispatcher, with no sessions.
  await page.evaluate(async()=>{
    window.fixtureActions=[]
    await window.__TAURI__.event.listen('menu:action',event=>window.fixtureActions.push(event.payload))
  })
  const publish=checked=>page.evaluate(checked=>window.__TAURI__.core.invoke('set_workspace_menu_enabled',{
    enabled:true,viewState:Object.fromEntries(['leftPanel','rightPanel','timeline','timelineTools'].map(key=>[key,{label:`fixture-${key}`,checked,enabled:true}]))
  }),checked)
  const popup=async()=>{
    await page.evaluate(()=>{window.fixturePopupError=null;window.fixturePopup=window.__TAURI__.core.invoke('popup_titlebar_menu',{menu:'view',x:100,y:50});window.fixturePopup.catch(error=>{window.fixturePopupError=String(error)})})
    return until(async()=>{const error=await page.evaluate(()=>window.fixturePopupError);assert.equal(error,null);const result=native();return result.menus.length ? result : null},'Native popup did not open')
  }
  await publish(true)
  console.log('Opening initial native popup')
  let result=await popup()
  const retainedMenu=result.menus[0].menuHandle
  assert.equal(result.menus[0].items.filter(i=>i.text.startsWith('fixture-')&&i.checked&&i.enabled).length,4)
  await publish(false)
  console.log('Published deferred state')
  assert.equal(native().menus[0].items.filter(i=>i.text.startsWith('fixture-')&&i.checked).length,4,'updates during tracking are deferred')
  const nested=await page.evaluate(()=>window.__TAURI__.core.invoke('popup_titlebar_menu',{menu:'file',x:100,y:50}).then(()=>null,error=>String(error)))
  assert.match(nested,/already open/)
  console.log('Nested popup rejected')
  native('dismiss')
  await page.evaluate(()=>window.fixturePopup)
  console.log('Initial popup dismissed')
  result=native('snapshot',local.handle,0,retainedMenu)
  assert.equal(result.menus[0].items.filter(i=>i.text.startsWith('fixture-')&&!i.checked&&i.enabled).length,4,'latest snapshot applies after tracking')
  checks.push('native state, deferred reentrant publication, nested-popup rejection and trailing refresh')
  await page.evaluate(()=>{
    window.concurrentResults=[]
    window.concurrentPopups=[0,1].map(i=>window.__TAURI__.core.invoke('popup_titlebar_menu',{menu:'view',x:100,y:50})
      .then(()=>window.concurrentResults.push({i,ok:true}),error=>window.concurrentResults.push({i,error:String(error)})))
  })
  await until(()=>page.evaluate(()=>window.concurrentResults.some(r=>r.error?.includes('already open'))),'Concurrent popup was not rejected')
  assert.equal(native().menus.length,1)
  native('dismiss')
  await page.evaluate(()=>Promise.all(window.concurrentPopups))
  assert.equal(native().menus.length,0,'rejected request must not open a delayed popup')
  assert.equal(await page.evaluate(()=>window.concurrentResults.filter(r=>r.ok).length),1)
  checks.push('concurrent popup admission rejects overlap without a delayed second popup')
  // Concurrent async popup requests and native focus changes exercise worker/UI scheduling.
  await page.evaluate(()=>window.__TAURI__.core.invoke('open_preferences_window',{request:{section:'general'}}))
  console.log('Opened second fixture window')
  const second=await until(()=>native().windows.find(w=>w.title && w.handle!==local.handle),'Second fixture window unavailable')
  for(let i=0;i<8;i++) {
    console.log(`Focus cycle ${i+1}`)
    await publish(i%2===0)
    assert.equal(native('focus',local.handle).foreground,local.handle)
    result=await popup()
    assert.equal(result.foreground,local.handle)
    assert.equal(native('focus',second.handle).foreground,second.handle)
    native('dismiss')
    await page.evaluate(()=>window.fixturePopup)
    assert.equal(native('focus',local.handle).foreground,local.handle)
    await page.evaluate(()=>window.__TAURI__.core.invoke('cli_get_status'))
  }
  checks.push('8 async popup/focus cycles complete with native IPC heartbeat')
  await publish(false)
  result=await popup()
  assert.equal(result.menus[0].items.filter(i=>i.text.startsWith('fixture-')&&!i.checked&&i.enabled).length,4)
  native('select',0,0)
  await until(()=>page.evaluate(()=>window.fixtureActions.includes('view-left-panel')),'Native click did not dispatch to local renderer')
  await page.evaluate(()=>window.fixturePopup)
  checks.push('native selection dispatches view-left-panel to original renderer')
  await page.screenshot({path:path.join(profile,'final.png')})
  await writeFile(path.join(profile,'result.json'),JSON.stringify({executable,checks},null,2))
  console.log(JSON.stringify({checks},null,2))
  }, Date.now()+120000, 'Tauri native menu acceptance')
} finally {
  await browser?.close().catch(()=>{})
  await stopFixtureChild(child,stopped)
  await writeFile(path.join(profile,'host.log'),output)
}
