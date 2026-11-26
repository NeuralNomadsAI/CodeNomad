// Exercise default artifacts before the qualification feature overwrites their paths.
import assert from 'node:assert/strict'
import {spawnFixtureChild as spawn} from '../native-fixture-guards.mjs'
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {privateEnvironment} from '../../packages/rune-app/fixtures/private-profile.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const {values} = parseArgs({options: {binary: {type:'string'}, wasm: {type:'string'}, out: {type:'string',default:'target/rune-production'}}})
for(const name of ['binary','wasm'])assert(values[name]&&path.isAbsolute(values[name]),`Pass --${name} with the absolute default-build artifact`)
const out=path.resolve(root,values.out)
const relative=path.relative(path.join(root,'target'),out)
assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Production evidence must stay under checkout target')
await mkdir(out,{recursive:true})
const profile=await mkdtemp(path.join(out,'trial-'))
const env=await privateEnvironment(profile)
const records=[]
async function run(args){
  return await new Promise((resolve,reject)=>{
    const child=spawn(values.binary,args,{cwd:profile,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let output=''
    const deadline=setTimeout(()=>{child.kill();reject(Error('Default artifact headless deadline'))},60_000)
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;if(output.length>1024*1024)child.kill()})
    child.once('error',error=>{clearTimeout(deadline);reject(error)})
    child.once('close',code=>{clearTimeout(deadline);resolve({code,output})})
  })
}
for(const [name,args]of [
  ['capability',['--test-support-info']],
  ['native-probe',['--probe-contract']],
  ['gallery',['--gallery-window-close']],
  ['action-menu-gallery',['--gallery-action-menu']],
  ['reader-gallery',['--gallery-reader']],
  ['synthetic',['--scene','synthetic']],
]){
  // --tree guarantees an accidentally permissive CLI still avoids a native window.
  const result=await run([...args,'--tree',path.join(profile,`${name}.json`),'--at','0'])
  assert.equal(result.code,2,`Default product must reject ${name} qualification arguments`)
  records.push({name,exitCode:result.code,refused:true})
}
const tree=path.join(profile,'product-tree.json')
assert.equal((await run(['--tree',tree,'--at','0'])).code,0,'Product must retain real Rune inspection tooling')
const inspection=JSON.parse(await readFile(tree,'utf8'))
assert(inspection.accessibility,'Product --tree must expose the actual accessibility tree')
assert(!JSON.stringify(inspection).includes('Synthetic message '),'Default inspector must render the product launcher')
for(const kind of ['binary','wasm']){
  const artifact=await readFile(values[kind])
  for(const marker of ['Synthetic message ','nativeProbes','real history operation failed:','action-menu-event:','reader-gallery-scene','Rune web focus fixture']){
    assert(!artifact.includes(Buffer.from(marker)),`${kind} default artifact retains qualification marker ${marker}`)
  }
}
await writeFile(path.join(out,'production-report.json'),JSON.stringify({records,realInspection:true,
  nativeAndWasmQualificationMarkersAbsent:true,profile},null,2)+'\n')
console.log(`Default Rune product isolation evidence: ${out}`)
