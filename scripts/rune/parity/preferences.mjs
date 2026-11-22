import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {root} from '../generate-common.mjs'
import {requireTestSupport} from '../../../packages/rune-app/fixtures/fixture-binaries.mjs'

const {values:{binary}}=parseArgs({options:{binary:{type:'string'}}})
assert(binary&&path.isAbsolute(binary),'Supply --binary ABSOLUTE_EXE')
requireTestSupport(binary)
const ui=path.join(root,'packages/ui')
const out=path.join(root,'target/rune-parity/preferences')
await mkdir(out,{recursive:true})
const {startFixtureDaemon}=await import('../../../packages/ui/tests/browser/fixture-daemon/server.ts')
const fixture='/tests/browser/fixtures/preferences-window.tsx'
const server=await startFixtureDaemon({directory:ui})
let browser
try {
  const url=await server.register({name:'rune-preferences',routes:[{path:'/rune-preferences',
    html:`<html><body><div id="root" style="height:100vh"></div><script type="module" src="${fixture}"></script></body></html>`}]})
  browser=await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined})
  for(const theme of ['light','dark']) {
    const page=await browser.newPage({viewport:{width:1100,height:760},locale:'en-US',colorScheme:theme,reducedMotion:'reduce'})
    page.on('pageerror',error=>console.error(error.message))
    await page.addInitScript(()=>{
      window.__CODENOMAD_RUNTIME_HOST__='electron'
      window.__CODENOMAD_WINDOW_CONTEXT__='preferences'
      window.electronAPI={
        getPreferencesRequest:async()=>({section:'general'}),acceptPreferencesRequest:async()=>{},
        preferencesReady:async()=>{},onPreferencesSection:()=>()=>{},onPreferencesCloseRequested:()=>()=>{},
        onPreferencesTransitionRequested:()=>()=>{},closeWindow:async()=>{},
      }
    })
    await page.route('**/api/**',route=>{
      const target=new URL(route.request().url()).pathname
      if(!target.startsWith('/api/'))return route.continue()
      if(target==='/api/storage/config/ui')return route.fulfill({json:{settings:{locale:'en'}}})
      if(target==='/api/storage/state/ui')return route.fulfill({json:{appearancePreferences:{mode:'system',
        light:{scheme:{id:'light'}},dark:{scheme:{id:'classic'}}}}})
      return route.fulfill({json:{}})
    })
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000})
    await page.locator('.settings-language-row .selector-trigger').waitFor({timeout:90000})
    await page.waitForFunction(id=>document.documentElement.dataset.colorScheme===id,theme==='dark'?'classic':'light')
    await page.locator('.settings-window-root').screenshot({path:path.join(out,`solid-${theme}.png`),animations:'disabled'})
    await writeFile(path.join(out,`solid-${theme}.aria.txt`),await page.locator('.settings-window-root').ariaSnapshot())
    await page.close()

    const tree=path.join(out,`rune-${theme}.json`)
    const png=path.join(out,`rune-${theme}.png`)
    const env={...process.env,CODENOMAD_PROFILE:'trial-settings-parity',RUNE_LOCALE:'en'}
    for(const key of Object.keys(env))if(key.startsWith('RUNE_')&&key!=='RUNE_LOCALE')delete env[key]
    await new Promise((resolve,reject)=>{
      const child=spawn(binary,['--gallery-preferences','--scene','settings','--theme',theme,'--tree',tree,'--snap',png,
        '--size','1100x760','--scale','1','--at','0.5'],{cwd:root,env,windowsHide:true,stdio:['ignore','ignore','inherit']})
      const timer=setTimeout(()=>{child.kill();reject(Error('Rune capture timeout'))},60000)
      child.once('error',error=>{clearTimeout(timer);reject(error)})
      child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error(`Rune exited ${code}`))})
    })
    const nodes=[]
    const walk=node=>{nodes.push(node);for(const child of node.children??[])walk(child)}
    walk(JSON.parse(await readFile(tree,'utf8')).accessibility)
    for(const [key,name,value] of [['locale-trigger','Language','English'],['palette-trigger','Color scheme','Classic']]){
      const node=nodes.find(node=>node.key===key)
      assert.equal(node?.name,name)
      assert.equal(node?.value,value)
      assert.equal(node?.role,'combo-box')
      assert(node.states.includes('collapsed'))
    }
  }
  console.log(out)
}finally {
  await browser?.close()
  await server.close()
}
