import assert from 'node:assert/strict'
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {test} from 'node:test'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {applyDefaultPalette,collectTheme} from './generate-theme-browser.mjs'
import {themeFixtureHtml,sourceMenuGutter} from './generate-theme-fixture.mjs'
import {workspaceRowContract,workspaceSource} from './parity/workspace-tree-row-source.mjs'

const root=fileURLToPath(new URL('../../',import.meta.url))
test('workspace geometry follows the actual JSX expressions and rejects unknown indents',async()=>{
  assert.deepEqual(workspaceSource,{base:8,step:14,chevron:12,icon:14,busy:12})
  const source=await readFile(path.join(root,'packages/ui/src/components/instance/shell/right-panel/components/WorkspaceTree.tsx'),'utf8')
  assert.equal(workspaceRowContract(source.replace('8 + row.depth * 14','11 + row.depth * 17')).step,17)
  assert.throws(()=>workspaceRowContract(source.replace('8 + row.depth * 14','row.depth * 14')),/requires base/)
})
test('action menu gutter follows its actual numeric JSX contract',()=>{
  assert.equal(sourceMenuGutter('<DropdownMenu gutter={7}></DropdownMenu>'),7)
  assert.throws(()=>sourceMenuGutter('<DropdownMenu gutter={spacing}></DropdownMenu>'),/numeric JSX gutter/)
  assert.throws(()=>sourceMenuGutter('<Other gutter={4}></Other>'),/one source DropdownMenu/)
})
test('generated semantic metrics survive actual font changes and viewport changes',async()=>{
  const temporary=path.join(root,'target/rune-codegen-tests')
  await mkdir(temporary,{recursive:true})
  const cache=await mkdtemp(path.join(temporary,'vite-'))
  const css=await readFile(path.join(root,'packages/ui/src/styles/tokens.css'),'utf8')
  const generated=JSON.parse(await readFile(path.join(root,'crates/rune-theme-codenomad/assets/theme.json'),'utf8'))
  const names=[...new Set([...css.matchAll(/--([a-zA-Z0-9_-]+)\s*:/g)].map(m=>m[1]))].sort()
  const server=await createServer({root:path.join(root,'packages/ui'),configFile:false,appType:'custom',cacheDir:cache,
    optimizeDeps:{noDiscovery:true,entries:[]},plugins:[{name:'rune-theme-contract',configureServer(s){s.middlewares.use('/theme-contract',(_request,response)=>{
      response.setHeader('content-type','text/html');response.end(themeFixtureHtml)
    })}}],server:{host:'127.0.0.1',port:0},logLevel:'error'})
  let browser
  const evidence=[]
  try{
    await server.listen()
    browser=await chromium.launch({headless:true})
    const page=await browser.newPage({viewport:{width:1024,height:768}})
    for(const appearance of ['light','dark']){
      await page.emulateMedia({colorScheme:appearance,reducedMotion:'no-preference'})
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/theme-contract`,{waitUntil:'networkidle'})
      assert.equal(await page.evaluate(applyDefaultPalette,appearance),generated.product[appearance].palette)
      await page.keyboard.press('Tab')
      assert(await page.locator('.window-icon-button').evaluate(element=>element.matches(':focus-visible')))
      const baseline=await page.evaluate(collectTheme,names)
      assert.deepEqual(baseline.colors,generated.product[appearance].colors)
      assert.deepEqual(baseline.metrics,generated.metrics[appearance],'Baseline must match the checked-in semantic contract')
      const familyKeys=['font-family-sans','message-part-header-font-family']
      const widths=[]
      for(const family of ['"Segoe UI"','Arial','Helvetica','sans-serif','serif','monospace']){
        await page.evaluate(font=>document.documentElement.style.setProperty('--font-family-sans',font),family)
        const value=await page.evaluate(collectTheme,names)
        const intrinsic=await page.evaluate(()=>({title:getComputedStyle(document.querySelector('.window-title')).width,input:getComputedStyle(document.querySelector('.selector-input')).width}))
        widths.push(intrinsic.title)
        assert.deepEqual(value.metrics,baseline.metrics,`${appearance} semantic metrics changed under ${family}`)
        for(const field of ['colors','numbers','shadows','unresolved'])assert.deepEqual(value[field],baseline[field])
        const unchangedStrings={...value.strings}
        for(const key of familyKeys){
          assert.equal(value.strings[key],family,'Declared font stacks and their CSS aliases remain source values')
          unchangedStrings[key]=baseline.strings[key]
        }
        assert.deepEqual(unchangedStrings,baseline.strings)
        evidence.push({appearance,family,intrinsic,metrics:value.metrics})
      }
      assert(new Set(widths).size>1,'Font overrides must change actual glyph layout, exercising the regression')
      await page.setViewportSize({width:640,height:900})
      assert.deepEqual((await page.evaluate(collectTheme,names)).metrics,baseline.metrics,'Viewport-dependent intrinsic dimensions leaked into the theme')
      for(const [name,metric] of Object.entries(baseline.metrics)){
        if(['windowIcon','windowIconGlyph','tabActive','tabGlyph','tabCloseGlyph','actionMenuIcon','fileRowActionGlyph'].includes(name))continue
        assert(!('width'in metric)&&!('height'in metric),`${name} retained intrinsic dimensions`)
      }
      assert.equal(baseline.metrics.windowIcon.width,24)
      assert.equal(baseline.metrics.windowIcon.height,24)
      assert.equal(baseline.metrics.windowIconGlyph.width,14)
      assert.equal(baseline.metrics.windowIconGlyph.height,14)
      assert.deepEqual(baseline.metrics.tabFocus,{ringWidth:2,ringOffset:1,extent:3})
      for(const kind of ['tabFocus','tabCloseFocus']){
        assert.equal(baseline.colors[`${kind}-ring`],'#3b82f680','Normalized CSS RGB channels survive translucent color extraction')
        assert.equal(baseline.colors[`${kind}-offset`],'#ffffffff')
      }
      assert.equal(baseline.metrics.actionMenu.viewportInset,16)
      assert.equal(baseline.metrics.actionMenuItem.minHeight,32)
      assert.equal(baseline.metrics.actionMenuDisabled.opacity,0.5)
      assert.deepEqual(baseline.metrics.fileRowActionGlyph,{width:14,height:14})
      assert.equal(baseline.metrics.workspaceRow.minHeight,27)
      assert.equal(baseline.metrics.workspaceRow.columnGap,5)
      assert.equal(baseline.metrics.workspaceRow.outlineWidth,1)
      assert.equal(baseline.metrics.workspaceRow.outlineOffset,-1)
      assert.deepEqual(baseline.metrics.fileRowAction,{minWidth:24,minHeight:24,paddingLeft:0,opacity:0.7})
      await page.locator('.action-overflow-item').first().evaluate(element=>element.style.lineHeight='normal')
      await assert.rejects(page.evaluate(collectTheme,names),/lineHeight requires an explicit numeric CSS value/)
      await page.locator('.action-overflow-item').first().evaluate(element=>element.style.removeProperty('line-height'))
      await page.locator('.tab-base').first().evaluate(element=>element.style.boxShadow='none')
      await assert.rejects(page.evaluate(collectTheme,names),/Unsupported .tab-base focus shadow/)
      await page.locator('.tab-base').first().evaluate(element=>element.style.removeProperty('box-shadow'))
      await page.locator('.window-title').evaluate(element=>element.style.lineHeight='normal')
      await assert.rejects(page.evaluate(collectTheme,names),/lineHeight requires an explicit numeric CSS value/)
      await page.setViewportSize({width:1024,height:768})
    }
    await writeFile(path.join(temporary,'font-contract-evidence.json'),JSON.stringify(evidence,null,2)+'\n')
  }finally{
    await browser?.close();await server.close()
    assert(path.resolve(cache).startsWith(path.resolve(temporary)+path.sep))
    await rm(cache,{recursive:true,force:true})
  }
})
