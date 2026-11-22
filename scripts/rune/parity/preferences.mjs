import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {root} from '../generate-common.mjs'
import {installPngReader} from '../png-pixels.mjs'
import {requireTestSupport} from '../../../packages/rune-app/fixtures/fixture-binaries.mjs'

const {values:{binary,section='general'}}=parseArgs({options:{binary:{type:'string'},section:{type:'string'}}})
assert(binary&&path.isAbsolute(binary),'Supply --binary ABSOLUTE_EXE')
assert(['general','opencode'].includes(section),'Unknown preferences section')
requireTestSupport(binary)
const ui=path.join(root,'packages/ui')
const out=path.join(root,'target/rune-parity/preferences',section==='general'?'':'opencode')
await mkdir(out,{recursive:true})
const {startFixtureDaemon}=await import('../../../packages/ui/tests/browser/fixture-daemon/server.ts')
const fixture='/tests/browser/fixtures/preferences-window.tsx'
const server=await startFixtureDaemon({directory:ui})
let browser
const evidence=[]
try {
  const url=await server.register({name:'rune-preferences',routes:[{path:'/rune-preferences',
    html:`<html><body><div id="root" style="height:100vh"></div><script type="module" src="${fixture}"></script></body></html>`}]})
  browser=await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined})
  for(const theme of ['light','dark']) {
    const page=await browser.newPage({viewport:{width:1100,height:760},locale:'en-US',colorScheme:theme,reducedMotion:'reduce'})
    page.on('pageerror',error=>console.error(error.message))
    await page.addInitScript(section=>{
      window.__CODENOMAD_RUNTIME_HOST__='electron'
      window.__CODENOMAD_WINDOW_CONTEXT__='preferences'
      window.electronAPI={
        getPreferencesRequest:async()=>({section}),acceptPreferencesRequest:async()=>{},
        preferencesReady:async()=>{},onPreferencesSection:()=>()=>{},onPreferencesCloseRequested:()=>()=>{},
        onPreferencesTransitionRequested:()=>()=>{},closeWindow:async()=>{},
      }
    },section)
    await page.route('**/api/**',route=>{
      const target=new URL(route.request().url()).pathname
      if(!target.startsWith('/api/'))return route.continue()
      if(target==='/api/storage/config/ui')return route.fulfill({json:{settings:{locale:'en'}}})
      if(target==='/api/storage/state/ui')return route.fulfill({json:{appearancePreferences:{mode:'system',
        light:{scheme:{id:'light'}},dark:{scheme:{id:'classic'}}}}})
      if(target==='/api/meta')return route.fulfill({json:{apiContract:1,capabilities:['opencode-admin'],localRequest:true}})
      if(target==='/api/opencode/update')return route.fulfill({json:{
        state:'ready',serviceState:'ready',currentVersion:'2.3.0',daemonVersion:'2.2.5',
        minimumVersion:'2.2.3',recommendedVersion:'2.2.5',target:'host',binaryPath:'opencode2',
      }})
      return route.fulfill({json:{}})
    })
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000})
    if(section==='general')await page.locator('.settings-language-row .selector-trigger').waitFor({timeout:90000})
    else await page.getByText('2.3.0',{exact:true}).first().waitFor({timeout:90000})
    await page.waitForFunction(id=>document.documentElement.dataset.colorScheme===id,theme==='dark'?'classic':'light')
    const solidPng=path.join(out,`solid-${theme}.png`)
    const sourceBounds=await page.evaluate(()=>Object.fromEntries(Object.entries({
      locale:'.settings-language-row .selector-trigger',
      mode:'.theme-scheme-mode .theme-scheme-appearance-options',
      palette:'.theme-scheme-picker',
    }).map(([key,query])=>{
      const {x,y,width,height}=document.querySelector(query).getBoundingClientRect()
      return [key,[x,y,width,height]]
    })))
    await page.locator('.settings-window-root').screenshot({path:solidPng,animations:'disabled'})
    await writeFile(path.join(out,`solid-${theme}.aria.txt`),await page.locator('.settings-window-root').ariaSnapshot())
    await page.close()

    const tree=path.join(out,`rune-${theme}.json`)
    const png=path.join(out,`rune-${theme}.png`)
    const env={...process.env,CODENOMAD_PROFILE:'trial-settings-parity',RUNE_LOCALE:'en'}
    for(const key of Object.keys(env))if(key.startsWith('RUNE_')&&key!=='RUNE_LOCALE')delete env[key]
    await new Promise((resolve,reject)=>{
      const child=spawn(binary,['--gallery-preferences','--scene',section==='general'?'settings':'opencode','--theme',theme,'--tree',tree,'--snap',png,
        '--size','1100x760','--scale','1','--at','0.5'],{cwd:root,env,windowsHide:true,stdio:['ignore','ignore','inherit']})
      const timer=setTimeout(()=>{child.kill();reject(Error('Rune capture timeout'))},60000)
      child.once('error',error=>{clearTimeout(timer);reject(error)})
      child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error(`Rune exited ${code}`))})
    })
    const nodes=[]
    const walk=node=>{nodes.push(node);for(const child of node.children??[])walk(child)}
    walk(JSON.parse(await readFile(tree,'utf8')).accessibility)
    if(section==='general'){
      for(const [key,name,value] of [['locale-trigger','Language','English'],['palette-trigger','Color scheme','Classic']]){
        const node=nodes.find(node=>node.key===key)
        assert.equal(node?.name,name)
        assert.equal(node?.value,value)
        assert.equal(node?.role,'combo-box')
        assert(node.states.includes('collapsed'))
      }
    }else{
      assert(nodes.some(node=>node.name==='2.3.0'))
      assert(nodes.some(node=>node.name==='2.2.5'))
      assert(nodes.find(node=>node.name==='Version details')?.states.includes('collapsed'))
    }
    const actualBounds={
      locale:nodes.find(node=>node.key==='locale-trigger').bounds,
      mode:nodes.find(node=>node.role==='radio-group'&&node.name==='Mode').bounds,
      palette:nodes.find(node=>node.key==='palette-trigger').bounds,
    }
    const pixels=await browser.newPage()
    try{
      await installPngReader(pixels)
      const sources=await Promise.all([solidPng,png].map(async file=>'data:image/png;base64,'+(await readFile(file)).toString('base64')))
      const {metrics,blankInk}=await pixels.evaluate(async({sources,sourceBounds,actualBounds})=>{
        const [solid,rune]=await __codenomadReadPngs(sources)
        const measure=(img,[x,y,w,h],column,row,columns,rows)=>{
          const index=(Math.floor(y+(row+.5)*h/rows)*img.width+Math.floor(x+(column+.5)*w/columns))*4
          return img.pixels.subarray(index,index+3)
        }
        const compare=(key,flattened)=>{
          const box=sourceBounds[key],actual=actualBounds[key]
          const [width,height]=box.slice(2).map(Math.round)
          let different=0, totalDelta=0, visibleInk=0
          const corner=measure(rune,actual,2,2,width,height)
          for(let row=0;row<height;row++)for(let column=0;column<width;column++){
            const expected=measure(solid,box,column,row,width,height)
            const value=flattened?corner:measure(rune,actual,column,row,width,height)
            const delta=Math.max(...value.map((c,index)=>Math.abs(c-expected[index])))
            totalDelta+=delta
            if(delta>32)different++
            if(Math.max(...value.map((c,index)=>Math.abs(c-corner[index])))>64)visibleInk++
          }
          const total=width*height
          return {meanDelta:totalDelta/total,different:different/total,visibleInk,
            widthDifference:Math.abs(box[2]-actual[2]),heightDifference:Math.abs(box[3]-actual[3]),
            leadingDifference:Math.abs(box[0]-actual[0]),
            rowDifference:Math.abs((box[1]-sourceBounds.locale[1])-(actual[1]-actualBounds.locale[1]))}
        }
        const keys=Object.keys(sourceBounds)
        return {metrics:Object.fromEntries(keys.map(key=>[key,compare(key,false)])),
          blankInk:Object.fromEntries(keys.map(key=>[key,compare(key,true).visibleInk]))}
      },{sources,sourceBounds,actualBounds})
      evidence.push({theme,sourceBounds,actualBounds,metrics,blankInk})
    }finally{await pixels.close()}
  }
  // Windows at scale 1. Kit metrics differ from Solid; guard just the three ported controls.
  const budgets={
    locale:{meanDelta:14,different:.09,visibleInk:80,widthDifference:2,heightDifference:9,leadingDifference:13,rowDifference:0},
    mode:{meanDelta:29,different:.14,visibleInk:240,widthDifference:52,heightDifference:3,leadingDifference:6,rowDifference:13},
    palette:{meanDelta:11,different:.07,visibleInk:65,widthDifference:22,heightDifference:2,leadingDifference:3,rowDifference:29},
  }
  await writeFile(path.join(out,'regional-pixels.json'),JSON.stringify({budgets,evidence},null,2)+'\n')
  for(const {theme,metrics,blankInk} of evidence)for(const [control,budget] of Object.entries(budgets)){
    assert(blankInk[control]<budget.visibleInk,`${theme} ${control}: blank control must fail`)
    for(const [metric,threshold] of Object.entries(budget)){
      const observed=metrics[control][metric]
      assert(metric==='visibleInk'?observed>=threshold:observed<=threshold,
        `${theme} ${control} ${metric}: got ${observed}, budget ${threshold}`)
    }
  }
  console.log(out)
}finally {
  await browser?.close()
  await server.close()
}
