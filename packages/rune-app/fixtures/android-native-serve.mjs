// Holds an owned Rust server on loopback for the Android application, reached from a device
// through `adb reverse`. Its OpenCode is a synthetic endpoint (`synthetic-opencode.mjs`): no
// installed daemon is used.
//
//   node packages/rune-app/fixtures/android-native-serve.mjs [--port 3000] [--minutes 60] [--password <to type by hand>]
//
// RUNE_SERVER_EXE names the built `codenomad-rs`. Prints one JSON line {origin, port, password, profile, stop} once the server answers, then
// serves until the `stop` file appears or the minutes run out. The server admits only its own
// loopback origin, so the device must reach it on the same port: `adb reverse tcp:3000 tcp:3000`.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {access,mkdir,stat} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import {parseArgs} from 'node:util'
import path from 'node:path'
import {privateEnvironment} from './private-profile.mjs'
import {syntheticOpenCode} from './synthetic-opencode.mjs'

const {values}=parseArgs({options:{minutes:{type:'string',default:'60'},port:{type:'string',default:'3000'},password:{type:'string'}}})
const minutes=Number(values.minutes),serverBinary=process.env.RUNE_SERVER_EXE
assert(serverBinary&&path.isAbsolute(serverBinary)&&(await stat(serverBinary)).isFile(),'Set RUNE_SERVER_EXE to the built codenomad-rs')
assert(Number.isFinite(minutes)&&minutes>0&&minutes<=240,'Pass --minutes between 1 and 240')
assert(/^\d+$/.test(values.port)&&Number(values.port)>1024&&Number(values.port)<=65535,'Pass --port above 1024')
const artifacts=process.env.RUNE_FIXTURE_ARTIFACTS??path.join(path.resolve(import.meta.dirname,'..'),'fixture-profile')
assert(path.isAbsolute(artifacts),'Fixture artifacts directory must be absolute')
const profile=path.join(artifacts,randomUUID()),project=path.join(profile,'projects','synthetic')
await mkdir(project,{recursive:true})
// A password someone types on a phone may be given; the server still listens on loopback only.
assert(values.password===undefined||values.password.length>=8,'Pass --password of at least 8 characters')
const password=values.password??randomUUID(),nativePassword=randomUUID(),requests=path.join(profile,'native-requests.log')
const upstream=await syntheticOpenCode({project,password:nativePassword,requests})
const env={...await privateEnvironment(profile),CNRS_SERVER_PASSWORD:password,CNRS_FIXTURE_URL:upstream.origin,
  CNRS_FIXTURE_PASSWORD:nativePassword,CNRS_FIXTURE_STDIN_STOP:'1'}
// The fourth argument names no executable: with the synthetic endpoint set, none is started.
const server=spawn(serverBinary,[path.dirname(project),path.join(profile,'identity.json'),values.port,'synthetic-only'],
  {cwd:profile,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
const stopped=new Promise(resolve=>server.once('close',resolve))
let log='';for(const pipe of [server.stdout,server.stderr])pipe.on('data',bytes=>log=(log+bytes).slice(-65536))
try{
  let origin
  for(const end=Date.now()+20000;!origin;){
    assert(server.exitCode===null&&Date.now()<end,`Owned Rust startup failed: ${log}`)
    origin=log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(!origin)await delay(50)
  }
  const login=await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({username:'codenomad',password}),signal:AbortSignal.timeout(15000)})
  assert.equal(login.status,200,'The owned server refused its own password')
  // The project is open before anyone connects: the launcher lists it, with no path to type.
  const opened=await fetch(`${origin}/api/workspaces`,{method:'POST',headers:{'content-type':'application/json',cookie:login.headers.get('set-cookie').split(';')[0]},
    body:JSON.stringify({path:project}),signal:AbortSignal.timeout(30000)})
  assert.equal(opened.status,201,'The owned server did not open the synthetic project')
  const stop=path.join(profile,'stop')
  console.log(JSON.stringify({origin,port:Number(new URL(origin).port),password,profile,stop}))
  for(const end=Date.now()+minutes*60000;Date.now()<end&&server.exitCode===null;await delay(500))
    if(await access(stop).then(()=>true,()=>false))break
}finally{
  // The server owns no child process: a shutdown line ends it, a kill is the fallback.
  server.stdin.end('shutdown\n')
  if(await Promise.race([stopped.then(()=>false),delay(5000,true)]))server.kill()
  await stopped
  await upstream.close()
}
