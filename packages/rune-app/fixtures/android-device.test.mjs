import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {androidLease,hierarchy} from './android-device.mjs'

const origin='https://127.0.0.1:18222'
const serial='emulator-5580'
const commands=[
  ['devices'],
  ['reverse','--no-rebind','tcp:18222','tcp:18222'],
  ['shell','am','set-debug-app','--persistent','com.android.chrome'],
  ['shell','am','force-stop','com.android.chrome'],
  ['shell','am','clear-debug-app'],
  ['shell','rm','-f',hierarchy],
  ['reverse','--remove','tcp:18222'],
]

async function tempLockDir(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'codenomad-android-test-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  return dir
}

test('the owner releases Android resources even if worker cleanup never runs',async t=>{
  const lockDir=await tempLockDir(t)
  const seen=[]
  const lease=androidLease({serial,run:async(...args)=>{
    seen.push(args)
    if(args.includes('force-stop'))throw Error('Chrome cleanup refused')
    return {stdout:`List of devices attached\r\n${serial}\tdevice\r\n\r\n`}
  }},origin,{lockDir})
  await lease.open()
  assert.match((await lease.close()).join(),/Chrome cleanup refused/)
  assert.deepEqual(await lease.close(),[])
  assert.deepEqual(seen,commands)
})

test('a refused reverse lease never cleans up another client',async t=>{
  const lockDir=await tempLockDir(t)
  const seen=[]
  const lease=androidLease({serial,run:async(...args)=>{
    seen.push(args)
    if(args[0]==='reverse')throw Error('Port already reversed')
    return {stdout:`List of devices attached\n${serial}\tdevice\n\n`}
  }},origin,{lockDir})
  await assert.rejects(lease.open(),/already reversed/)
  assert.deepEqual(await lease.close(),[])
  assert.deepEqual(seen,commands.slice(0,2))
})

test('concurrent leases on the same emulator serial are mutually exclusive',async t=>{
  const lockDir=await tempLockDir(t)
  const stubRun=async()=>({stdout:`List of devices attached\n${serial}\tdevice\n\n`})
  const first=androidLease({serial,run:stubRun},origin,{lockDir})
  const second=androidLease({serial,run:stubRun},origin,{lockDir})
  await first.open()
  t.after(()=>first.close())
  await assert.rejects(second.open(),err=>err?.code==='EEXIST')
  assert.deepEqual(await first.close(),[])
  await second.open()
  assert.deepEqual(await second.close(),[])
})

test('a set-debug-app failure rolls back reverse under the device lock',async t=>{
  const lockDir=await tempLockDir(t)
  const seen=[]
  const lease=androidLease({serial,run:async(...args)=>{
    seen.push(args)
    if(args.includes('set-debug-app'))throw Error('set-debug-app denied')
    return {stdout:`List of devices attached\n${serial}\tdevice\n\n`}
  }},origin,{lockDir})
  await assert.rejects(lease.open(),/set-debug-app denied/)
  assert.deepEqual(seen,[
    ['devices'],
    ['reverse','--no-rebind','tcp:18222','tcp:18222'],
    ['shell','am','set-debug-app','--persistent','com.android.chrome'],
    ['reverse','--remove','tcp:18222'],
  ])
  assert.deepEqual(await lease.close(),[])
  // Lock was released cleanly so a subsequent owner can acquire it immediately.
  const next=androidLease({serial,run:async()=>({stdout:`List of devices attached\n${serial}\tdevice\n\n`})},origin,{lockDir})
  await next.open()
  assert.deepEqual(await next.close(),[])
})
