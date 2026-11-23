// Actual reader views, captured offscreen; pixel comparison uses its own qualification gate.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {privateEnvironment} from '../../../packages/rune-app/fixtures/private-profile.mjs'

const root=fileURLToPath(new URL('../../../',import.meta.url))
const {values}=parseArgs({options:{binary:{type:'string'},locales:{type:'string',default:'en,fr,he'}}})
assert(values.binary&&path.isAbsolute(values.binary),'Pass the absolute test-support --binary')
const locales=values.locales.split(',')
for(const locale of locales)assert(['en','fr','he'].includes(locale),'Explicit scene locale required')
const out=path.join(root,'target/rune-reader-scenes');await mkdir(out,{recursive:true})
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const binary=await readFile(values.binary),themeFile=await readFile(path.join(root,'crates/rune-theme-codenomad/assets/theme.json'))
assert(binary.includes(themeFile), 'The qualification binary must embed the current generated theme')
const records=[],provenance={binary:{path:values.binary,sha256:hash(binary)},
  fixtureSha256:hash(await readFile(fileURLToPath(import.meta.url))),
  themeSha256:hash(themeFile)}
const cases=['source','markup.md','valid.mmd','unsupported.mmd','unreadable.mmd','small.png','large.png','sample.svg','sample.avif','nul.bin','broken.png','error']
async function run(args,name,scene,locale){
  const env={...await privateEnvironment(path.join(out,'profiles',name)),RUNE_READER_CASE:scene,RUNE_READER_LOCALE:locale}
  return await new Promise((resolve,reject)=>{
    const child=spawn(values.binary,['--gallery-reader',...args],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let log=''
    const timer=setTimeout(()=>{child.kill();reject(Error('Owned reader scene exceeded 60 seconds'))},60000)
    for(const pipe of [child.stdout,child.stderr])pipe.on('data',bytes=>log=(log+bytes).slice(-1048576))
    child.once('error',error=>{clearTimeout(timer);reject(error)})
    child.once('close',code=>{clearTimeout(timer);resolve({code,log})})
  })
}
function nodes(node){return [node,...(node.children??[]).flatMap(nodes)]}
function visible(node){return node.rect[2]>0&&node.rect[3]>0&&node.rect[1]<700&&node.rect[1]+node.rect[3]>0&&node.opacity>0}
const rejected=await run([],'safe-flags','source','en');assert.equal(rejected.code,2,rejected.log)
for(const locale of locales){
  const catalogue=JSON.parse(await readFile(path.join(root,`crates/rune-theme-codenomad/assets/catalogues/${locale}.json`),'utf8'))
  for(const theme of ['light','dark'])for(const scene of cases){
    const name=`${locale}-${theme}-${scene.replaceAll('.','-')}`,base=path.join(out,name),tree=`${base}.json`,image=`${base}.png`
    let data,at
    for(at of [2,4,8]){
      const result=await run(['--tree',tree,'--snap',image,'--size','1000x700','--theme',theme,'--scale','1','--at',String(at)],name,scene,locale)
      await writeFile(`${base}.log`,result.log);assert.equal(result.code,0,result.log)
      data=JSON.parse(await readFile(tree,'utf8'))
      if(!data.animating&&!data.elements.some(node=>node.moving||node.exiting))break
    }
    assert(!data.animating&&!data.elements.some(node=>node.moving||node.exiting),`${name}: settled scene required`)
    const accessible=nodes(data.accessibility)
    assert(data.elements.some(node=>node.key?.startsWith('file-reader-')&&visible(node)),`${name}: actual reader required`)
    assert(accessible.some(node=>node.role==='region'&&node.name===catalogue['filesPanel.viewer']),`${name}: named reader region`)
    assert(accessible.some(node=>node.key==='file-close'&&node.name===catalogue['gitPanel.backChat']),`${name}: localized return action`)
    assert(!accessible.some(node=>node.key==='history'),`${name}: hidden history stays outside accessibility`)
    if(['small.png','large.png','sample.svg','sample.avif'].includes(scene))assert(data.elements.some(node=>node.role==='img'&&visible(node)),`${name}: decoded visible image`)
    if(scene==='error'||scene==='unsupported.mmd'||scene==='unreadable.mmd')assert(accessible.some(node=>node.role==='alert'),`${name}: accessible error`)
    if(scene.endsWith('.mmd')&&scene!=='valid.mmd')assert(data.elements.some(node=>node.key==='file-source-text'),`${name}: selectable source`)
    if(scene==='source')assert(data.elements.some(node=>node.role==='textbox'&&node.path.includes('/file-editor/')&&node.text.includes('fn main()')),`${name}: actual editable document`)
    records.push({scene,locale,theme,tree,image,log:`${base}.log`,at,accessibility:true,
      treeSha256:hash(await readFile(tree)),imageSha256:hash(await readFile(image))})
  }
}
await writeFile(path.join(out,'captures.json'),JSON.stringify({provenance,records,pixelQualification:'pending',
  gates:['1359 button pressed state in WASM','1360 host-scoped floating drawer','complete Source renderer and accessibility parity']},null,2)+'\n')
console.log(JSON.stringify({scenes:records.length,out}))
