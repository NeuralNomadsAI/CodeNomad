import assert from 'node:assert/strict'
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

test('the owner releases Android resources even if worker cleanup never runs',async()=>{
  const seen=[]
  const lease=androidLease({serial,run:async(...args)=>{
    seen.push(args)
    if(args.includes('force-stop'))throw Error('Chrome cleanup refused')
    return {stdout:`List of devices attached\r\n${serial}\tdevice\r\n\r\n`}
  }},origin)
  await lease.open()
  assert.match((await lease.close()).join(),/Chrome cleanup refused/)
  assert.deepEqual(await lease.close(),[])
  assert.deepEqual(seen,commands)
})

test('a refused reverse lease never cleans up another client',async()=>{
  const seen=[]
  const lease=androidLease({serial,run:async(...args)=>{
    seen.push(args)
    if(args[0]==='reverse')throw Error('Port already reversed')
    return {stdout:`List of devices attached\n${serial}\tdevice\n\n`}
  }},origin)
  await assert.rejects(lease.open(),/already reversed/)
  assert.deepEqual(await lease.close(),[])
  assert.deepEqual(seen,commands.slice(0,2))
})
