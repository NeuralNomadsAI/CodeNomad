import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {PassThrough} from 'node:stream'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {runAndroidNativeServe} from './android-native-serve.mjs'
import {syntheticOpenCode} from './synthetic-opencode.mjs'

async function tempDir(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'codenomad-android-serve-test-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  return dir
}

async function freeLoopbackPort(){
  const srv=net.createServer()
  await new Promise((resolve,reject)=>{srv.once('error',reject);srv.listen(0,'127.0.0.1',resolve)})
  const {port}=srv.address()
  await new Promise(resolve=>srv.close(resolve))
  return port
}

async function waitForLog(file,needle,timeoutMs=2000){
  const end=Date.now()+timeoutMs
  while(Date.now()<end){
    const text=await readFile(file,'utf8').catch(()=>'')
    if(text.includes(needle))return text
    await delay(25)
  }
  return await readFile(file,'utf8').catch(()=>'')
}

test('syntheticOpenCode logs 413, handles invalid JSON and 500 without crashing, and keeps serving',async t=>{
  const dir=await tempDir(t)
  const requests=path.join(dir,'requests.log')
  const password='test-native-password'
  const auth=`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  const endpoint=await syntheticOpenCode({project:dir,password,requests})
  t.after(()=>endpoint.close())

  // Unauthorized request logs 401.
  const unauth=await fetch(`${endpoint.origin}api/location`)
  assert.equal(unauth.status,401)

  // Oversized body logs 413 and returns 413.
  const tooLarge=await fetch(`${endpoint.origin}api/session`,{
    method:'POST',
    headers:{authorization:auth,'content-type':'application/json'},
    body:'x'.repeat(262145),
  })
  assert.equal(tooLarge.status,413)

  // Invalid JSON on POST /api/session returns 400.
  const badCreate=await fetch(`${endpoint.origin}api/session`,{
    method:'POST',
    headers:{authorization:auth,'content-type':'application/json'},
    body:'{not-json',
  })
  assert.equal(badCreate.status,400)

  // Missing input on window RPC returns 400.
  const missingInput=await fetch(`${endpoint.origin}api/rpc/codenomad.session-pruning/window`,{
    method:'POST',
    headers:{authorization:auth,'content-type':'application/json'},
    body:JSON.stringify({}),
  })
  assert.equal(missingInput.status,400)

  // Unsupported target kind triggers FixtureStore.window assert.fail -> 500 JSON, no crash.
  const badTarget=await fetch(`${endpoint.origin}api/rpc/codenomad.session-pruning/window`,{
    method:'POST',
    headers:{authorization:auth,'content-type':'application/json'},
    body:JSON.stringify({input:{sessionID:'ses_short',target:{kind:'bogus'}}}),
  })
  assert.equal(badTarget.status,500)

  // Invalid JSON on prompt returns 400.
  const badPrompt=await fetch(`${endpoint.origin}api/session/ses_short/prompt`,{
    method:'POST',
    headers:{authorization:auth,'content-type':'application/json'},
    body:'',
  })
  assert.equal(badPrompt.status,400)

  // Server remains healthy and serves normal requests afterward.
  const ok=await fetch(`${endpoint.origin}api/location`,{headers:{authorization:auth}})
  assert.equal(ok.status,200)
  assert.deepEqual(await ok.json(),{data:{directory:dir}})

  const log=await waitForLog(requests,'200 GET /api/location')
  assert.match(log,/401 GET \/api\/location/)
  assert.match(log,/413 POST \/api\/session/)
  assert.match(log,/400 POST \/api\/session/)
  assert.match(log,/400 POST \/api\/rpc\/codenomad\.session-pruning\/window/)
  assert.match(log,/500 POST \/api\/rpc\/codenomad\.session-pruning\/window/)
  assert.match(log,/400 POST \/api\/session\/ses_short\/prompt/)
})

test('runAndroidNativeServe surfaces spawn errors cleanly without hanging',async t=>{
  const dir=await tempDir(t)
  const fakeExe=path.join(dir,'codenomad-rs.fake')
  await writeFile(fakeExe,'placeholder')
  const port=await freeLoopbackPort()

  const failingSpawn=()=>{
    const child=new EventEmitter()
    child.stdin=new PassThrough()
    child.stdout=new PassThrough()
    child.stderr=new PassThrough()
    child.exitCode=null
    child.signalCode=null
    child.kill=()=>true
    queueMicrotask(()=>child.emit('error',Object.assign(new Error('spawn EACCES'),{code:'EACCES'})))
    return child
  }

  await assert.rejects(
    runAndroidNativeServe({
      argv:['--port',String(port),'--minutes','1'],
      env:{RUNE_SERVER_EXE:fakeExe,RUNE_FIXTURE_ARTIFACTS:dir},
      spawnChild:failingSpawn,
      startupTimeoutMs:2000,
    }),
    /Owned Rust server spawn failed: spawn EACCES/,
  )
})

test('runAndroidNativeServe reads origin from stdout only and rejects mismatched port before login',async t=>{
  const dir=await tempDir(t)
  const fakeExe=path.join(dir,'codenomad-rs.fake')
  await writeFile(fakeExe,'placeholder')
  const requestedPort=await freeLoopbackPort()
  let loginHits=0
  const wrongServer=createServer((req,res)=>{
    if(req.url==='/api/auth/login')loginHits++
    res.writeHead(200,{'set-cookie':'cn=ok; Path=/','content-type':'application/json'})
    res.end('{}')
  })
  await new Promise(resolve=>wrongServer.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>wrongServer.close(resolve)))
  const wrongPort=wrongServer.address().port
  assert.notEqual(wrongPort,requestedPort)

  let killed=false
  const fakeSpawn=()=>{
    const child=new EventEmitter()
    child.pid=process.pid
    child.stdin=new PassThrough()
    child.stdout=new PassThrough()
    child.stderr=new PassThrough()
    child.exitCode=null
    child.signalCode=null
    child.kill=()=>{killed=true;child.exitCode=1;child.emit('close',1);return true}
    child.stdin.on('finish',()=>{child.exitCode=0;child.emit('close',0)})
    queueMicrotask(()=>{
      // Decoy matching port on stderr must be ignored; stdout carries the wrong port.
      child.stderr.write(`http://127.0.0.1:${requestedPort}\n`)
      child.stdout.write(`Local Connection URL : http://127.0.0.1:${wrongPort}\n`)
    })
    return child
  }

  await assert.rejects(
    runAndroidNativeServe({
      argv:['--port',String(requestedPort),'--minutes','1','--password','secret-pass-123'],
      env:{RUNE_SERVER_EXE:fakeExe,RUNE_FIXTURE_ARTIFACTS:dir},
      spawnChild:fakeSpawn,
      startupTimeoutMs:2000,
      shutdownGraceMs:200,
    }),
    /bound unexpected port/,
  )
  assert.equal(loginHits,0,'Password must never be sent to an unexpected port')
  assert.equal(killed,false)
})

test('runAndroidNativeServe refuses to send password when loopback owner verification fails',async t=>{
  const dir=await tempDir(t)
  const fakeExe=path.join(dir,'codenomad-rs.fake')
  await writeFile(fakeExe,'placeholder')
  let loginHits=0
  const server=createServer((req,res)=>{
    if(req.url==='/api/auth/login')loginHits++
    res.writeHead(200,{'set-cookie':'cn=ok; Path=/','content-type':'application/json'})
    res.end('{}')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const boundPort=server.address().port

  const fakeSpawn=()=>{
    const child=new EventEmitter()
    child.pid=999999
    child.stdin=new PassThrough()
    child.stdout=new PassThrough()
    child.stderr=new PassThrough()
    child.exitCode=null
    child.signalCode=null
    child.kill=()=>{child.exitCode=1;child.emit('close',1);return true}
    child.stdin.on('finish',()=>{child.exitCode=0;child.emit('close',0)})
    queueMicrotask(()=>child.stdout.write(`http://127.0.0.1:${boundPort}\n`))
    return child
  }

  await assert.rejects(
    runAndroidNativeServe({
      argv:['--port',String(boundPort),'--minutes','1','--password','secret-pass-123'],
      env:{RUNE_SERVER_EXE:fakeExe,RUNE_FIXTURE_ARTIFACTS:dir},
      spawnChild:fakeSpawn,
      verifyOwner:async()=>{throw new Error('Loopback port is not owned by fixture PID')},
      startupTimeoutMs:2000,
      shutdownGraceMs:200,
    }),
    /not owned by fixture PID/,
  )
  assert.equal(loginHits,0,'Password must never be sent before loopback listener attestation succeeds')
})

test('runAndroidNativeServe completes attested login, opens workspace, and shuts down cleanly on stop file',async t=>{
  const dir=await tempDir(t)
  const fakeExe=path.join(dir,'codenomad-rs.fake')
  await writeFile(fakeExe,'placeholder')
  const seen=[]
  const server=createServer(async(req,res)=>{
    let body=''
    for await(const chunk of req)body+=chunk
    seen.push({method:req.method,url:req.url,cookie:req.headers.cookie,body:JSON.parse(body)})
    if(req.url==='/api/auth/login'){
      res.writeHead(200,{'set-cookie':'codenomad_session=tok123; HttpOnly','content-type':'application/json'})
      res.end(JSON.stringify({ok:true}))
      return
    }
    if(req.url==='/api/workspaces'){
      res.writeHead(201,{'content-type':'application/json'})
      res.end(JSON.stringify({id:'ws_1'}))
      return
    }
    res.writeHead(404);res.end()
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const boundPort=server.address().port

  let shutdownReceived=''
  let verifyOwnerCalls=0,verifyPeerCalls=0
  const fakeSpawn=()=>{
    const child=new EventEmitter()
    child.pid=process.pid
    child.stdin=new PassThrough()
    child.stdout=new PassThrough()
    child.stderr=new PassThrough()
    child.exitCode=null
    child.signalCode=null
    child.kill=()=>{child.exitCode=1;child.emit('close',1);return true}
    child.stdin.on('data',chunk=>{shutdownReceived+=chunk})
    child.stdin.on('finish',()=>{child.exitCode=0;child.emit('close',0)})
    queueMicrotask(()=>{
      child.stderr.write('noise http://127.0.0.1:9999\n')
      child.stdout.write(`http://127.0.0.1:${boundPort}\n`)
    })
    return child
  }

  let readyInfo
  await runAndroidNativeServe({
    argv:['--port',String(boundPort),'--minutes','1','--password','secret-pass-123'],
    env:{RUNE_SERVER_EXE:fakeExe,RUNE_FIXTURE_ARTIFACTS:dir},
    spawnChild:fakeSpawn,
    verifyOwner:async(port,pid)=>{assert.equal(port,boundPort);assert.equal(pid,process.pid);verifyOwnerCalls++},
    verifyPeer:async(_local,remote,pid)=>{assert.equal(remote,boundPort);assert.equal(pid,process.pid);verifyPeerCalls++},
    onReady:info=>{readyInfo=info;void writeFile(info.stop,'stop')},
    startupTimeoutMs:2000,
    shutdownGraceMs:500,
    pollIntervalMs:25,
  })

  assert.equal(readyInfo.port,boundPort)
  assert.equal(readyInfo.password,'secret-pass-123')
  assert.equal(seen.length,2)
  assert.deepEqual(seen[0],{method:'POST',url:'/api/auth/login',cookie:undefined,body:{username:'codenomad',password:'secret-pass-123'}})
  assert.equal(seen[1].url,'/api/workspaces')
  assert.equal(seen[1].cookie,'codenomad_session=tok123')
  assert.equal(seen[1].body.path,path.join(readyInfo.profile,'projects','synthetic'))
  assert(verifyOwnerCalls>=3,'verifyOwner runs before connection and on each attested request')
  assert.equal(verifyPeerCalls,2,'verifyPeer attests both login and workspace open sockets')
  assert.equal(shutdownReceived,'shutdown\n')
})

test('runAndroidNativeServe kills child process on fatal uncaught error so no orphan survives',async t=>{
  const dir=await tempDir(t)
  const runner=path.join(dir,'orphan-check.mjs')
  const childScript=path.join(dir,'sleeper.mjs')
  const pidFile=path.join(dir,'child.pid')
  const serveUrl=new URL('./android-native-serve.mjs',import.meta.url).href

  await writeFile(childScript,`
import {writeFileSync} from 'node:fs'
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
setInterval(()=>{}, 1000)
`)
  await writeFile(runner,`
import {spawn} from 'node:child_process'
import {runAndroidNativeServe} from ${JSON.stringify(serveUrl)}
await runAndroidNativeServe({
  argv:['--port','18999','--minutes','1'],
  env:{RUNE_SERVER_EXE:process.execPath,RUNE_FIXTURE_ARTIFACTS:${JSON.stringify(dir)}},
  spawnChild:(_bin,_args,opts)=>{
    const child=spawn(process.execPath,[${JSON.stringify(childScript)}],opts)
    setTimeout(()=>{throw new Error('simulated crash outside try')},150)
    return child
  },
  startupTimeoutMs:5000,
})
`)

  const proc=spawn(process.execPath,[runner],{windowsHide:true,stdio:['ignore','pipe','pipe']})
  const code=await new Promise(resolve=>proc.once('close',resolve))
  assert.notEqual(code,0)
  const childPid=Number((await readFile(pidFile,'utf8')).trim())
  assert(Number.isSafeInteger(childPid)&&childPid>0)
  const deadline=Date.now()+2000
  let alive=true
  while(Date.now()<deadline){
    try{process.kill(childPid,0);await delay(25)}catch{alive=false;break}
  }
  assert.equal(alive,false,`Child PID ${childPid} must not survive parent crash`)
})
