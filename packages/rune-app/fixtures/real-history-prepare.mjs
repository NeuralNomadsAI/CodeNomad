// Prepare only an owned disposable Location; reuse the existing daemon without changing its configuration.
import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {connectNative} from './live-access.mjs'

export async function prepareRealHistory() {
  const native=await connectNative()
  const here=path.resolve(import.meta.dirname,'..')
  const profile=path.join(here,'fixture-profile',`real-history-${randomUUID()}`)
  const project=path.join(profile,'project')
  const plugins=path.join(project,'.opencode','plugins')
  await mkdir(plugins,{recursive:true})
  await promisify(execFile)('git',['init','--quiet',project],{windowsHide:true,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL'}})
  const {build}=await import('file:///D:/CodeNomad/node_modules/esbuild/lib/main.js')
  await build({entryPoints:[path.resolve(here,'../server/src/opencode/session-pruning/plugin.ts')],
    outfile:path.join(plugins,'codenomad-session-pruning.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',
    external:['effect','@opencode/plugin'],loader:{'.md':'text'},nodePaths:['D:/CodeNomad/node_modules'],logLevel:'silent',
    banner:{js:'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);'}})
  const query=new URLSearchParams({'location[directory]':project})
  await native.read(`/api/location?${query}`)
  let catalogue
  for(const end=Date.now()+15000;;){
    catalogue=await native.read(`/api/plugin?${query}`)
    if(catalogue.data?.some(p=>p.id==='codenomad-session-pruning'&&p.state?.status==='active'))break
    if(Date.now()>=end)break
    await new Promise(r=>setTimeout(r,250))
  }
  const session=(await native.read('/api/session',{method:'POST',body:JSON.stringify({location:{directory:project},title:'Rune real-history disposable test',permissions:[{action:'*',resource:'*',effect:'deny'}]})})).data
  assert.deepEqual(session.permissions,[{action:'*',resource:'*',effect:'deny'}])
  const manifest={profile,project,sessionID:session.id,info:session,pluginActive:catalogue.data?.some(p=>p.id==='codenomad-session-pruning'&&p.state?.status==='active')??false}
  await writeFile(path.join(profile,'session.json'),JSON.stringify(manifest))
  console.log(JSON.stringify({type:'REAL_HISTORY_PREPARED',profile,sessionID:session.id,pluginActive:manifest.pluginActive,
    plugins:catalogue.data?.filter(p=>p.id==='codenomad-session-pruning').map(p=>({id:p.id,status:p.state?.status,error:p.state?.error?.message}))}))
  return {...native,...manifest}
}
if(process.argv.includes('--prepare'))await prepareRealHistory()
