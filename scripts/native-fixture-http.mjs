import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {existsSync,realpathSync} from 'node:fs'
import {readdir,readFile,readlink} from 'node:fs/promises'
import {Agent as HttpAgent,createServer,request as httpRequest} from 'node:http'
import {createRequire} from 'node:module'
import net from 'node:net'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {promisify} from 'node:util'

const execFileAsync=promisify(execFile)
const repoRoot=path.resolve(fileURLToPath(new URL('..',import.meta.url)))
const repoRootReal=realpathSync(repoRoot)
const worktreesDir=path.dirname(repoRootReal)
const commonRepoRoot=path.basename(worktreesDir)==='worktrees'&&path.basename(path.dirname(worktreesDir))==='.codenomad'
  ? path.resolve(worktreesDir,'../..')
  : repoRootReal
const worktreeNodeModules=path.join(repoRoot,'node_modules')

function isWithin(root,target){
  const rel=path.relative(root,target)
  return rel===''||(Boolean(rel)&&!path.isAbsolute(rel)&&rel.split(path.sep)[0]!=='..')
}

function packageNameOf(specifier){
  const parts=specifier.split('/')
  return specifier.startsWith('@')?parts.slice(0,2).join('/'):parts[0]
}

export function resolveWorktreePackage(specifier,nodeModulesDir=worktreeNodeModules){
  assert(existsSync(nodeModulesDir),'Worktree node_modules is required; parent checkout dependencies are forbidden')
  const rootReal=realpathSync(nodeModulesDir)
  assert(isWithin(commonRepoRoot,rootReal)||isWithin(path.resolve(nodeModulesDir,'..'),rootReal),
    `node_modules resolved outside repository boundary: ${rootReal}`)
  const pkg=packageNameOf(specifier)
  const pkgDir=path.join(nodeModulesDir,...pkg.split('/'))
  assert(existsSync(path.join(pkgDir,'package.json')),
    `Worktree node_modules is missing ${pkg}; parent checkout dependencies are forbidden`)
  let resolvedPath
  if(nodeModulesDir===worktreeNodeModules){
    const resolvedUrl=import.meta.resolve(specifier)
    assert(resolvedUrl.startsWith('file://'),`Dependency ${specifier} must resolve to a local file`)
    resolvedPath=realpathSync(fileURLToPath(resolvedUrl))
  }else{
    const scopedRequire=createRequire(path.join(path.dirname(nodeModulesDir),'package.json'))
    resolvedPath=realpathSync(scopedRequire.resolve(specifier))
  }
  assert(isWithin(rootReal,resolvedPath)&&resolvedPath!==rootReal,
    `Dependency ${specifier} resolved outside worktree node_modules: ${resolvedPath}`)
  return pathToFileURL(resolvedPath).href
}

const isUnc=value=>typeof value==='string'&&(/^[\\/]{2}/.test(value)||/^[\\/]{2}/.test(path.normalize(value)))
export const isLocalAbsolutePath=value=>typeof value==='string'&&value.length>0&&path.isAbsolute(value)&&!isUnc(value)

export function resolveLocalExecutable(raw,label='executable'){
  assert(isLocalAbsolutePath(raw),`Pass an absolute local ${label}`)
  const resolved=realpathSync(raw)
  assert(isLocalAbsolutePath(resolved),`Resolved ${label} must stay on a local filesystem`)
  return resolved
}

export function redactSecrets(text,secrets=[]){
  let value=String(text??'')
  for(const secret of secrets){
    if(!secret)continue
    for(const token of [secret,Buffer.from(`opencode:${secret}`).toString('base64'),Buffer.from(`codenomad:${secret}`).toString('base64')]){
      value=value.replaceAll(token,'<fixture password>')
    }
  }
  return value
}

const {Agent,Pool,buildConnector,fetch:undiciFetch}=await import(resolveWorktreePackage('undici'))

const dispatcher=new Agent()
export const fixtureHttpAgent=new HttpAgent({keepAlive:true,proxyEnv:{}})

export async function verifyLoopbackListenerOwner(port,pid,forbidden='the shared OpenCode service is forbidden'){
  assert(Number.isSafeInteger(port)&&port>0&&port<=65535,'Invalid loopback port')
  assert(Number.isSafeInteger(pid)&&pid>0,'Invalid fixture PID')
  if(process.platform==='win32'){
    const {stdout}=await execFileAsync('netstat.exe',['-ano','-p','tcp'],{timeout:10000,windowsHide:true,maxBuffer:8*1024*1024})
    const owners=new Set()
    for(const line of stdout.split(/\r?\n/)){
      const match=/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+0\.0\.0\.0:0\s+\S+\s+(\d+)\s*$/i.exec(line)
      if(match&&Number(match[1])===port)owners.add(Number(match[2]))
    }
    assert(owners.size===1&&owners.has(pid),`Loopback port 127.0.0.1:${port} is not owned by fixture PID ${pid}; ${forbidden}`)
    return
  }
  if(process.platform==='linux'){
    const target=`0100007F:${port.toString(16).toUpperCase().padStart(4,'0')}`
    const table=await readFile('/proc/net/tcp','utf8')
    const inodes=new Set()
    for(const line of table.split('\n').slice(1)){
      const cols=line.trim().split(/\s+/)
      if(cols[1]===target&&cols[3]==='0A'&&cols[9])inodes.add(`socket:[${cols[9]}]`)
    }
    assert.equal(inodes.size,1,`Loopback port 127.0.0.1:${port} must have a single listening socket; ${forbidden}`)
    const [inode]=inodes
    let fds
    try{fds=await readdir(`/proc/${pid}/fd`)}catch{
      throw Error(`Loopback port 127.0.0.1:${port} is not owned by fixture PID ${pid}; ${forbidden}`)
    }
    for(const fd of fds){
      try{if(await readlink(`/proc/${pid}/fd/${fd}`)===inode)return}catch{}
    }
    throw Error(`Loopback port 127.0.0.1:${port} is not owned by fixture PID ${pid}; ${forbidden}`)
  }
  const {stdout}=await execFileAsync('lsof',['-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-Fpn'],{timeout:10000})
  const owners=new Set()
  let currentPid=null
  for(const line of stdout.split(/\r?\n/)){
    if(line.startsWith('p'))currentPid=Number(line.slice(1))
    else if(line.startsWith('n')&&line.slice(1)===`127.0.0.1:${port}`&&Number.isSafeInteger(currentPid))owners.add(currentPid)
  }
  assert(owners.size===1&&owners.has(pid),`Loopback port 127.0.0.1:${port} is not owned by fixture PID ${pid}; ${forbidden}`)
}

export async function verifyLoopbackConnectionPeer(localPort,remotePort,pid,forbidden='the shared OpenCode service is forbidden'){
  assert(Number.isSafeInteger(localPort)&&localPort>0&&localPort<=65535,'Invalid local loopback port')
  assert(Number.isSafeInteger(remotePort)&&remotePort>0&&remotePort<=65535,'Invalid remote loopback port')
  assert(Number.isSafeInteger(pid)&&pid>0,'Invalid fixture PID')
  if(process.platform==='win32'){
    const {stdout}=await execFileAsync('netstat.exe',['-ano','-p','tcp'],{timeout:10000,windowsHide:true,maxBuffer:8*1024*1024})
    const owners=new Set()
    for(const line of stdout.split(/\r?\n/)){
      const match=/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+127\.0\.0\.1:(\d+)\s+ESTABLISHED\s+(\d+)\s*$/i.exec(line)
      if(match&&Number(match[1])===remotePort&&Number(match[2])===localPort)owners.add(Number(match[3]))
    }
    assert(owners.size===1&&owners.has(pid),`Established loopback connection 127.0.0.1:${localPort}->127.0.0.1:${remotePort} is not owned by fixture PID ${pid}; ${forbidden}`)
    return
  }
  if(process.platform==='linux'){
    const localHex=`0100007F:${remotePort.toString(16).toUpperCase().padStart(4,'0')}`
    const peerHex=`0100007F:${localPort.toString(16).toUpperCase().padStart(4,'0')}`
    const table=await readFile('/proc/net/tcp','utf8')
    const inodes=new Set()
    for(const line of table.split('\n').slice(1)){
      const cols=line.trim().split(/\s+/)
      if(cols[1]===localHex&&cols[2]===peerHex&&cols[3]==='01'&&cols[9])inodes.add(`socket:[${cols[9]}]`)
    }
    assert.equal(inodes.size,1,`Established loopback connection 127.0.0.1:${localPort}->127.0.0.1:${remotePort} must have a single peer socket; ${forbidden}`)
    const [inode]=inodes
    let fds
    try{fds=await readdir(`/proc/${pid}/fd`)}catch{
      throw Error(`Established loopback connection 127.0.0.1:${localPort}->127.0.0.1:${remotePort} is not owned by fixture PID ${pid}; ${forbidden}`)
    }
    for(const fd of fds){
      try{if(await readlink(`/proc/${pid}/fd/${fd}`)===inode)return}catch{}
    }
    throw Error(`Established loopback connection 127.0.0.1:${localPort}->127.0.0.1:${remotePort} is not owned by fixture PID ${pid}; ${forbidden}`)
  }
  const {stdout}=await execFileAsync('lsof',['-nP',`-iTCP:${remotePort}`,'-sTCP:ESTABLISHED','-Fpn'],{timeout:10000})
  const owners=new Set()
  let currentPid=null
  const expected=`127.0.0.1:${remotePort}->127.0.0.1:${localPort}`
  for(const line of stdout.split(/\r?\n/)){
    if(line.startsWith('p'))currentPid=Number(line.slice(1))
    else if(line.startsWith('n')&&line.slice(1)===expected&&Number.isSafeInteger(currentPid))owners.add(currentPid)
  }
  assert(owners.size===1&&owners.has(pid),`Established loopback connection 127.0.0.1:${localPort}->127.0.0.1:${remotePort} is not owned by fixture PID ${pid}; ${forbidden}`)
}

async function attestPeerWithRetry(localPort,remotePort,pid,checkPeer,isClosed){
  let lastError
  for(let attempt=0;attempt<6;attempt++){
    if(isClosed())throw Error('Attested transport is closed')
    try{
      await checkPeer(localPort,remotePort,pid)
      return
    }catch(error){
      lastError=error
      if(attempt<5&&!isClosed())await new Promise(resolve=>setTimeout(resolve,20))
    }
  }
  throw lastError
}

export async function originGuardProxy(localOrigin,targetPid){
  const base=new URL(localOrigin)
  const agent=targetPid?createAttestedHttpAgent(Number(base.port),targetPid):fixtureHttpAgent
  const server=createServer((req,res)=>{
    let target
    try{target=new URL(req.url,localOrigin)}catch{res.writeHead(403);res.end();return}
    if(target.origin!==localOrigin){res.writeHead(403);res.end('Foreign browser origin forbidden');return}
    const headers={...req.headers}
    delete headers['proxy-connection']
    const upstream=httpRequest(target,{agent,method:req.method,headers:{...headers,host:target.host}},response=>{
      const location=response.headers.location
      if(response.statusCode>=300&&response.statusCode<400&&location){
        let redirected
        try{redirected=new URL(location,target)}catch{}
        if(!redirected||redirected.origin!==localOrigin){
          response.resume()
          res.writeHead(403);res.end('Cross-origin browser redirect forbidden')
          return
        }
      }
      res.writeHead(response.statusCode,response.headers)
      response.pipe(res)
    })
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()})
    req.on('aborted',()=>upstream.destroy())
    res.on('close',()=>upstream.destroy())
    req.pipe(upstream)
  })
  server.on('connect',(_req,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'))
  server.on('upgrade',(_req,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'))
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  return {
    port:server.address().port,
    close:()=>{if(targetPid)agent.destroy();server.closeAllConnections();return new Promise(resolve=>server.close(resolve))},
  }
}

let attestedConnectDepth=0
export function isInsideAttestedConnect(){return attestedConnectDepth>0}

export function createAttestedPool(origin,port,pid,verifyOwner=verifyLoopbackListenerOwner,verifyPeer){
  const checkPeer=verifyPeer??(verifyOwner===verifyLoopbackListenerOwner?verifyLoopbackConnectionPeer:(_local,remote,expectedPid)=>verifyOwner(remote,expectedPid))
  const connector=buildConnector({})
  let closed=false
  const pendingSockets=new Set()
  const pool=new Pool(origin,{
    connections:8,
    keepAliveTimeout:60_000,
    connect(opts,cb){
      if(closed){cb(Error('Attested pool is closed'),null);return}
      verifyOwner(port,pid).then(()=>{
        if(closed){cb(Error('Attested pool is closed'),null);return}
        attestedConnectDepth++
        try{
          connector(opts,(error,socket)=>{
            if(closed||error||!socket||socket.destroyed||!socket.localPort){
              try{socket?.destroy()}catch{}
              cb(error??Error('Socket connection closed before peer attestation'),null)
              return
            }
            let settled=false
            const done=(err,sock)=>{
              if(settled)return
              settled=true
              socket.off('close',onEarlyClose)
              socket.off('error',onEarlyError)
              pendingSockets.delete(entry)
              if(err){try{socket.destroy()}catch{}}
              cb(err,sock)
            }
            const onEarlyClose=()=>done(Error('Socket closed during peer attestation'),null)
            const onEarlyError=err=>done(err,null)
            const entry={socket,fail:err=>done(err,null)}
            pendingSockets.add(entry)
            socket.once('close',onEarlyClose)
            socket.once('error',onEarlyError)
            attestPeerWithRetry(socket.localPort,port,pid,checkPeer,()=>closed||socket.destroyed).then(()=>{
              if(closed||socket.destroyed){done(Error('Socket closed during peer attestation'),null);return}
              done(null,socket)
            },postError=>done(postError,null))
          })
        }finally{attestedConnectDepth--}
      },error=>cb(error,null))
    },
  })
  const close=()=>{
    closed=true
    for(const entry of [...pendingSockets])entry.fail(Error('Attested pool is closed'))
    pendingSockets.clear()
    return pool.destroy().catch(()=>{})
  }
  return {pool,close}
}

export function createAttestedFetch(origin,port,pid,verifyOwner=verifyLoopbackListenerOwner,verifyPeer){
  const {pool,close}=createAttestedPool(origin,port,pid,verifyOwner,verifyPeer)
  const fetchBound=(input,init={})=>{
    if(input instanceof Request){
      const {url,method,headers,body,signal}=input
      return fetchBound(url,{method,headers,body,signal,...init})
    }
    return undiciFetch(input,{...init,duplex:'half',dispatcher:pool,redirect:'error'})
  }
  fetchBound.close=close
  return fetchBound
}

export function createAttestedHttpAgent(port,pid,verifyOwner=verifyLoopbackListenerOwner,verifyPeer){
  const checkPeer=verifyPeer??(verifyOwner===verifyLoopbackListenerOwner?verifyLoopbackConnectionPeer:(_local,remote,expectedPid)=>verifyOwner(remote,expectedPid))
  let closed=false
  const pending=new Set()
  const agent=new HttpAgent({keepAlive:true,proxyEnv:{}})
  const originalDestroy=agent.destroy.bind(agent)
  agent.createConnection=(options,callback)=>{
    const host=options.host??options.hostname
    const targetPort=Number(options.port)
    if(closed||host!=='127.0.0.1'||targetPort!==port){
      const err=Error(`Attested HTTP agent refused connection to ${host}:${targetPort}`)
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
    const onClose=()=>finish(Error('Socket closed during peer attestation'))
    const entry={fail:err=>finish(err)}
    pending.add(entry)
    verifyOwner(port,pid).then(()=>{
      if(closed||settled){finish(Error('Attested HTTP agent is closed'));return}
      socket=net.createConnection({host:'127.0.0.1',port})
      socket.once('error',onError)
      socket.once('close',onClose)
      socket.once('connect',()=>{
        if(closed||settled||socket.destroyed||!socket.localPort){finish(Error('Socket closed before peer attestation'));return}
        attestPeerWithRetry(socket.localPort,port,pid,checkPeer,()=>closed||settled||socket.destroyed).then(()=>{
          if(closed||settled||socket.destroyed){finish(Error('Socket closed during peer attestation'));return}
          finish(null,socket)
        },finish)
      })
    },finish)
    return undefined
  }
  agent.destroy=()=>{
    closed=true
    for(const entry of [...pending])entry.fail(Error('Attested HTTP agent is closed'))
    pending.clear()
    originalDestroy()
  }
  return agent
}

export async function createAttestedRelay(targetOrigin,pid,onRequest){
  const base=new URL(targetOrigin)
  assert(base.protocol==='http:'&&base.hostname==='127.0.0.1'&&base.port,'Expected a loopback HTTP target for attested relay')
  const agent=createAttestedHttpAgent(Number(base.port),pid)
  const server=createServer((req,res)=>{
    const url=relayTarget(req,res,base.origin)
    if(!url)return
    if(onRequest&&onRequest(req,res,url)===false)return
    const upstream=httpRequest(url,{agent,method:req.method,headers:{...req.headers,host:url.host}},response=>{
      res.writeHead(response.statusCode,response.headers)
      response.pipe(res)
    })
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()})
    req.on('aborted',()=>upstream.destroy())
    res.on('close',()=>upstream.destroy())
    req.pipe(upstream)
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  return {
    origin:`http://127.0.0.1:${server.address().port}`,
    close:()=>{agent.destroy();server.closeAllConnections();return new Promise(resolve=>server.close(resolve))},
  }
}

export function withoutFixtureProxy(env){
  return Object.fromEntries(Object.entries(env).filter(([key])=>
    !/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(key)))
}

export function fixtureTarget(raw,origin){
  try{
    const base=new URL(origin),target=new URL(raw,base)
    if(['http:','https:'].includes(base.protocol)&&target.protocol===base.protocol&&
      target.origin===base.origin&&!target.username&&!target.password&&!target.hash)return target
  }catch{}
  return null
}

export function relayTarget(req,res,origin){
  const target=fixtureTarget(req.url,origin)
  if(!target){res.writeHead(403);res.end('Foreign fixture origin or protocol forbidden')}
  return target
}

// Use our own dispatcher: neither Node's global fetch nor environment proxy rules apply.
export function fixtureFetch(input,init={}){
  if(input instanceof Request){
    const {url,method,headers,body,signal}=input
    return fixtureFetch(url,{method,headers,body,signal,...init})
  }
  return undiciFetch(input,{...init,duplex:'half',dispatcher,redirect:'error'})
}
