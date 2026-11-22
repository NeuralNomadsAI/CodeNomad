import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {startFileActionsBrowser} from './file-row-actions-browser.mjs'
const root=fileURLToPath(new URL('../../../',import.meta.url)),out=path.join(root,'target/rune-parity/file-row-actions-pointer');await mkdir(out,{recursive:true})
const files=['file-row-actions-pointer.mjs','file-row-actions-browser.mjs'].map(f=>'scripts/rune/parity/'+f).concat(['packages/ui/tests/browser/fixtures/file-row-actions.tsx','packages/ui/src/styles/components/positioner.css','packages/ui/src/components/action-overflow-menu.tsx','packages/ui/src/components/instance/shell/right-panel/FileRowActions.tsx','packages/ui/src/components/instance/shell/right-panel/row-compact-actions.ts'])
const provenance=Object.fromEntries(await Promise.all(files.map(async f=>[f,createHash('sha256').update(await readFile(path.join(root,f))).digest('hex')])))
const {server,browser,origin,url}=await startFileActionsBrowser(),records=[]
try{
  const cases=['no-preference','reduce'].flatMap(motion=>['standalone','wrapped'].flatMap(mode=>['fresh','focused','after-resize-snapshots'].map(setup=>({motion,mode,setup,control:false}))))
  cases.push(...['standalone','wrapped'].map(mode=>({motion:'reduce',mode,setup:'fresh',control:true})))
  for(const {motion,mode,setup,control} of cases){
    const page=await browser.newPage({viewport:{width:480,height:260}}),record={motion,mode,setup,control,errors:[]};records.push(record)
    await page.emulateMedia({colorScheme:'light',reducedMotion:motion})
    page.on('pageerror',e=>record.errors.push(e.message))
    await page.route('**/*',route=>{const u=new URL(route.request().url());assert.equal(u.origin,origin);if(!u.pathname.startsWith('/api/'))return route.continue();assert.equal(route.request().method(),'GET');return u.pathname==='/api/events'?route.fulfill({contentType:'text/event-stream',body:':fixture\n\n'}):route.fulfill({json:{}})})
    await page.goto(`${url}?mode=${mode}`,{waitUntil:'domcontentloaded'})
    for(let retry=0;retry<3;retry++){try{await page.waitForFunction(()=>globalThis.runeFileActions?.ready,undefined,{timeout:20000});break}catch(error){if(retry===2)throw error;await page.reload({waitUntil:'domcontentloaded'})}}
    await page.evaluate(()=>document.fonts.ready)
    if(control)await page.addStyleTag({content:'[data-popper-positioner] {transition-duration:0s!important}'} )
    if(mode==='wrapped'&&setup!=='after-resize-snapshots')await page.evaluate(()=>runeFileActions.resize(110))
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
    await page.evaluate(()=>{
      const events=[],mutations=[];Object.assign(window,{pointerProof:{events,mutations}})
      const trigger=()=>document.querySelector('button[aria-label="Actions"]')
      const describe=el=>el?{tag:el.tagName,role:el.getAttribute('role'),class:el.getAttribute('class'),label:el.getAttribute('aria-label')}:null
      const snapshot=()=>{
        const t=trigger(),rect=t?.getBoundingClientRect(),popup=document.querySelector('[role=menu]'),positioner=popup?.closest('[data-popper-positioner]')
        const inline=document.querySelector('.file-row-inline-actions')
        return {expanded:t?.getAttribute('aria-expanded'),compact:document.querySelector('.file-row-actions')?.dataset.compact,active:document.activeElement?.getAttribute('aria-label'),menu:!!popup,
          inline:inline?{inert:inline.inert,visibility:getComputedStyle(inline).visibility,transitionProperty:getComputedStyle(inline).transitionProperty,transitionDuration:getComputedStyle(inline).transitionDuration,animations:inline.getAnimations().map(a=>({state:a.playState,keyframes:a.effect?.getKeyframes(),timing:a.effect?.getComputedTiming()}))}:null,
          trigger:rect?.toJSON(),hit:rect?describe(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)):null,
          popup:popup?{bounds:popup.getBoundingClientRect().toJSON(),transform:getComputedStyle(popup).transform,pointerEvents:getComputedStyle(popup).pointerEvents,opacity:getComputedStyle(popup).opacity,visibility:getComputedStyle(popup).visibility}:null,
          positioner:positioner?{bounds:positioner.getBoundingClientRect().toJSON(),transform:positioner.style.transform,computedTransform:getComputedStyle(positioner).transform,transitionProperty:getComputedStyle(positioner).transitionProperty,transitionDuration:getComputedStyle(positioner).transitionDuration,animationName:getComputedStyle(positioner).animationName,animations:positioner.getAnimations().map(a=>({state:a.playState,keyframes:a.effect?.getKeyframes(),timing:a.effect?.getComputedTiming()})),style:positioner.getAttribute('style')}:null}
      }
      const nativeFocus=HTMLElement.prototype.focus
      HTMLElement.prototype.focus=function(...args){
        const attempt={name:'focus-attempt',target:describe(this),connected:this.isConnected,inertAncestor:Boolean(this.closest('[inert]')),visibility:getComputedStyle(this).visibility,display:getComputedStyle(this).display,bounds:this.getBoundingClientRect().toJSON(),...snapshot()}
        nativeFocus.apply(this,args);events.push({...attempt,result:describe(document.activeElement),stack:new Error().stack})
      }
      for(const name of ['pointerdown','pointerup','click','focus','focusin','focusout'])for(const capture of [true,false])document.addEventListener(name,event=>{
        events.push({name,capture,target:event.target?.getAttribute?.('aria-label')||event.target?.tagName,phase:event.eventPhase,prevented:event.defaultPrevented,button:event.button,pointerType:event.pointerType,...snapshot()})
        queueMicrotask(()=>events.push({name,capture,after:true,...snapshot()}))
        if(name==='pointerdown'&&capture){let frames=0;const sample=()=>{events.push({name:'after-down-frame',frame:++frames,...snapshot()});if(frames<8)requestAnimationFrame(sample)};requestAnimationFrame(sample)}
      },capture)
      new MutationObserver(records=>mutations.push(...records.map(r=>({attribute:r.attributeName,target:r.target.getAttribute?.('aria-label')||r.target.tagName,...snapshot()})))).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-expanded','data-expanded','data-compact','data-state','style','aria-hidden']})
    })
    const trigger=page.getByRole('button',{name:'Actions',exact:true})
    if(setup==='after-resize-snapshots'&&mode==='wrapped'){
      const row=page.locator('.workspace-tree-row')
      for(const state of ['rest','hover','focus-inline','compact']){
        if(state==='hover')await row.hover()
        if(state==='focus-inline')await page.locator('.file-row-inline-actions').getByRole('button',{name:'Open',exact:true}).focus()
        if(state==='compact'){await page.evaluate(()=>runeFileActions.resize(110));await page.waitForFunction(()=>runeFileActions.state().compact==='true');await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))}
        await row.screenshot({path:path.join(out,`prelude-${state}.png`),animations:'disabled'});await row.ariaSnapshot()
      }
    }
    if(setup==='focused')await trigger.focus()
    record.before=await trigger.evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {bounds:r.toJSON(),html:el.outerHTML,display:s.display,visibility:s.visibility,opacity:s.opacity,pointerEvents:s.pointerEvents,hit:hit?.outerHTML,compact:el.parentElement.dataset.compact}})
    await trigger.click();await page.waitForTimeout(200)
    record.pointer=await page.evaluate(()=>({state:runeFileActions.state(),proof:pointerProof,menu:!!document.querySelector('[role=menu]'),expanded:document.querySelector('button[aria-label="Actions"]')?.getAttribute('aria-expanded')}))
    await page.screenshot({path:path.join(out,`${motion}-${mode}-${setup}${control?'-control':''}-pointer.png`)})
    if(!record.pointer.menu){await trigger.press('ArrowDown');await page.waitForTimeout(200)}
    record.keyboardContinuation=await page.evaluate(()=>({menu:!!document.querySelector('[role=menu]'),expanded:document.querySelector('button[aria-label="Actions"]')?.getAttribute('aria-expanded')}))
    {
      await page.evaluate(()=>runeFileActions.resize(400));await page.waitForTimeout(50)
      await page.keyboard.press('Escape');await page.waitForTimeout(200)
      record.afterClose=await page.evaluate(()=>({state:runeFileActions.state(),proof:pointerProof,inlineVisibility:document.querySelector('.file-row-inline-actions')?getComputedStyle(document.querySelector('.file-row-inline-actions')).visibility:null}))
    }
    assert.deepEqual(record.errors,[]);await page.close()
  }
}finally{await browser.close();await server.close();await writeFile(path.join(out,'evidence.json'),JSON.stringify({provenance,records},null,2)+'\n')}
console.log(JSON.stringify(records.map(r=>({motion:r.motion,mode:r.mode,setup:r.setup,control:r.control,pointer:r.pointer.menu,keyboardContinuation:r.keyboardContinuation})),null,2))
