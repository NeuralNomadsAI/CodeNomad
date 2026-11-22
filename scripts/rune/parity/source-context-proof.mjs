import assert from 'node:assert/strict'
import {mkdir,writeFile,readFile,copyFile} from 'node:fs/promises'
import path from 'node:path'
import {chromium} from 'playwright'
import {root,createSourceFixture,assertSourceDiagnostics,prepareSourceAssets} from './source-context.mjs'
const out=path.join(root,'target/rune-source-theme-context');await mkdir(out,{recursive:true})
await prepareSourceAssets()
const fixture=await createSourceFixture('scripts/rune/parity/source-context-proof.fixture.tsx','rune-source-context-proof')
let browser,failure
const records=[]
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined})
 for(const theme of ['light','dark'])for(const provider of [false,true]){
  const {page,diagnostics}=await fixture.open(browser,{theme,provider:String(provider)})
  const id=`${theme}-${provider?'product':'css'}`
  try{
   if(provider)await page.locator('.workspace-file-view > div.text-secondary').waitFor()
   const before=await page.evaluate(()=>{
    const measure=selector=>{const node=document.querySelector(selector);if(!node)return null;const style=getComputedStyle(node);return {rect:node.getBoundingClientRect().toJSON(),css:Object.fromEntries(['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','color','backgroundColor','borderColor','padding','columnGap','rowGap'].map(key=>[key,style[key]]))}}
    return {context:window.runeSourceContext.snapshot(),body:measure('body'),window:measure('.window-header'),tab:measure('.tab-base'),row:measure('.workspace-tree-row'),rowLabel:measure('.workspace-tree-label'),actions:measure('#file-actions .file-row-icon-button'),reader:measure('.workspace-file-view'),readerNotice:measure('.workspace-file-view > div.text-secondary')}
   })
   await page.screenshot({path:path.join(out,id+'.png'),animations:'disabled'})
   await page.getByRole('button',{name:'Context actions',exact:true}).click();await page.getByRole('menu').waitFor()
   const menu=await page.getByRole('menu').evaluate(node=>{const style=getComputedStyle(node),item=node.querySelector('[role^=menuitem]'),row=getComputedStyle(item);return {bounds:node.getBoundingClientRect().toJSON(),css:Object.fromEntries(['fontSize','lineHeight','letterSpacing','color','backgroundColor','borderColor'].map(key=>[key,style[key]])),item:{bounds:item.getBoundingClientRect().toJSON(),css:Object.fromEntries(['fontSize','lineHeight','letterSpacing','color','backgroundColor'].map(key=>[key,row[key]]))}}})
   await page.getByRole('menu').screenshot({path:path.join(out,id+'-menu.png'),animations:'disabled'})
   records.push({id,theme,provider,...before,menu,a11y:await page.getByRole('menu').ariaSnapshot(),diagnostics})
   assertSourceDiagnostics(diagnostics)
  }finally{await page.close()}
 }
 for(const theme of ['light','dark']){
  const bare=records.find(r=>r.theme===theme&&!r.provider),product=records.find(r=>r.theme===theme&&r.provider)
  assert.equal(bare.body.css.fontSize,'13px');assert.equal(product.body.css.fontSize,'16px')
  assert.equal(product.body.css.letterSpacing,'0.15008px');assert.equal(product.row.rect.height,30);assert.equal(bare.row.rect.height,30)
  assert.notEqual(product.row.css.color,bare.row.css.color)
  assert.notEqual(product.menu.css.backgroundColor,bare.menu.css.backgroundColor)
  assert.notEqual(product.tab.css.backgroundColor,bare.tab.css.backgroundColor)
 }
}catch(error){failure={message:error.message,stack:error.stack,diagnostics:error.diagnostics};throw error}
finally{await browser?.close();await fixture.close();await copyFile(path.join(fixture.logDirectory,'daemon.log'),path.join(out,'proof-daemon.log'));await writeFile(path.join(out,'proof.json'),JSON.stringify({dependencies:fixture.dependencies,provenance:fixture.provenance,records,failure},null,2)+'\n')}
console.log(`${records.length} actual Source contexts compared: ${out}`)
