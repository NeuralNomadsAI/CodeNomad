// node --import tsx scripts/rune/parity/window-close.mjs [--binary ABSOLUTE_EXE]
import assert from 'node:assert/strict'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'
import {createSourceFixture,assertSourceDiagnostics} from './source-context.mjs'
import {requireTestSupport} from '../../../packages/rune-app/fixture-binaries.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const {values} = parseArgs({options: {binary: {type:'string'}}})
if(values.binary)requireTestSupport(values.binary)
const out = path.join(root, 'target/rune-source-theme-context/parity/window-close')
await mkdir(out, {recursive:true})
const inventory=JSON.parse(await readFile(path.join(root,'target/rune-inventory/components__window-close-button.json'),'utf8'))
const sourceHash=createHash('sha256').update((await readFile(path.join(root,inventory.source),'utf8')).replaceAll('\r\n','\n')).digest('hex')
assert.equal(sourceHash,inventory.sha256,'Regenerate the component inventory before parity capture')
const source=await createSourceFixture('packages/ui/tests/browser/fixtures/rune-window-close.tsx','rune-window-close-product')
let browser
const records=[]
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined})
  for (const theme of ['light','dark']) {
    const {page,diagnostics}=await source.open(browser,{theme},{width:100,height:100})
    const button=page.getByRole('button',{name:'Close',exact:true})
    for(let attempt=0;attempt<3;attempt++) {
      try {await button.waitFor({timeout:15000});break}
      catch(error) {if(attempt===2)throw error;await page.reload()}
    }
    const bounds=await button.boundingBox()
    assert(bounds && bounds.width===24 && bounds.height===24, 'CSS contract changed; review capture geometry')
    for(const state of ['rest','hover','focus']) {
      await page.mouse.move(90,90)
      if(state==='hover') await button.hover()
      if(state==='focus') await page.keyboard.press('Tab')
      assert.equal(await button.evaluate(e=>e.matches(':focus-visible')),state==='focus')
      const file=path.join(out,`solid-${theme}-${state}.png`)
      await button.screenshot({path:file,animations:'disabled'})
      const reference=await button.ariaSnapshot()
      const style=await button.evaluate(e=>{
        const s=getComputedStyle(e),svg=getComputedStyle(e.querySelector('svg'))
        return {width:s.width,height:s.height,color:s.color,background:s.backgroundColor,
          outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset,glyphWidth:svg.width}
      })
      await writeFile(path.join(out,`solid-${theme}-${state}.json`),JSON.stringify({reference,style,bounds},null,2))
      records.push({theme,state,solid:file,reference,style})
    }
    await button.click();await page.keyboard.press('Enter');await page.keyboard.press('Space')
    assert.equal(await page.evaluate(()=>window.runeWindowClose.presses),3)
    assertSourceDiagnostics(diagnostics)
    await page.close()
  }
  // The optional native half never opens a platform window: --snap invokes Rune tooling.
  if(values.binary) {
    assert(path.isAbsolute(values.binary),'--binary must be absolute')
    for(const record of records) {
      const {theme,state}=record
      const script=path.join(out,`${state}.json`)
      const events=state==='hover'?[{t:0.1,type:'move',key:'window-close'}]:
        state==='focus'?[{t:0.1,type:'key',name:'Tab'}]:[]
      await writeFile(script,JSON.stringify({events}))
      const tree=path.join(out,`rune-${theme}-${state}.json`)
      const snap=path.join(out,`rune-${theme}-${state}.png`)
      const env={...process.env,CODENOMAD_PROFILE:'trial-rune-parity',RUNE_LOCALE:'en'}
      for(const key of Object.keys(env))if(key.startsWith('RUNE_')&&key!=='RUNE_LOCALE')delete env[key]
      const output=await new Promise((resolve,reject)=>{
        const child=spawn(values.binary,['--gallery-window-close','--script',script,'--theme',theme,
          '--tree',tree,'--snap',snap,'--size','24x24','--scale','1','--at','0.5'],
          {cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
        let log='';const timer=setTimeout(()=>{child.kill();reject(Error('native capture timeout'))},60000)
        for(const stream of [child.stdout,child.stderr])stream.on('data',v=>log+=v)
        child.once('error',e=>{clearTimeout(timer);reject(e)})
        child.once('close',code=>{clearTimeout(timer);code===0?resolve(log):reject(Error(log))})
      })
      await writeFile(path.join(out,`rune-${theme}-${state}.log`),output)
      const actual=JSON.parse(await readFile(tree,'utf8'))
      const nodes=[];function walk(n){if(!n)return;nodes.push(n);for(const c of n.children??[])walk(c)}
      walk(actual.accessibility)
      const node=nodes.find(n=>n.key==='window-close')
      assert.equal(node?.role,'button');assert.equal(node.name,'Close')
      assert.equal(node.description,'Close')
      assert.deepEqual(node.bounds,[0,0,24,24])
      assert(node.actions.includes('click')&&node.actions.includes('focus'))
      assert.equal(Boolean(node.states?.includes('focused')),state==='focus')
      assert.equal(nodes.filter(n=>n.role==='button').length,1)
      record.rune=snap;record.accessibility=node
    }
  }
  await writeFile(path.join(out,'evidence.json'),JSON.stringify({
    status:values.binary?'captures-pending-pixel-review':'solid-only-unqualified',
    sourceContext:{provenance:source.provenance,dependencies:source.dependencies},inventory:{source:inventory.source,sha256:sourceHash},records,
    verified:['actual Solid component, styles, providers','Solid pointer/Enter/Space',
      ...(values.binary?['actual Rune accessibility role/name/description/actions/bounds/focus states','native offscreen light/dark rest/hover/focus captures']:[])],
    pending:values.binary?['pixel comparison','Rune interaction test']:['native execution','pixel comparison','Rune interaction test']
  },null,2))
  console.log(out)
} catch(error) {console.error(error);throw error}
finally {await browser?.close();await source.close()}
