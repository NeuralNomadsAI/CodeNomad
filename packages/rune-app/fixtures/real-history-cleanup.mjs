import assert from 'node:assert/strict'
import path from 'node:path'
import {args,privateManifest,requirePrivateCli,withNative} from './live-access.mjs'
export async function cleanupRealHistory(file) {
  requirePrivateCli()
  const manifest=await privateManifest(file)
  assert.equal(manifest.seedCount,600)
  const original=await privateManifest(path.join(manifest.profile,'session.json'))
  assert.equal(original.project,manifest.project)
  await withNative(async native=>{
  assert.equal(manifest.project,native.project)
  const removeIfPresent=async id=>{
    const response=await native.send(`/api/session/${id}`,{method:'DELETE'})
    if(response.status===404)return false
    assert(response.ok,`Private OpenCode DELETE /api/session/${id}: HTTP ${response.status}`)
    return true
  }
  const seededCheck=await native.send(`/api/experimental/session/${manifest.sessionID}/export`)
  if(seededCheck.status!==404){
    assert(seededCheck.ok,`Private OpenCode export ${manifest.sessionID}: HTTP ${seededCheck.status}`)
    const transfer=(await seededCheck.json()).data
    assert.equal(transfer.info.location.directory,manifest.project)
    assert.equal(transfer.info.title,'Rune disposable stored-history test')
    assert.deepEqual(transfer.info.permissions,[{action:'*',resource:'*',effect:'deny'}])
    assert.equal(transfer.messages.length,603)
    assert.deepEqual(transfer.messages.slice(0,600).map(m=>m.id),manifest.seedIDs)
    const added=transfer.messages.slice(600)
    assert.equal(added.filter(m=>m.type==='user').length,1)
    assert(added.find(m=>m.type==='user').text.includes('RUNE-REAL-REPRISE'))
  }
  const originalCheck=await native.send(`/api/experimental/session/${original.sessionID}/export`)
  if(originalCheck.status!==404){
    assert(originalCheck.ok,`Private OpenCode export ${original.sessionID}: HTTP ${originalCheck.status}`)
    const empty=(await originalCheck.json()).data
    assert.equal(empty.info.location.directory,manifest.project)
    assert.equal(empty.info.title,'Rune real-history disposable test')
    assert.equal(empty.messages.length,0)
  }
  const removed=(await removeIfPresent(manifest.sessionID)?1:0)+(await removeIfPresent(original.sessionID)?1:0)
  console.log(JSON.stringify({result:'private-history-sessions-cleaned',sessions:removed,permissions:'deny-all verified after execution'}))
  },{profile:manifest.profile})
}
if(args.includes('--cleanup'))await cleanupRealHistory(args[args.indexOf('--cleanup')+1])
