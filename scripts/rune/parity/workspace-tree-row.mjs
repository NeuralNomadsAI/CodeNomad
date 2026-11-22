import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {chromium} from 'playwright'
import {createSourceFixture,assertSourceDiagnostics} from './source-context.mjs'
import {sourcePath} from './workspace-tree-row-source.mjs'
const root=fileURLToPath(new URL('../../../',import.meta.url))
const out=path.join(root,'target/rune-source-theme-context/parity/workspace-tree-row');await mkdir(out,{recursive:true})
const entry=path.join(root,'scripts/rune/parity/workspace-tree-row.fixture.tsx')
const provenance=Object.fromEntries(await Promise.all([sourcePath,'packages/ui/src/styles/tokens.css','packages/ui/src/styles/panels/workspace-tree.css','packages/ui/src/styles/panels/control-hover.css','packages/ui/src/styles/panels/file-row-actions.css','packages/ui/src/components/instance/shell/right-panel/FileRowActions.tsx','scripts/rune/parity/workspace-tree-row.fixture.tsx','scripts/rune/parity/workspace-tree-row.mjs'].map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])))
const records=[];let browser,source
try{
  source=await createSourceFixture('scripts/rune/parity/workspace-tree-row.fixture.tsx','rune-workspace-row-product')
  Object.assign(provenance,source.provenance)
  browser=await chromium.launch({headless:true})
  for(const theme of ['light','dark'])for(const rtl of [false,true])for(const mode of ['closed','open','file','busy','focus']){
    const record={id:`${theme}-${rtl?'rtl':'ltr'}-${mode}`,theme,rtl,mode};records.push(record)
    const {page,diagnostics}=await source.open(browser,{theme,rtl:String(rtl),open:String(mode==='open'),file:String(mode==='file'),busy:String(mode==='busy'),selected:String(mode==='open'),depth:'1'},{width:400,height:180});page.setDefaultTimeout(15000)
    const errors=diagnostics.page
    for(let retry=0;retry<3;retry++){try{await page.waitForFunction(()=>globalThis.runeWorkspaceRow?.ready,undefined,{timeout:15000});break}catch(error){if(retry===2)throw Error(`${error.message}: ${JSON.stringify(errors)} ${await page.content()}`);await page.reload({waitUntil:'domcontentloaded'})}}
    await page.evaluate(()=>document.fonts.ready)
    await page.evaluate(rtl=>document.documentElement.dir=rtl?'rtl':'ltr',rtl)
    const row=page.getByRole('treeitem')
    const actions=mode==='file'?['preview-disabled',...(process.platform==='win32'?['open-default']:[]),'show-in-folder','copy-path']:['open-folder','open-terminal','copy-path']
    const visibleActions=row.locator('.file-row-pinned-actions button, .file-row-inline-actions button')
    assert.equal(await visibleActions.count(),actions.length)
    if(mode==='file')assert(await visibleActions.first().isDisabled())
    record.caller={platform:process.platform,host:'desktop-local',scope:'actual-source-caller',actions,canOpen:false}
    if(mode==='focus'){await row.focus();assert(await row.evaluate(el=>el.matches(':focus-visible')))}
    record.a11y=await row.ariaSnapshot()
    record.context=await page.evaluate(()=>window.runeSourceContext.snapshot())
    record.geometry=await row.evaluate(el=>{const rect=e=>e.getBoundingClientRect().toJSON();return {row:rect(el),children:[...el.children].map(e=>({tag:e.tagName,class:e.getAttribute('class'),rect:rect(e),opacity:getComputedStyle(e).opacity,html:e.tagName==='svg'?e.outerHTML:undefined})),font:getComputedStyle(el).font,focus:getComputedStyle(el).outline,indent:getComputedStyle(el).paddingInlineStart}})
    record.ax=await (await page.context().newCDPSession(page)).send('Accessibility.getFullAXTree')
    await row.screenshot({path:path.join(out,`solid-${record.id}.png`),animations:'disabled'})
    record.before=await page.evaluate(()=>runeWorkspaceRow.state())
    await row.click({position:{x:rtl?330:30,y:15}})
    record.after=await page.evaluate(()=>runeWorkspaceRow.state())
    assert(!record.after.events.includes('preview'),'Row click must never preview')
    assert.equal(record.geometry.row.height,30)
    const glyph=record.geometry.children.find(e=>e.tag==='svg')
    if(mode!=='file'){assert.equal(glyph.rect.width,12);if(rtl)assert.equal(record.geometry.row.right-glyph.rect.right,22);else assert.equal(glyph.rect.left-record.geometry.row.left,22)}
    assertSourceDiagnostics(diagnostics);await page.close()
  }
}finally{await browser?.close();await source?.close();await writeFile(path.join(out,'solid-evidence.json'),JSON.stringify({status:'product-default-requalification-pending',provenance,records},null,2)+'\n')}
console.log(out)
