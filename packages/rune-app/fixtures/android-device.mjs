import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {mkdir} from 'node:fs/promises'
import path from 'node:path'
import {promisify} from 'node:util'
import {acquireProfileLock} from './live-access.mjs'

export const hierarchy='/data/local/tmp/codenomad-rune-web.xml'

export function androidDevice(env) {
  const {RUNE_ANDROID_ADB:adb,RUNE_ANDROID_SERIAL:serial,RUNE_ANDROID_ADB_PORT:port}=env
  assert(adb&&path.isAbsolute(adb)&&/^emulator-\d+$/.test(serial)&&/^\d+$/.test(port)&&
    Number(port)>1024&&Number(port)<=65535&&Number(port)!==5037,'Use a private ADB server and the named emulator')
  return {serial,port,run:(...args)=>promisify(execFile)(adb,['-P',port,'-s',serial,...args],{timeout:15000,windowsHide:true})}
}

export function androidLease({run,serial},origin,{localPort,closeRelay,lockDir}={}) {
  const remotePort=Number(new URL(origin).port)
  const remote=`tcp:${remotePort}`
  const local=`tcp:${localPort??remotePort}`
  let reversed=false,deviceLock=null
  return {
    async open(){
      assert(typeof lockDir==='string'&&lockDir.length>0,'Exclusive Android emulator lock directory required')
      await mkdir(lockDir,{recursive:true})
      deviceLock=await acquireProfileLock(path.join(lockDir,`android-${serial}.lock`))
      try{
        const {stdout}=await run('devices')
        assert.deepEqual(stdout.trim().split(/\r?\n/).slice(1).map(line=>line.trim().split(/\s+/)),
          [[serial,'device']],'Use the private ADB server with only the named emulator')
        await run('reverse','--no-rebind',remote,local)
        reversed=true
        await run('shell','am','set-debug-app','--persistent','com.android.chrome')
      }catch(error){
        await deviceLock.close().catch(()=>{})
        deviceLock=null
        throw error
      }
    },
    async close(){
      const errors=[]
      if(reversed&&deviceLock){
        for(const args of [
          ['shell','am','force-stop','com.android.chrome'],
          ['shell','am','clear-debug-app'],
          ['shell','rm','-f',hierarchy],
          ['reverse','--remove',remote],
        ]){
          try{await run(...args)}catch(error){errors.push(`${args.join(' ')}: ${error.message}`)}
        }
        reversed=false
      }
      if(closeRelay){
        try{await closeRelay()}catch(error){errors.push(`relay close: ${error.message}`)}
      }
      if(deviceLock){
        try{await deviceLock.close()}catch(error){errors.push(`device lock close: ${error.message}`)}
        deviceLock=null
      }
      return errors
    },
  }
}
