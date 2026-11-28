import assert from 'node:assert/strict'
import {spawnFixtureChild as spawn} from '../../native-fixture-guards.mjs'
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {privateEnvironment} from '../../../packages/rune-app/fixtures/private-profile.mjs'
const root=fileURLToPath(new URL('../../../',import.meta.url)),out=path.join(root,'target/rune-parity/file-row-actions-native')
const {values}=parseArgs({options:{binary:{type:'string'}}})
assert(values.binary&&path.isAbsolute(values.binary),'--binary requires an absolute offscreen gallery')
await mkdir(out,{recursive:true})
const binary=path.join(out,`gallery${process.platform==='win32'?'.exe':''}`)
await copyFile(values.binary,binary)
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const inputs=['crates/rune-theme-codenomad/assets/theme.json','crates/rune-theme-codenomad/src/file_row_actions/mod.rs','crates/rune-theme-codenomad/src/file_row_actions/view.rs','crates/rune-theme-codenomad/src/file_row_actions/icons.rs','crates/rune-theme-codenomad/examples/file-row-actions.rs','scripts/rune/parity/file-row-actions-native.mjs']
const provenance={binary:{path:binary,sha256:digest(await readFile(binary))},inputs:Object.fromEntries(await Promise.all(inputs.map(async file=>[file,digest(await readFile(path.join(root,file)))])))}
const records=[]
const tab=t=>({t,type:'key',name:'Tab'}),focus=[tab(.1),tab(.2),tab(.3)]
const click=(key,t=.1)=>({t,type:'click',key})
for(const theme of ['light','dark'])for(const rtl of [false,true])for(const mode of ['rest','hover','focus-inline','compact','menu','checked']){
  const id=`${theme}-${rtl?'rtl':'ltr'}-${mode}`,base=path.join(out,id)
  const width=mode==='checked'?400:['compact','menu'].includes(mode)?110:360
  const events=mode==='hover'?[{t:.1,type:'move',key:'row'}]:['focus-inline','compact'].includes(mode)?focus:mode==='menu'?[click('files:trigger')]:mode==='checked'?[click('files:pinned:preview')]:[]
  await writeFile(base+'.script.json',JSON.stringify({events},null,2)+'\n')
  const env={...await privateEnvironment(path.join(out,'profiles',id)),RUNE_ACTIONS_WIDTH:String(width),RUNE_ACTIONS_RTL:String(rtl)}
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(binary,['--script',base+'.script.json','--tree',base+'.json','--snap',base+'.png','--size','480x260','--theme',theme,'--scale','1','--at','.55'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let log='';const timer=setTimeout(()=>{child.kill();reject(Error('Owned offscreen gallery timeout'))},60000)
    for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes)
    child.on('error',error=>{clearTimeout(timer);reject(error)})
    child.on('close',code=>{clearTimeout(timer);resolve({code,log})})
  })
  await writeFile(base+'.log',result.log);assert.equal(result.code,0,result.log)
  const tree=JSON.parse(await readFile(base+'.json','utf8'))
  const row=tree.elements.find(e=>e.key==='row'),group=tree.elements.find(e=>e.key==='files:actions')
  assert.deepEqual(row.rect,[0,0,width,30]);assert(group)
  assert.equal(tree.animating,false,`${id}: settled component required`)
  assert(!tree.elements.some(e=>e.moving||e.exiting),`${id}: completed transitions required`)
  if(['focus-inline','compact'].includes(mode))assert(tree.elements.some(e=>e.key===(mode==='compact'?'files:trigger':'files:inline:open')&&e.focused),`${id}: expected focus`)
  if(mode==='menu')assert(tree.elements.some(e=>e.role==='menu'),`${id}: pointer must open popup`)
  const trace=result.log.split(/\r?\n/).filter(l=>l.startsWith('file-actions-event:')).map(l=>JSON.parse(l.slice('file-actions-event:'.length)))
  assert(!trace.some(e=>['row','open','copy','disabled'].includes(e.event)),`${id}: no unintended action`)
  assert.equal(trace.filter(e=>e.event==='preview').length,mode==='checked'?1:0)
  records.push({id,theme,rtl,mode,width,image:base+'.png',tree:base+'.json',geometry:tree.elements,accessibility:tree.accessibility,trace})
}
await writeFile(path.join(out,'native-evidence.json'),JSON.stringify({provenance,records},null,2)+'\n')
console.log(`${records.length} offscreen file-action captures`)
