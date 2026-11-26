// Owned loopback-only headless browser over the separate test-support WASM fixture.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {copyFile,mkdir,readFile,readdir,stat,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {themeCss} from '../web-shell.mjs'

const root=path.resolve(import.meta.dirname,'../../..')
const {values}=parseArgs({options:{wasm:{type:'string'},bindgen:{type:'string'},rune:{type:'string'},executable:{type:'string'},out:{type:'string',default:'target/web-focus-candidate/dom'}}})
for(const name of ['wasm','bindgen','rune','executable'])assert(values[name]&&path.isAbsolute(values[name]),`Explicit absolute --${name} required`)
const out=path.resolve(root,values.out),relative=path.relative(path.join(root,'target'),out)
assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Output belongs to this worktree target')
const wasm=await readFile(values.wasm),lock=await readFile(path.join(root,'Cargo.lock'),'utf8')
assert(wasm.includes(Buffer.from('Rune web focus fixture')),'Use the separate test-support focus fixture')
const version=lock.split('[[package]]').find(block=>/^\s*name = "wasm-bindgen"\s*$/m.test(block)).match(/^version = "([^"]+)"/m)[1]
async function run(binary,args){return await new Promise((resolve,reject)=>{const child=spawn(binary,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;if(output.length>1024*1024)child.kill()});child.once('error',reject);child.once('close',code=>code===0?resolve(output.trim()):reject(Error(`${binary} exit ${code}: ${output.slice(-4000)}`)))})}
assert.equal(await run(values.bindgen,['--version']),`wasm-bindgen ${version}`)
await mkdir(out,{recursive:true})
const bundle=path.join(out,'bundle');await mkdir(bundle,{recursive:true})
await run(values.bindgen,['--target','web','--out-dir',bundle,'--out-name','app',values.wasm])
for(const name of ['Inter-Regular.ttf','Inter-Medium.ttf','Inter-SemiBold.ttf'])await copyFile(path.join(values.rune,'assets/web',name),path.join(bundle,name))
await writeFile(path.join(bundle,'theme.css'),themeCss(JSON.parse(await readFile(path.join(root,'crates/rune-theme-codenomad/assets/theme.json'),'utf8'))))
await writeFile(path.join(bundle,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style><body><script type="module">import init from "/app.js";await init();globalThis.focusFixtureReady=true;</script></body></html>')
const allowed=new Set()
for(const name of await readdir(bundle,{recursive:true}))if((await stat(path.join(bundle,name))).isFile())allowed.add(name.replaceAll('\\','/'))
const server=createServer(async(req,res)=>{try{const name=new URL(req.url,'http://fixture').pathname.slice(1)||'index.html';if(name==='favicon.ico'){res.writeHead(204);res.end();return}if(!allowed.has(name)){res.writeHead(404);res.end();return}const bytes=await readFile(path.join(bundle,name));res.writeHead(200,{'content-type':name.endsWith('.wasm')?'application/wasm':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.ttf')?'font/ttf':'text/html'});res.end(bytes)}catch{res.writeHead(500);res.end()}})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const origin=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({headless:true,executablePath:values.executable,args:['--enable-unsafe-webgpu','--use-angle=swiftshader']})
const proof={browser:browser.version(),executable:values.executable,bindgen:values.bindgen,bindgenVersion:version,wasm:values.wasm,sha256:createHash('sha256').update(wasm).digest('hex'),contexts:[],failures:[]}
try{
 for(const scheme of ['light','dark']){
  const context=await browser.newContext({viewport:{width:1000,height:800},colorScheme:scheme})
  const page=await context.newPage();page.setDefaultTimeout(15000)
  const record={scheme,cases:[],events:[],errors:[],forbidden:[]};proof.contexts.push(record)
  page.on('pageerror',error=>record.errors.push(error.message))
  await context.route('**/*',route=>{const address=new URL(route.request().url());if(address.origin!==origin||(!allowed.has(address.pathname.slice(1))&&!['/','/favicon.ico'].includes(address.pathname))){record.forbidden.push(address.href);return route.abort()}return route.continue()})
  await page.addInitScript(()=>{globalThis.fixtureEvents=[];for(const name of ['keydown','keyup','click','focusin'])document.addEventListener(name,event=>{globalThis.fixtureEvents.push({name,key:event.key,trusted:event.isTrusted,detail:event.detail,target:event.target?.textContent?.slice(0,45),tag:event.target?.tagName});if(globalThis.fixtureEvents.length>1000)globalThis.fixtureEvents.shift()},true)})
  const button=name=>page.getByRole('button',{name,exact:true})
  const active=()=>page.evaluate(()=>{const key=(document.querySelector('[data-rune-a11y]')?.textContent??'').match(/focus-key=([^;]+);/)?.[1];return({'field':'Default field','action':'Action','tx-action':'Action with Tx','close':'Shared close','submit-field':'Submit field','default':'Default action','open-modal':'Open modal','reset':'Reset receipts','destination':'Destination','modal':'Fixture modal','modal-action':'Modal action','modal-default':'Modal default','dismiss-modal':'Dismiss modal','fixture-menu:trigger':'Fixture menu','fixture-menu:menu':'Fixture menu surface','fixture-menu:item:open':'Open','fixture-menu:item:last':'Last'})[key]??key??null})
  const mirror=()=>page.evaluate(()=>{const c=document.querySelector('canvas[role="application"]')??document.querySelector('canvas[aria-activedescendant]'),id=c?.getAttribute('aria-activedescendant'),el=id&&document.getElementById(id);return el?{role:el.getAttribute('role'),label:el.getAttribute('aria-label')}:null})
  const expectMirror=async(role,label)=>{for(let n=0;n<40;n++){const m=await mirror();if(m&&m.role===role&&m.label===label)return;await page.waitForTimeout(30)}assert.deepEqual(await mirror(),{role,label})}
  const expectFocus=async name=>{for(let n=0;n<40;n++){if(await active()===name)return;await page.waitForTimeout(30)}assert.equal(await active(),name)}
  const focus=async name=>{await page.locator('canvas').first().focus();for(let n=0;n<24;n++){record.focusTrace??=[];record.focusTrace.push(await page.evaluate(()=>{const c=document.querySelector('canvas'),id=c?.getAttribute('aria-activedescendant'),p=id&&document.getElementById(id);return{tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label'),id,proxyRole:p?.getAttribute('role'),proxyLabel:p?.getAttribute('aria-label')}}));if(await active()===name)return;await page.keyboard.press('Tab');await page.waitForTimeout(60)}throw Error(`Rune keyboard focus failed: ${name}, active=${await active()}`)}
  const field=focus
  const receipts=async()=>page.evaluate(()=>{const text=document.querySelector('[data-rune-a11y]')?.textContent??'';const found=text.match(/receipts actions=(\d+) closes=(\d+) defaults=(\d+) submits=(\d+) modal_actions=(\d+) modal_defaults=(\d+)/);if(!found)return null;return Object.fromEntries(['actions','closes','defaults','submits','modal_actions','modal_defaults'].map((key,i)=>[key,Number(found[i+1])]))})
  const expect=async expected=>{await page.waitForFunction(expected=>{const text=document.querySelector('[data-rune-a11y]')?.textContent??'';const found=text.match(/receipts actions=(\d+) closes=(\d+) defaults=(\d+) submits=(\d+) modal_actions=(\d+) modal_defaults=(\d+)/);return found&&['actions','closes','defaults','submits','modal_actions','modal_defaults'].every((key,i)=>Number(found[i+1])===(expected[key]??0))},expected);assert.deepEqual(await receipts(),{actions:0,closes:0,defaults:0,submits:0,modal_actions:0,modal_defaults:0,...expected})}
  const reset=async()=>{await button('Reset receipts').click({force:true});await expect({})}
  const sample=async(name,fn)=>{await reset();await fn();record.cases.push({name,receipts:await receipts(),active:await page.evaluate(()=>({tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label'),text:document.activeElement?.textContent}))});console.log(`PASS ${scheme} ${name}`)}
  try{
   await page.goto(origin,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>globalThis.focusFixtureReady&&document.querySelector('[data-rune-a11y] button'),undefined,{timeout:60000})
   record.initialAria=await page.locator('body').ariaSnapshot()
   record.fields=await page.locator('input,textarea,[role="textbox"]').evaluateAll(nodes=>nodes.map(el=>({tag:el.tagName,label:el.getAttribute('aria-label'),role:el.getAttribute('role'),placeholder:el.getAttribute('placeholder')})))
   await sample('Enter-action-once',async()=>{await focus('Action');await page.keyboard.press('Enter');await expect({actions:1});await page.waitForTimeout(120);await expect({actions:1})})
   await sample('Enter-close-once',async()=>{await focus('Shared close');await page.keyboard.press('Enter');await expect({closes:1});await page.waitForTimeout(120);await expect({closes:1})})
   await sample('mirror-Enter-once',async()=>{await button('Action').focus();await page.keyboard.press('Enter');await expect({actions:1});await page.waitForTimeout(120);await expect({actions:1})})
   await sample('Shift-Enter-close',async()=>{await focus('Shared close');await page.keyboard.press('Shift+Enter');await expect({closes:1})})
   for(const modifier of ['Control','Alt','Meta'])await sample(`${modifier}-Enter-close-refused`,async()=>{await focus('Shared close');await page.keyboard.press(`${modifier}+Enter`);await page.waitForTimeout(120);await expect({})})
   await sample('Enter-pressed-before-default',async()=>{await focus('Action');await page.keyboard.press('Enter');await expect({actions:1})})
   await sample('field-default',async()=>{await field('Default field');await page.keyboard.press('Enter');await expect({defaults:1})})
   await sample('field-submit-before-default',async()=>{await field('Submit field');await page.keyboard.press('Enter');await expect({submits:1})})
   await sample('Tab-and-disabled',async()=>{await field('Default field');await page.keyboard.press('Tab');await page.waitForTimeout(30);assert.equal(await active(),'Action');await page.keyboard.press('Tab');await page.waitForTimeout(30);assert.equal(await active(),'Action with Tx');await page.keyboard.press('Tab');await page.waitForTimeout(30);assert.equal(await active(),'Shared close');await expect({})})
   await sample('pointer-once-and-next-Tab',async()=>{await button('Action').click({force:true});await expect({actions:1});assert.equal(await active(),'Action');await page.keyboard.press('Tab');await page.waitForTimeout(30);assert.equal(await active(),'Action with Tx')})
   await sample('Tx-focus-destination',async()=>{await focus('Action with Tx');await page.keyboard.press('Enter');await expect({actions:1});await expectFocus('Destination')})
   await sample('modal-default-confined',async()=>{await button('Open modal').click({force:true});await page.getByRole('dialog',{name:'Fixture modal'}).waitFor({state:'attached'});await expectFocus('Fixture modal');await page.keyboard.press('Enter');await expect({modal_defaults:1});await page.keyboard.press('Tab');await expectFocus('Modal action');await page.keyboard.press('Enter');await expect({modal_defaults:1,modal_actions:1});await button('Dismiss modal').click({force:true});await page.getByRole('dialog',{name:'Fixture modal'}).waitFor({state:'detached'})})
   await sample('menu-pointer-container-entry',async()=>{const box=await button('Fixture menu').boundingBox();assert(box,'Fixture menu trigger box');await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await page.getByRole('menu',{name:'Fixture menu'}).waitFor({state:'attached'});await expectMirror('group','Fixture menu');await page.keyboard.press('l');await expectMirror('menuitem','Last');await page.keyboard.press('Home');await expectMirror('menuitem','Open');await page.keyboard.press('End');await expectMirror('menuitem','Last');await page.keyboard.press('Escape');await expectFocus('Fixture menu')})
   await sample('menu-mirror-Enter-first-item',async()=>{await button('Fixture menu').focus();await page.keyboard.press('Enter');await expectMirror('menuitem','Open');await page.locator('canvas[role="application"]').focus();await page.keyboard.press('Escape');await expectFocus('Fixture menu')})
   await sample('Space-phase-witness',async()=>{await focus('Action');await page.keyboard.down('Space');await expect({actions:1});const down=await receipts();await page.keyboard.up('Space');await page.waitForTimeout(120);await expect({actions:1});record.cases.push({name:'Space-source-gap',down,up:await receipts(),sourceDown:0,sourceUp:1})})
   await sample('Enter-repeat-witness',async()=>{await focus('Action');await page.keyboard.down('Enter');await page.keyboard.down('Enter');await page.keyboard.down('Enter');await page.keyboard.up('Enter');await page.waitForTimeout(120);await expect({actions:1});record.cases.push({name:'repeat-source-gap',candidate:1,source:3})})
   record.events=await page.evaluate(()=>globalThis.fixtureEvents)
   assert.deepEqual(record.errors,[]);assert.deepEqual(record.forbidden,[])
  }catch(error){record.failure=String(error);proof.failures.push({scheme,message:String(error)});throw error}finally{await context.close()}
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));proof.closed=true;await writeFile(path.join(out,'proof.json'),JSON.stringify(proof,null,2))}
console.log(JSON.stringify({contexts:proof.contexts.length,cases:proof.contexts.reduce((n,c)=>n+c.cases.length,0),closed:proof.closed}))
