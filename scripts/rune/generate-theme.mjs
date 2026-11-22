import assert from 'node:assert/strict'
import {readFile,mkdir,mkdtemp,readdir,rm} from 'node:fs/promises'
import path from 'node:path'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {root,generated,sources} from './generate-common.mjs'
import {collectTheme} from './generate-theme-browser.mjs'
import {themeFixtureHtml} from './generate-theme-fixture.mjs'
import {generateWorkspaceIcons} from './parity/workspace-tree-row-icons.mjs'
import {sourcePath} from './parity/workspace-tree-row-source.mjs'

const ui=path.join(root,'packages/ui'),tokens=path.join(ui,'src/styles/tokens.css')
const css=await readFile(tokens,'utf8'),names=[...new Set([...css.matchAll(/--([a-zA-Z0-9_-]+)\s*:/g)].map(m=>m[1]))].sort()
assert(names.length>100,'Expected the shared CodeNomad theme, not a theme subset')
const temporary=path.join(root,'target/rune-codegen');await mkdir(temporary,{recursive:true})
const cache=await mkdtemp(path.join(temporary,'vite-')),profile=await mkdtemp(path.join(temporary,'browser-'))
const html=themeFixtureHtml
const server=await createServer({root:ui,configFile:false,appType:'custom',cacheDir:cache,optimizeDeps:{noDiscovery:true,entries:[]},
  plugins:[{name:'rune-theme-fixture',configureServer(instance){instance.middlewares.use('/__rune_theme',(_request,response)=>{response.setHeader('content-type','text/html');response.end(html)})}}],
  server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error'})
let browser
const out={name:'CodeNomad',blend:{mode:'srgb',over:'surface-canvas'},light:{},dark:{},numbers:{},strings:{},shadows:{},metrics:{},gaps:[
  'Rune-kit control geometry includes internal constants; CodeNomad shared adapters require visual qualification.',
  'CSS timing functions and Rune perceptual-duration springs have different curves; motion parity requires interaction captures.',
  'System font stacks are preserved as source strings; glyph metrics require per-platform image qualification.',
]}
try{
  await server.listen()
  browser=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:1024,height:768},deviceScaleFactor:1})
  const page=browser.pages()[0]??await browser.newPage()
  for(const appearance of ['light','dark']){
    await page.emulateMedia({colorScheme:appearance,reducedMotion:'no-preference'})
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__rune_theme`,{waitUntil:'networkidle'})
    await page.evaluate(mode=>document.documentElement.setAttribute('data-theme',mode),appearance)
    await page.keyboard.press('Tab')
    assert(await page.locator('.window-icon-button').evaluate(e=>e.matches(':focus-visible')),
      'Window icon focus metrics must come from real keyboard focus')
    const value=await page.evaluate(collectTheme,names)
    assert.equal(value.unresolved.length,0,`Unresolved ${appearance} tokens: ${value.unresolved.join(', ')}`)
    out[appearance]=value.colors
    for(const field of ['numbers','strings','shadows','metrics'])out[field][appearance]=value[field]
  }
  const files=[tokens,path.join(root,sourcePath),path.join(ui,'src/index.css'),path.join(ui,'tailwind.config.js'),path.join(ui,'postcss.config.js')]
  async function walk(folder){for(const entry of await readdir(folder,{withFileTypes:true})){
    const file=path.join(folder,entry.name);if(entry.isDirectory())await walk(file);else if(file.endsWith('.css'))files.push(file)
  }}
  await walk(path.join(ui,'src/styles'))
  out.sources=await sources(files)
  await generated('assets/theme.json',out)
  await generateWorkspaceIcons()
}finally{
  await browser?.close()
  await server.close()
  for(const folder of [cache,profile])assert(path.resolve(folder).startsWith(path.resolve(temporary)+path.sep),'Generator cleanup escapes its owned temporary directory')
  await rm(cache,{recursive:true,force:true});await rm(profile,{recursive:true,force:true})
}
