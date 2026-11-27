// Prepare a session in the disposable daemon used by the history probes.
import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import path from 'node:path'
import {args,ensurePrivateGitRepo,withNative} from './live-access.mjs'

export async function prepareRealHistory(native) {
  const {profile,project}=native
  await ensurePrivateGitRepo(project,profile,native.runtimeEnv)
  const query=new URLSearchParams({'location[directory]':project})
  await native.read(`/api/location?${query}`)
  const catalogue=await native.read(`/api/plugin?${query}`)
  assert(catalogue.data?.some(p=>p.id==='codenomad-session-pruning'&&p.state?.status==='active'))
  const session=(await native.read('/api/session',{method:'POST',body:JSON.stringify({location:{directory:project},title:'Rune real-history disposable test',permissions:[{action:'*',resource:'*',effect:'deny'}]})})).data
  assert.deepEqual(session.permissions,[{action:'*',resource:'*',effect:'deny'}])
  const manifest={profile,project,sessionID:session.id,info:session,pluginActive:catalogue.data?.some(p=>p.id==='codenomad-session-pruning'&&p.state?.status==='active')??false}
  await writeFile(path.join(profile,'session.json'),JSON.stringify(manifest))
  console.log(JSON.stringify({type:'REAL_HISTORY_PREPARED',profile,sessionID:session.id,pluginActive:manifest.pluginActive,
    plugins:catalogue.data?.filter(p=>p.id==='codenomad-session-pruning').map(p=>({id:p.id,status:p.state?.status,error:p.state?.error?.message}))}))
  return {...native,...manifest}
}
if(args.includes('--prepare'))await withNative(prepareRealHistory)
