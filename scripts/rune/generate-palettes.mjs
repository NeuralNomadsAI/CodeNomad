import assert from 'node:assert/strict'
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises'
import path from 'node:path'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {root,generated} from './generate-common.mjs'
import {collectTheme} from './generate-theme-browser.mjs'
import {themeFixtureHtml} from './generate-theme-fixture.mjs'

const ui=path.join(root,'packages/ui')
const css=await readFile(path.join(ui,'src/styles/tokens.css'),'utf8')
const names=[...new Set([...css.matchAll(/--([a-zA-Z0-9_-]+)\s*:/g)].map(match=>match[1]))].sort()
const output=path.join(root,'target/rune-codegen')
await mkdir(output,{recursive:true})
const cache=await mkdtemp(path.join(output,'palettes-'))
const server=await createServer({root:ui,configFile:false,cacheDir:cache,appType:'custom',
  optimizeDeps:{noDiscovery:true,entries:[]},server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error',
  plugins:[{name:'rune-palettes',configureServer(instance){instance.middlewares.use('/__rune_palettes',(_request,response)=>{
    response.setHeader('content-type','text/html');response.end(themeFixtureHtml)
  })}}]})
let browser
try{
  await server.listen()
  browser=await chromium.launch({headless:true})
  const page=await browser.newPage({viewport:{width:1024,height:768},deviceScaleFactor:1})
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__rune_palettes`)
  await page.keyboard.press('Tab')
  const palettes=await page.evaluate(async()=>{
    const {BUILT_IN_COLOR_SCHEMES}=await import('/src/lib/theme-scheme.ts')
    return BUILT_IN_COLOR_SCHEMES.filter(({id,appearance})=>appearance!=='system'&&id!=='custom')
      .map(({id,labelKey,appearance})=>({id,labelKey,appearance}))
  })
  for(const palette of palettes){
    await page.emulateMedia({colorScheme:palette.appearance,reducedMotion:'no-preference'})
    await page.evaluate(async id=>{
      const {applyColorScheme,normalizeColorScheme}=await import('/src/lib/theme-scheme.ts')
      applyColorScheme(normalizeColorScheme(id))
    },palette.id)
    const snapshot=await page.evaluate(collectTheme,names)
    assert.deepEqual(snapshot.unresolved,[],palette.id)
    palette.colors=snapshot.colors
    palette.shadows=snapshot.shadows
  }
  await generated('assets/palettes.json',palettes)
}finally{
  await browser?.close()
  await server.close()
  assert(path.resolve(cache).startsWith(path.resolve(output)+path.sep))
  await rm(cache,{recursive:true,force:true})
}
