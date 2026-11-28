// Holds an owned Rust server on loopback for the Android application, reached from a device
// through `adb reverse`. Its OpenCode is a synthetic endpoint (`synthetic-opencode.mjs`): no
// installed daemon is used.
//
//   node packages/rune-app/fixtures/android-native-serve.mjs [--port 3000] [--minutes 60] [--password <to type by hand>] [--ui <built UI directory>]
//
// With --ui the server also serves that built web interface (the original CodeNomad's, for one), so
// a browser reads the same data as the Rune application.
// RUNE_SERVER_EXE names the built `codenomad-rs`. Prints one JSON line {origin, port, password, profile, stop} once the server answers, then
// serves until the `stop` file appears or the minutes run out. The server admits only its own
// loopback origin, so the device must reach it on the same port: `adb reverse tcp:3000 tcp:3000`.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {access,mkdir,stat} from 'node:fs/promises'
import {Agent as HttpAgent,request as httpRequest} from 'node:http'
import net from 'node:net'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {
  attestPeerWithRetry,
  verifyLoopbackConnectionPeer,
  verifyLoopbackListenerOwner,
} from '../../../scripts/native-fixture-process.mjs'
import {privateEnvironment} from './private-profile.mjs'
import {syntheticOpenCode} from './synthetic-opencode.mjs'

export function createOwnedLoopbackAgent(port,pid,{
  isAlive=()=>true,
  verifyOwner=verifyLoopbackListenerOwner,
  verifyPeer=verifyLoopbackConnectionPeer,
}={}){
  let closed=false
  const pending=new Set()
  const agent=new HttpAgent({keepAlive:false})
  const originalDestroy=agent.destroy.bind(agent)
  agent.createConnection=(options,callback)=>{
    const host=options.host??options.hostname
    const targetPort=Number(options.port)
    if(closed||host!=='127.0.0.1'||targetPort!==port){
      const err=new Error(`Attested HTTP agent refused connection to ${host}:${targetPort}`)
      if(callback){queueMicrotask(()=>callback(err));return undefined}
      throw err
    }
    let settled=false
    let socket
    const finish=(err,sock)=>{
      if(settled)return
      settled=true
      if(socket){
        socket.off('error',onError)
        socket.off('close',onClose)
      }
      pending.delete(entry)
      if(err&&socket){try{socket.destroy()}catch{}}
      callback?.(err,sock)
    }
    const onError=err=>finish(err)
    const onClose=()=>finish(new Error('Socket closed during peer attestation'))
    const entry={fail:err=>finish(err)}
    pending.add(entry)
    Promise.resolve().then(()=>{
      assert(isAlive(),`Owned Rust server PID ${pid} exited before connection`)
      return verifyOwner(port,pid)
    }).then(()=>{
      if(closed||settled){finish(new Error('Attested HTTP agent is closed'));return}
      assert(isAlive(),`Owned Rust server PID ${pid} exited during listener attestation`)
      socket=net.createConnection({host:'127.0.0.1',port})
      socket.once('error',onError)
      socket.once('close',onClose)
      socket.once('connect',()=>{
        if(closed||settled||socket.destroyed||!socket.localPort){
          finish(new Error('Socket closed before peer attestation'))
          return
        }
        attestPeerWithRetry(socket.localPort,port,pid,verifyPeer,()=>closed||settled||socket.destroyed||!isAlive())
          .then(()=>{
            assert(isAlive(),`Owned Rust server PID ${pid} exited during peer attestation`)
            if(closed||settled||socket.destroyed){finish(new Error('Socket closed during peer attestation'));return}
            finish(null,socket)
          })
          .catch(finish)
      })
    }).catch(finish)
    return undefined
  }
  agent.destroy=()=>{
    closed=true
    for(const entry of [...pending])entry.fail(new Error('Attested HTTP agent is closed'))
    pending.clear()
    originalDestroy()
  }
  return agent
}

export function postAttestedJson({origin,pathname,body,headers={},agent,signal}){
  const target=new URL(pathname,origin)
  const payload=JSON.stringify(body)
  return new Promise((resolve,reject)=>{
    const req=httpRequest({
      hostname:target.hostname,
      port:Number(target.port),
      path:`${target.pathname}${target.search}`,
      method:'POST',
      agent,
      signal,
      headers:{
        'content-type':'application/json',
        'content-length':Buffer.byteLength(payload),
        connection:'close',
        ...headers,
      },
    },res=>{
      const chunks=[]
      res.on('data',chunk=>chunks.push(chunk))
      res.once('error',reject)
      res.once('end',()=>resolve({
        status:res.statusCode??0,
        headers:res.headers,
        body:Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.once('error',reject)
    req.end(payload)
  })
}

export async function runAndroidNativeServe({
  argv=process.argv.slice(2),
  env:sourceEnv=process.env,
  spawnChild=spawn,
  verifyOwner=verifyLoopbackListenerOwner,
  verifyPeer=verifyLoopbackConnectionPeer,
  onReady=info=>console.log(JSON.stringify(info)),
  startupTimeoutMs=20000,
  shutdownGraceMs=5000,
  pollIntervalMs=500,
}={}){
  const {values}=parseArgs({
    args:argv,
    options:{minutes:{type:'string',default:'60'},port:{type:'string',default:'3000'},password:{type:'string'},ui:{type:'string'}},
  })
  const minutes=Number(values.minutes),serverBinary=sourceEnv.RUNE_SERVER_EXE
  assert(serverBinary&&path.isAbsolute(serverBinary)&&(await stat(serverBinary)).isFile(),'Set RUNE_SERVER_EXE to the built codenomad-rs')
  assert(Number.isFinite(minutes)&&minutes>0&&minutes<=240,'Pass --minutes between 1 and 240')
  assert(/^\d+$/.test(values.port)&&Number(values.port)>1024&&Number(values.port)<=65535,'Pass --port above 1024')
  const artifacts=sourceEnv.RUNE_FIXTURE_ARTIFACTS??path.join(path.resolve(import.meta.dirname,'..'),'fixture-profile')
  assert(path.isAbsolute(artifacts),'Fixture artifacts directory must be absolute')
  const profile=path.join(artifacts,randomUUID()),project=path.join(profile,'projects','synthetic')
  await mkdir(project,{recursive:true})
  // A password someone types on a phone may be given; the server still listens on loopback only.
  assert(values.password===undefined||values.password.length>=8,'Pass --password of at least 8 characters')
  const password=values.password??randomUUID(),nativePassword=randomUUID(),requests=path.join(profile,'native-requests.log')
  const upstream=await syntheticOpenCode({project,password:nativePassword,requests})
  const env={...await privateEnvironment(profile),CNRS_SERVER_PASSWORD:password,CNRS_FIXTURE_URL:upstream.origin,
    CNRS_FIXTURE_PASSWORD:nativePassword,CNRS_FIXTURE_STDIN_STOP:'1',...(values.ui?{CNRS_FIXTURE_UI_DIR:path.resolve(values.ui)}:{})}
  // The fourth argument names no executable: with the synthetic endpoint set, none is started.
  const server=spawnChild(serverBinary,[path.dirname(project),path.join(profile,'identity.json'),values.port,'synthetic-only'],
    {cwd:profile,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
  let spawnError=null
  server.once('error',error=>{spawnError=error})
  server.stdin?.on('error',()=>{})
  const stopped=new Promise(resolve=>{
    server.once('close',resolve)
    server.once('error',resolve)
  })
  const killChildSync=()=>{
    if(server.pid&&server.exitCode===null&&server.signalCode===null){
      try{server.kill('SIGKILL')}catch{}
    }
  }
  const abort=new AbortController()
  let stopRequested=false
  const requestStop=signal=>{
    if(stopRequested){
      killChildSync()
      process.exit(signal==='SIGINT'?130:143)
    }
    stopRequested=true
    abort.abort(new Error(`Received ${signal}`))
  }
  const onSigint=()=>requestStop('SIGINT')
  const onSigterm=()=>requestStop('SIGTERM')
  const onExit=()=>killChildSync()
  const onFatal=error=>{
    killChildSync()
    console.error(error)
    process.exit(1)
  }
  process.on('SIGINT',onSigint)
  process.on('SIGTERM',onSigterm)
  process.on('exit',onExit)
  process.on('uncaughtException',onFatal)
  process.on('unhandledRejection',onFatal)

  let log='',stdoutLog='',agent
  server.stdout?.on('data',bytes=>{
    const text=String(bytes)
    stdoutLog=(stdoutLog+text).slice(-65536)
    log=(log+text).slice(-65536)
  })
  server.stderr?.on('data',bytes=>{log=(log+bytes).slice(-65536)})
  try{
    let origin
    for(const end=Date.now()+startupTimeoutMs;!origin&&!stopRequested;){
      if(spawnError)throw new Error(`Owned Rust server spawn failed: ${spawnError.message}`,{cause:spawnError})
      assert(server.exitCode===null&&server.signalCode===null&&Date.now()<end,`Owned Rust startup failed: ${log}`)
      origin=stdoutLog.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
      if(!origin)await delay(50,undefined,{signal:abort.signal}).catch(()=>{})
    }
    if(stopRequested)return
    const parsedOrigin=new URL(origin)
    assert.equal(parsedOrigin.port,values.port,`Owned Rust server bound unexpected port ${parsedOrigin.port}, expected ${values.port}`)
    assert(Number.isSafeInteger(server.pid)&&server.pid>0,'Owned Rust server PID unavailable')
    const serverPort=Number(parsedOrigin.port)
    const isAlive=()=>server.exitCode===null&&server.signalCode===null
    assert(isAlive(),'Owned Rust server exited before listener attestation')
    await verifyOwner(serverPort,server.pid)
    agent=createOwnedLoopbackAgent(serverPort,server.pid,{
      isAlive,
      verifyOwner,
      verifyPeer,
    })
    const login=await postAttestedJson({
      origin,pathname:'/api/auth/login',agent,
      body:{username:'codenomad',password},
      signal:AbortSignal.any([AbortSignal.timeout(15000),abort.signal]),
    })
    assert.equal(login.status,200,'The owned server refused its own password')
    const rawCookie=Array.isArray(login.headers['set-cookie'])?login.headers['set-cookie'][0]:login.headers['set-cookie']
    assert(typeof rawCookie==='string'&&rawCookie.includes('='),'The owned server did not return a session cookie')
    // The project is open before anyone connects: the launcher lists it, with no path to type.
    const opened=await postAttestedJson({
      origin,pathname:'/api/workspaces',agent,
      headers:{cookie:rawCookie.split(';')[0]},
      body:{path:project},
      signal:AbortSignal.any([AbortSignal.timeout(30000),abort.signal]),
    })
    assert.equal(opened.status,201,'The owned server did not open the synthetic project')
    const stop=path.join(profile,'stop')
    const info={origin,port:serverPort,password,profile,stop}
    onReady(info)
    for(const end=Date.now()+minutes*60000;!stopRequested&&Date.now()<end&&server.exitCode===null&&server.signalCode===null;){
      if(await access(stop).then(()=>true,()=>false))break
      await delay(pollIntervalMs,undefined,{signal:abort.signal}).catch(()=>{})
    }
    return info
  }finally{
    agent?.destroy()
    // The server owns no child process: a shutdown line ends it, a kill is the fallback.
    if(!spawnError&&server.exitCode===null&&server.signalCode===null){
      try{server.stdin?.end('shutdown\n')}catch{}
      if(await Promise.race([stopped.then(()=>false),delay(shutdownGraceMs,true)])){
        try{server.kill()}catch{}
        if(await Promise.race([stopped.then(()=>false),delay(2000,true)])){
          killChildSync()
        }
      }
    }
    await Promise.race([stopped,delay(2000)])
    await upstream.close()
    process.off('SIGINT',onSigint)
    process.off('SIGTERM',onSigterm)
    process.off('exit',onExit)
    process.off('uncaughtException',onFatal)
    process.off('unhandledRejection',onFatal)
  }
}

const isMain=(()=>{
  if(!process.argv[1])return false
  const entry=path.resolve(process.argv[1])
  const self=path.resolve(fileURLToPath(import.meta.url))
  return process.platform==='win32'?entry.toLowerCase()===self.toLowerCase():entry===self
})()

if(isMain){
  await runAndroidNativeServe()
}
