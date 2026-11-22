import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {startFileActionsBrowser} from './file-row-actions-browser.mjs'
const root=fileURLToPath(new URL('../../../',import.meta.url))
const out=path.join(root,'target/rune-parity/file-row-actions');await mkdir(out,{recursive:true})
const sources=['scripts/rune/parity/file-row-actions-browser.mjs','scripts/rune/parity/file-row-actions.mjs','packages/ui/tests/browser/fixtures/file-row-actions.tsx','packages/ui/src/components/instance/shell/right-panel/FileRowActions.tsx','packages/ui/src/components/instance/shell/right-panel/row-compact-actions.ts','packages/ui/src/styles/panels/file-row-actions.css','packages/ui/src/styles/panels/control-hover.css','packages/ui/src/styles/components/positioner.css','packages/ui/src/styles/utilities.css']
const provenance=Object.fromEntries(await Promise.all(sources.map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])))
let browser,server,origin,url;const records=[]
try{
  ;({browser,server,origin,url}=await startFileActionsBrowser())
  for(const theme of ['light','dark'])for(const rtl of [false,true]){
    const record={id:`${theme}-${rtl?'rtl':'ltr'}`,states:[],errors:[]};records.push(record)
    const page=await browser.newPage({viewport:{width:480,height:260}});page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(120000)
    page.on('pageerror',e=>record.errors.push(e.message))
    await page.route('**/*',route=>{const u=new URL(route.request().url());assert.equal(u.origin,origin,'No external network');if(!u.pathname.startsWith('/api/'))return route.continue();assert.equal(route.request().method(),'GET','Fixture cannot mutate API');return u.pathname==='/api/events'?route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'}):route.fulfill({json:{}})})
    await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'})
    await page.goto(`${url}?${new URLSearchParams({theme,rtl:String(rtl)})}`,{waitUntil:'domcontentloaded'})
    for(let retry=0;retry<3;retry++){try{await page.waitForFunction(()=>globalThis.runeFileActions?.ready,undefined,{timeout:20000});break}catch(error){if(retry===2)throw error;await page.reload({waitUntil:'domcontentloaded'})}}
    await page.evaluate(()=>document.fonts.ready)
    await page.evaluate(({theme,rtl})=>{document.documentElement.dataset.theme=theme;document.documentElement.dir=rtl?'rtl':'ltr'},{theme,rtl})
    const row=page.locator('.workspace-tree-row'),actions=page.locator('.file-row-actions'),inline=page.locator('.file-row-inline-actions')
    const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
    const capture=async name=>{
      await settle();const image=path.join(out,`solid-${record.id}-${name}.png`)
      const geometry=await row.evaluate(el=>{const rect=e=>e.getBoundingClientRect().toJSON(),group=el.querySelector('.file-row-actions');return {row:rect(el),actions:rect(group),compact:group.dataset.compact,opacity:getComputedStyle(group).opacity,inline:rect(el.querySelector('.file-row-inline-actions')),buttons:[...group.querySelectorAll('button')].map(b=>({name:b.getAttribute('aria-label'),rect:rect(b),glyph:b.querySelector('svg')?rect(b.querySelector('svg')):null,disabled:b.disabled,inert:b.inert,display:getComputedStyle(b).display,visibility:getComputedStyle(b).visibility,opacity:getComputedStyle(b).opacity,color:getComputedStyle(b).color,background:getComputedStyle(b).backgroundColor,backgroundImage:getComputedStyle(b).backgroundImage,outline:getComputedStyle(b).outline}))}})
      await row.screenshot({path:image,animations:'disabled'});record.states.push({name,image,geometry,a11y:await row.ariaSnapshot(),state:await page.evaluate(()=>runeFileActions.state())})
      if(name==='menu'){
        const popup=page.getByRole('menu'),menuImage=path.join(out,`solid-${record.id}-popup.png`)
        await page.screenshot({path:menuImage,animations:'disabled'})
        record.popup={image:menuImage,bounds:await popup.boundingBox(),a11y:await popup.ariaSnapshot()}
      }
    }
    assert.equal(await actions.getAttribute('data-compact'),'false');await capture('rest')
    await row.hover();await capture('hover')
    await inline.getByRole('button',{name:'Open',exact:true}).focus();await capture('focus-inline')
    await page.evaluate(()=>runeFileActions.resize(110));await page.waitForFunction(()=>runeFileActions.state().compact==='true');await settle()
    assert.equal(await page.evaluate(()=>runeFileActions.state().active),'Actions');assert(await inline.evaluate(el=>el.inert));await capture('compact')
    await page.getByRole('button',{name:'Actions',exact:true}).click();await page.waitForTimeout(200);record.pointerTriggerOpened=await page.getByRole('menu').isVisible()
    try{await page.getByRole('menu').waitFor()}catch(error){record.failure={message:error.message,state:await page.evaluate(()=>runeFileActions.state()),html:await page.locator('body').innerHTML()};throw error}await capture('menu')
    await page.evaluate(()=>runeFileActions.resize(400));await settle();assert.equal(await actions.getAttribute('data-compact'),'true');assert(await page.getByRole('menu').isVisible())
    await page.keyboard.press('Escape');await page.getByRole('menu').waitFor({state:'hidden'});await settle();assert.equal(await actions.getAttribute('data-compact'),'false');record.focusReturn=await page.evaluate(()=>runeFileActions.state().active)
    await page.getByRole('button',{name:'Preview',exact:true}).click();await capture('checked')
    assert.equal(await page.getByRole('button',{name:'Preview',exact:true}).getAttribute('aria-pressed'),'true')
    const group=await actions.boundingBox(),pin=await page.getByRole('button',{name:'Preview',exact:true}).boundingBox()
    await page.mouse.click(rtl?pin.x-1:pin.x+pin.width+1,group.y+group.height/2)
    const state=await page.evaluate(()=>runeFileActions.state());assert(!state.trace.some(e=>e.event==='row'||e.event==='row-down'));assert(!state.trace.some(e=>e.event==='disabled'))
    record.result=state;assert.deepEqual(record.errors,[]);await page.close()
  }
}finally{await browser?.close();await server?.close();await writeFile(path.join(out,'solid-evidence.json'),JSON.stringify({provenance,records},null,2)+'\n')}
console.log(`${records.length} actual Source interaction matrices captured`)
assert.deepEqual(records.filter(r=>!r.pointerTriggerOpened).map(r=>r.id),[],'Pointer opening is required')
assert.deepEqual(records.filter(r=>r.focusReturn!=='Open').map(r=>r.id),[],'Expected inline focus return remains independently required')
