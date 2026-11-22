import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,mkdir,writeFile,copyFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {privateEnvironment} from '../../../packages/rune-app/private-profile.mjs'
const root=fileURLToPath(new URL('../../../',import.meta.url))
const {values}=parseArgs({options:{binary:{type:'string'}}})
assert(values.binary&&path.isAbsolute(values.binary),'--binary requires absolute offscreen example path')
const out=path.join(root,'target/rune-parity/workspace-tree-row');await mkdir(out,{recursive:true})
const binary=path.join(out,`workspace-tree-row-gallery${process.platform==='win32'?'.exe':''}`),bytes=await readFile(values.binary)
await copyFile(values.binary,binary)
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const inputs=['crates/rune-theme-codenomad/assets/theme.json','crates/rune-theme-codenomad/src/workspace_tree.rs','crates/rune-theme-codenomad/src/workspace_tree_icons.rs','crates/rune-theme-codenomad/examples/workspace-tree-row.rs','scripts/rune/parity/workspace-tree-row-native.mjs']
const provenance={binary:{path:binary,source:values.binary,sha256:digest(bytes)},inputs:Object.fromEntries(await Promise.all(inputs.map(async file=>[file,digest(await readFile(path.join(root,file)))])))}
const records=[]
for(const theme of ['light','dark'])for(const rtl of [false,true])for(const mode of ['closed','open','file','busy','focus']){
  const id=`${theme}-${rtl?'rtl':'ltr'}-${mode}`,base=path.join(out,`native-${id}`)
  const env={...await privateEnvironment(path.join(out,'profiles',id)),RUNE_ROW_CASE:mode,RUNE_ROW_RTL:String(rtl)}
  const args=['--tree',`${base}.json`,'--snap',`${base}.png`,'--size','360x30','--theme',theme,'--scale','1','--at','0']
  if(mode==='focus'){
    await writeFile(`${base}.script.json`,JSON.stringify({events:[{t:0,type:'key',name:'Tab'}]}))
    args.push('--script',`${base}.script.json`,'--at','0.2')
  }
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let log='';const timer=setTimeout(()=>{child.kill();reject(Error('Owned offscreen gallery timeout'))},30000)
    child.stdout.on('data',bytes=>log+=bytes);child.stderr.on('data',bytes=>log+=bytes)
    child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,log})})
  })
  await writeFile(`${base}.log`,result.log);assert.equal(result.code,0,result.log)
  const tree=JSON.parse(await readFile(`${base}.json`,'utf8'))
  const row=tree.elements.find(e=>e.key==='row');assert(row)
  assert.deepEqual(row.rect,[0,0,360,30])
  records.push({id,theme,rtl,mode,image:`${base}.png`,tree:`${base}.json`,geometry:tree.elements,accessibility:tree.accessibility})
}
await writeFile(path.join(out,'native-evidence.json'),JSON.stringify({provenance,records},null,2)+'\n')
console.log(`${records.length} offscreen row captures`)
