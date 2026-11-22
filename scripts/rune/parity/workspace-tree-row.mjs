import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {chromium} from 'playwright'
import {createServer} from 'vite'
import solid from 'vite-plugin-solid'
import {createFixtureCache} from '../../../packages/ui/tests/browser/fixture-cache.ts'
import {createFixtureShutdown} from '../../../packages/ui/tests/browser/fixture-shutdown.ts'
import {sourcePath} from './workspace-tree-row-source.mjs'
const root=fileURLToPath(new URL('../../../',import.meta.url)),require=createRequire(import.meta.url)
const out=path.join(root,'target/rune-parity/workspace-tree-row');await mkdir(out,{recursive:true})
const entry=path.join(root,'scripts/rune/parity/workspace-tree-row.fixture.tsx')
const provenance=Object.fromEntries(await Promise.all([sourcePath,'packages/ui/src/styles/tokens.css','packages/ui/src/styles/panels/workspace-tree.css','packages/ui/src/styles/panels/control-hover.css','packages/ui/src/styles/panels/file-row-actions.css','packages/ui/src/components/instance/shell/right-panel/FileRowActions.tsx','scripts/rune/parity/workspace-tree-row.fixture.tsx','scripts/rune/parity/workspace-tree-row.mjs'].map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])))
const records=[];let browser,server
try{
  const cache=await createFixtureCache(),shutdown=createFixtureShutdown(cache)
  server=await createServer({root:path.join(root,'packages/ui'),configFile:false,cacheDir:cache.cacheDir,
    plugins:[shutdown.plugin,solid(),{name:'actual-workspace-tree',configureServer(s){s.middlewares.use('/rune-workspace-row',async(_q,r)=>{r.setHeader('content-type','text/html');r.end(await s.transformIndexHtml('/rune-workspace-row',`<html><body style="margin:0"><div id="root"></div><script type="module" src="/@fs/${entry.replaceAll('\\','/')}"></script></body></html>`))})}}],
    resolve:{dedupe:['solid-js']},optimizeDeps:{entries:[entry],include:['solid-js','solid-js/web','solid-js/store','debug'],exclude:['lucide-solid']},server:{host:'127.0.0.1',port:0,hmr:false,watch:null,fs:{allow:[root,path.dirname(path.dirname(require.resolve('playwright/package.json')))]}},logLevel:'error'})
  shutdown.own(server);await server.listen()
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`
  browser=await chromium.launch({headless:true})
  for(const theme of ['light','dark'])for(const rtl of [false,true])for(const mode of ['closed','open','file','busy','focus']){
    const record={id:`${theme}-${rtl?'rtl':'ltr'}-${mode}`,theme,rtl,mode};records.push(record)
    const page=await browser.newPage({viewport:{width:400,height:180},deviceScaleFactor:1});page.setDefaultTimeout(15000)
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error')console.error(msg.text())})
    await page.route('**/*',route=>{const url=new URL(route.request().url());assert.equal(url.origin,origin);return url.pathname==='/api/events'?route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'}):url.pathname.startsWith('/api/')?route.fulfill({json:{}}):route.continue()})
    await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'})
    const url=`${origin}/rune-workspace-row?${new URLSearchParams({theme,rtl:String(rtl),open:String(mode==='open'),file:String(mode==='file'),busy:String(mode==='busy'),selected:String(mode==='open'),depth:'1'})}`
    for(let retry=0;retry<3;retry++){
      try{
        await page.goto(url,{waitUntil:'domcontentloaded'})
        await page.waitForFunction(()=>globalThis.runeWorkspaceRow?.ready,undefined,{timeout:15000})
        record.bootstrapAttempts=retry+1;break
      }catch(error){if(retry===2)throw Error(`${error.message}: ${JSON.stringify(errors)} ${await page.content()}`)}
    }
    await page.evaluate(()=>document.fonts.ready)
    await page.evaluate(rtl=>document.documentElement.dir=rtl?'rtl':'ltr',rtl)
    const row=page.getByRole('treeitem')
    if(mode==='focus'){await row.focus();assert(await row.evaluate(el=>el.matches(':focus-visible')))}
    record.a11y=await row.ariaSnapshot()
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
    assert.deepEqual(errors,[]);await page.close()
  }
}finally{await browser?.close();await server?.close();await writeFile(path.join(out,'solid-evidence.json'),JSON.stringify({provenance,records},null,2)+'\n')}
console.log(out)
