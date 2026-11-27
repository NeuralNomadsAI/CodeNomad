import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import path from 'node:path'
import {args,ensurePrivateGitRepo,withNative} from './live-access.mjs'
export async function prepareLive(native) {
  const {profile,project}=native
  await ensurePrivateGitRepo(project,profile,native.runtimeEnv)
  const location={directory:project}
  await native.read(`/api/location?${new URLSearchParams({'location[directory]':project})}`)
  const created=await native.read('/api/session',{method:'POST',body:JSON.stringify({location,title:'Rune disposable live test',permissions:[{action:'*',resource:'*',effect:'deny'}]})})
  const session=created.data??created
  assert.equal(session.location.directory.toLowerCase(),project.toLowerCase())
  assert.deepEqual(session.permissions,[{action:'*',resource:'*',effect:'deny'}],'all native actions must be explicitly denied')
  const plugins=await native.read(`/api/plugin?${new URLSearchParams({'location[directory]':project})}`)
  await writeFile(path.join(profile,'session.json'),JSON.stringify({profile,project,sessionID:session.id}))
  console.log(JSON.stringify({profile,project,sessionID:session.id,permissions:session.permissions,model:session.model,
    plugins:(plugins.data??[]).map(p=>({id:p.id,status:p.state?.status}))},null,2))
  return {...native,profile,project,sessionID:session.id}
}
if(args.includes('--prepare'))await withNative(prepareLive)
