import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {args,privateManifest,requirePrivateCli,withNative} from './live-access.mjs'
export async function seedRealHistory(native,manifest) {
  assert.equal(manifest.project,native.project)
  assert(manifest.pluginActive,'history plugin must be active in the disposable Location')
  const transfer=(await native.read(`/api/experimental/session/${manifest.sessionID}/export`)).data
  assert.equal(transfer.messages.length,0,'seed only a newly created empty test session')
  const prefix=randomUUID().replaceAll('-','').slice(0,18)
  const messages=Array.from({length:600},(_,i)=>({id:`msg_${prefix}${i.toString(16).padStart(8,'0')}`,type:'user',
    time:{created:Date.now()-60000+i},text:`Archive de test ${String(i).padStart(4,'0')}\nDonnée factice sans action à effectuer.`}))
  const info={...transfer.info,id:`ses_${randomUUID().replaceAll('-','').slice(0,26)}`,title:'Rune disposable stored-history test',
    permissions:[{action:'*',resource:'*',effect:'deny'}],time:{...transfer.info.time,idle:Date.now()}}
  const imported=(await native.read('/api/experimental/session/import',{method:'POST',body:JSON.stringify({info,messages,location:{directory:manifest.project}})})).data
  assert.deepEqual(imported.permissions,[{action:'*',resource:'*',effect:'deny'}])
  const query=new URLSearchParams({'location[directory]':manifest.project})
  const page=(await native.read(`/api/rpc/codenomad.session-pruning/window?${query}`,{method:'POST',body:JSON.stringify({input:{sessionID:imported.id,target:{kind:'latest'}}})})).output
  assert.equal(page.status,'window');assert.equal(page.messages.length,200)
  assert.equal(page.messages[0].id,messages[400].id)
  const next={profile:manifest.profile,project:manifest.project,sessionID:imported.id,info:imported,
    pluginActive:manifest.pluginActive,seedIDs:messages.map(m=>m.id),seedCount:600}
  await writeFile(path.join(manifest.profile,'seeded.json'),JSON.stringify(next))
  console.log(JSON.stringify({type:'REAL_HISTORY_SEEDED',rows:600,pageRows:200,permissions:'deny-all',manifest:path.join(manifest.profile,'seeded.json')}))
  return {...native,...next}
}
if(args.includes('--seed')){
  requirePrivateCli()
  const manifest=await privateManifest(args[args.indexOf('--seed')+1])
  await withNative(native=>seedRealHistory(native,manifest),{profile:manifest.profile})
}
