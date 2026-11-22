import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {chromium} from 'playwright'
import {createSourceFixture,assertSourceDiagnostics} from './source-context.mjs'

const root=fileURLToPath(new URL('../../../',import.meta.url))
const out=path.join(root,'target/rune-source-theme-context/parity/action-menu');await mkdir(out,{recursive:true})
const entry=path.join(root,'scripts/rune/parity/action-menu.fixture.tsx')
const hash=async file=>createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')
const provenance=Object.fromEntries(await Promise.all(['packages/ui/src/components/action-overflow-menu.tsx','packages/ui/src/components/instance/shell/right-panel/FileRowActions.tsx','packages/ui/src/components/alert-dialog.tsx','packages/ui/src/stores/alerts.ts','scripts/rune/parity/action-menu.fixture.tsx','scripts/rune/parity/action-menu.mjs','packages/ui/src/styles/components/dropdown.css','packages/ui/src/styles/panels/file-row-actions.css'].map(async file=>[file,await hash(file)])))
const records=[];let browser,source
try{
  source=await createSourceFixture('scripts/rune/parity/action-menu.fixture.tsx','rune-action-menu-product')
  Object.assign(provenance,source.provenance)
  browser=await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined})
  const cases=['standard','immediate','immediate-target','alert-standard','alert-immediate','alert-immediate-target','dismiss','shrink','duplicate','row'].map(mode=>({mode,activation:'keyboard'}))
  cases.push(...['standard','immediate-target','alert-standard','alert-immediate-target'].map(mode=>({mode,activation:'pointer'})))
  for(const theme of ['light','dark'])for(const {mode,activation} of cases){
    const record={id:`${mode}-${theme}${activation==='pointer'?'-pointer':''}`,theme,mode,activation,errors:[],states:[]};records.push(record)
    const {page,diagnostics}=await source.open(browser,{theme,case:mode},{width:480,height:360})
    page.setDefaultTimeout(10000)
    page.setDefaultNavigationTimeout(60000)
    record.errors=diagnostics.page
    record.requests=diagnostics.api
    record.context=await page.evaluate(()=>window.runeSourceContext.snapshot())
    record.startupReloads=0
    for(let attempt=0;attempt<3;attempt++){try{await page.waitForFunction(()=>globalThis.runeActionMenu?.ready,undefined,{timeout:30000});break}catch(error){if(attempt===2)throw error;record.startupReloads++;await page.reload({waitUntil:'domcontentloaded'})}}
    await page.evaluate(()=>document.fonts.ready)
    const trigger=page.locator('button.action-overflow-trigger')
    await trigger.waitFor({state:'visible'})
    const snapshot=async name=>{
      const menu=page.getByRole('menu'),prefix=`solid-${record.id}-${name}`
      const placement=await menu.evaluate(async el=>{
        const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve))
        await frame();await frame()
        const positioner=el.closest('[data-popper-positioner]')
        if(!(positioner instanceof HTMLElement))throw Error('Actual Kobalte positioner required')
        const samples=[];let stable=0,previous=''
        for(let attempt=0;attempt<30;attempt++){
          await frame()
          const bounds=el.getBoundingClientRect().toJSON(),transform=positioner.style.transform
          const current=JSON.stringify({bounds,transform});samples.push({bounds,transform})
          stable=transform.startsWith('translate3d(')&&current===previous?stable+1:0
          if(stable>=2)return {samples,transform}
          previous=current
        }
        throw Error(`Kobalte placement failed to stabilize: ${JSON.stringify(samples)}`)
      })
      const a11y=await menu.ariaSnapshot(),geometry=await menu.evaluate(el=>{const box=el.getBoundingClientRect(),s=getComputedStyle(el);return {bounds:box.toJSON(),font:s.font,color:s.color,background:s.backgroundColor,border:s.border,shadow:s.boxShadow,rows:[...el.children].map(row=>({key:row.getAttribute('data-action-key'),bounds:row.getBoundingClientRect().toJSON(),label:row.querySelector('.action-overflow-item-label')?.getBoundingClientRect().toJSON(),icon:row.querySelector('.action-overflow-item-icon')?.getBoundingClientRect().toJSON()}))}})
      geometry.placement=placement
      await menu.screenshot({path:path.join(out,`${prefix}.png`),animations:'disabled'})
      geometry.afterInterior=await menu.evaluate(el=>el.getBoundingClientRect().toJSON())
      assert.deepEqual(geometry.afterInterior,geometry.bounds,'Menu geometry must stay fixed during interior capture')
      const box=geometry.bounds,inset=64,clip={x:Math.max(0,Math.floor(box.x-inset)),y:Math.max(0,Math.floor(box.y-inset)),width:Math.min(480,Math.ceil(box.right+inset))-Math.max(0,Math.floor(box.x-inset)),height:Math.min(360,Math.ceil(box.bottom+inset))-Math.max(0,Math.floor(box.y-inset))}
      await page.screenshot({path:path.join(out,`${prefix}-halo.png`),clip,animations:'disabled'})
      geometry.afterHalo=await menu.evaluate(el=>el.getBoundingClientRect().toJSON())
      assert.deepEqual(geometry.afterHalo,geometry.bounds,'Menu geometry must stay fixed during halo capture')
      geometry.halo=clip;geometry.trigger=await trigger.boundingBox()
      await writeFile(path.join(out,`${prefix}.aria.yml`),a11y)
      const cdp=await page.context().newCDPSession(page),ax=await cdp.send('Accessibility.getFullAXTree')
      await cdp.send('DOM.enable');await cdp.send('CSS.enable')
      const {root:dom}=await cdp.send('DOM.getDocument'),{nodeId}=await cdp.send('DOM.querySelector',{nodeId:dom.nodeId,selector:'.action-overflow-item-label'})
      geometry.platformFonts=await cdp.send('CSS.getPlatformFontsForNode',{nodeId});await cdp.detach()
      await writeFile(path.join(out,`${prefix}.ax.json`),JSON.stringify(ax,null,2)+'\n')
      record.states.push({name,file:`${prefix}.png`,geometry,a11y,state:await page.evaluate(()=>runeActionMenu.state())})
    }
    await trigger.focus();await page.keyboard.press('ArrowDown');await page.getByRole('menu').waitFor()
    await snapshot('open')
    if(mode==='standard'){
      await page.keyboard.press('End');await snapshot('focus')
      await page.keyboard.press('Home')
    }
    if(mode==='standard'||mode.includes('immediate')||mode==='alert-standard'){
      const disabled=page.getByRole('menuitem',{name:'Disabled',exact:true});assert.equal(await disabled.getAttribute('aria-disabled'),'true')
      const checked=page.getByRole('menuitemcheckbox',{name:'Copy',exact:true});assert.equal(await checked.getAttribute('aria-checked'),'true')
      if(activation==='pointer')await page.getByRole('menuitem',{name:'Open',exact:true}).click()
      else{
        await page.keyboard.down('Enter');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
        record.afterKeyDown=await page.evaluate(()=>runeActionMenu.state())
        await page.keyboard.up('Enter')
      }
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      record.result=await page.evaluate(()=>runeActionMenu.state())
      assert.equal(record.result.events.filter(e=>e.event==='select').length,1)
      if(record.result.dialog){await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
      record.afterDialog=await page.evaluate(()=>runeActionMenu.state())
      record.afterDialog.activeElement=await page.evaluate(()=>({tag:document.activeElement?.tagName,id:document.activeElement?.id,label:document.activeElement?.getAttribute('aria-label')}))
    }else if(mode==='dismiss'){
      await page.getByRole('menuitem',{name:'Open',exact:true}).hover();await snapshot('hover')
      await page.keyboard.press('Escape');await page.getByRole('menu').waitFor({state:'hidden'})
      await trigger.click();await page.getByRole('menu').waitFor()
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      await page.mouse.click(420,310)
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      record.outsideDismissed=!(await page.getByRole('menu').isVisible())
      if(!record.outsideDismissed)await page.keyboard.press('Escape')
      record.result=await page.evaluate(()=>runeActionMenu.state());assert(record.result.events.some(e=>e.event==='leave'));assert(!record.result.events.some(e=>e.event==='select'))
    }else if(mode==='shrink'){
      await page.evaluate(()=>runeActionMenu.shrink());await page.getByRole('menu').waitFor({state:'hidden'});assert.equal(await trigger.count(),0)
      await page.evaluate(()=>runeActionMenu.restore());await trigger.waitFor({state:'visible'});assert.equal(await page.getByRole('menu').count(),0)
      record.result=await page.evaluate(()=>runeActionMenu.state())
    }else if(mode==='duplicate'){
      assert.equal(await page.getByRole('menuitem',{name:'Open',exact:true}).count(),0)
      await page.getByRole('menuitem',{name:'Final',exact:true}).click();await page.waitForFunction(()=>runeActionMenu.state().events.some(e=>e.event==='final'))
      record.result=await page.evaluate(()=>runeActionMenu.state());assert.equal(record.result.events.filter(e=>e.event==='final').length,1)
    }else{
      assert.equal(await page.locator('.file-row-actions').getAttribute('data-compact'),'true')
      await page.keyboard.press('Escape');record.result=await page.evaluate(()=>runeActionMenu.state())
    }
    assertSourceDiagnostics(diagnostics);await page.close()
  }
}catch(error){if(records.length)records.at(-1).failure=error.message;throw error}
finally{await browser?.close();await source?.close();await writeFile(path.join(out,'solid-evidence.json'),JSON.stringify({status:records.some(r=>r.failure)?'failed':'product-default-requalification-pending',provenance,records,pending:['Rune comparison, regional pixel budgets and negative controls','Touch/pen, RTL and physical devices'],frame:'Actual menu in compact FileRowActions and shared product SourceContext; row case mounts actual FileRowActions with its ResizeObserver.'},null,2)+'\n')}
console.log(out)
