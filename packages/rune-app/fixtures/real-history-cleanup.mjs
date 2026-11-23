import assert from 'node:assert/strict'
import path from 'node:path'
import {args,privateManifest,requirePrivateCli,withNative} from './live-access.mjs'
export async function cleanupRealHistory(file) {
  requirePrivateCli()
  const manifest=await privateManifest(file)
  assert.equal(manifest.seedCount,600)
  await withNative(async native=>{
  assert.equal(manifest.project,native.project)
  const transfer=(await native.read(`/api/experimental/session/${manifest.sessionID}/export`)).data
  assert.equal(transfer.info.location.directory,manifest.project)
  assert.equal(transfer.info.title,'Rune disposable stored-history test')
  assert.deepEqual(transfer.info.permissions,[{action:'*',resource:'*',effect:'deny'}])
  assert.equal(transfer.messages.length,603)
  assert.deepEqual(transfer.messages.slice(0,600).map(m=>m.id),manifest.seedIDs)
  const added=transfer.messages.slice(600)
  assert.equal(added.filter(m=>m.type==='user').length,1)
  assert(added.find(m=>m.type==='user').text.includes('RUNE-REAL-REPRISE'))
  await native.read(`/api/session/${manifest.sessionID}`,{method:'DELETE'})
  const original=await privateManifest(path.join(manifest.profile,'session.json'))
  const empty=(await native.read(`/api/experimental/session/${original.sessionID}/export`)).data
  assert.equal(empty.info.location.directory,manifest.project)
  assert.equal(empty.info.title,'Rune real-history disposable test')
  assert.equal(empty.messages.length,0)
  await native.read(`/api/session/${original.sessionID}`,{method:'DELETE'})
  console.log(JSON.stringify({result:'private-history-sessions-cleaned',sessions:2,permissions:'deny-all verified after execution'}))
  },{profile:manifest.profile})
}
if(args.includes('--cleanup'))await cleanupRealHistory(args[args.indexOf('--cleanup')+1])
