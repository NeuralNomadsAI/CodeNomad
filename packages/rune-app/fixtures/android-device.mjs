import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import path from 'node:path'
import {promisify} from 'node:util'

export const hierarchy='/data/local/tmp/codenomad-rune-web.xml'

export function androidDevice(env) {
  const {RUNE_ANDROID_ADB:adb,RUNE_ANDROID_SERIAL:serial,RUNE_ANDROID_ADB_PORT:port}=env
  assert(adb&&path.isAbsolute(adb)&&/^emulator-\d+$/.test(serial)&&/^\d+$/.test(port)&&
    Number(port)>1024&&Number(port)<=65535&&Number(port)!==5037,'Use a private ADB server and the named emulator')
  return {serial,port,run:(...args)=>promisify(execFile)(adb,['-P',port,'-s',serial,...args],{timeout:15000,windowsHide:true})}
}

export function androidLease({run,serial},origin,{localPort,closeRelay}={}) {
  const remotePort=Number(new URL(origin).port)
  const remote=`tcp:${remotePort}`
  const local=`tcp:${localPort??remotePort}`
  let reversed=false
  return {
    async open(){
      const {stdout}=await run('devices')
      assert.deepEqual(stdout.trim().split(/\r?\n/).slice(1).map(line=>line.trim().split(/\s+/)),
        [[serial,'device']],'Use the private ADB server with only the named emulator')
      await run('reverse','--no-rebind',remote,local)
      reversed=true
      await run('shell','am','set-debug-app','--persistent','com.android.chrome')
    },
    async close(){
      const errors=[]
      if(reversed){
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
      return errors
    },
  }
}
