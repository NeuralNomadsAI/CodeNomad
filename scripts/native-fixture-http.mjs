import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs'
import {Agent as HttpAgent,createServer,request as httpRequest} from 'node:http'
import {createRequire} from 'node:module'
import net,{isIP} from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {
  attestPeerWithRetry,
  createClientPidGate,
  extractNodeEntryScript,
  fixtureAttestationEnv,
  isPidInOwnedTree,
  parseWindowsCommandLine,
  pidAlive,
  probeProcessIdentity,
  processIdentityOf,
  resolveFixtureJobBinary,
  resolveLoopbackListenerPid,
  resolveLoopbackPeerPid,
  verifyExecutableMatches,
  verifyLoopbackConnectionPeer,
  verifyLoopbackListenerOwner,
  verifyPrivateFixtureServer,
} from './native-fixture-process.mjs'

export {
  attestPeerWithRetry,
  createClientPidGate,
  extractNodeEntryScript,
  fixtureAttestationEnv,
  isPidInOwnedTree,
  parseWindowsCommandLine,
  pidAlive,
  probeProcessIdentity,
  processIdentityOf,
  resolveFixtureJobBinary,
  resolveLoopbackListenerPid,
  resolveLoopbackPeerPid,
  verifyExecutableMatches,
  verifyLoopbackConnectionPeer,
  verifyLoopbackListenerOwner,
  verifyPrivateFixtureServer,
}

const repoRoot=path.resolve(fileURLToPath(new URL('..',import.meta.url)))
const repoRootReal=realpathSync(repoRoot)
const worktreesDir=path.dirname(repoRootReal)
const worktreeNodeModules=path.join(repoRoot,'node_modules')

function isWithin(root,target){
  const rel=path.relative(root,target)
  return rel===''||(Boolean(rel)&&!path.isAbsolute(rel)&&rel.split(path.sep)[0]!=='..')
}

function packageNameOf(specifier){
  const parts=specifier.split('/')
  return specifier.startsWith('@')?parts.slice(0,2).join('/'):parts[0]
}

export function sameWorktreeRepoAndManifests(dirA,dirB){
  const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
  for(const rel of ['package-lock.json','package.json',path.join('packages','server','package.json')]){
    const fileA=path.join(dirA,rel),fileB=path.join(dirB,rel)
    if(!existsSync(fileA)||!existsSync(fileB)||hash(fileA)!==hash(fileB))return false
  }
  const verifiedCommonGitDir=dir=>{
    const dirReal=realpathSync(dir)
    const dotGit=path.join(dirReal,'.git')
    if(!existsSync(dotGit)||lstatSync(dotGit).isDirectory())return null
    const raw=readFileSync(dotGit,'utf8').trim()
    const match=/^gitdir:\s*(.+)$/i.exec(raw)
    if(!match)return null
    const gitDir=realpathSync(path.resolve(dirReal,match[1].trim()))
    const commonFile=path.join(gitDir,'commondir')
    const backlinkFile=path.join(gitDir,'gitdir')
    if(!existsSync(commonFile)||!existsSync(backlinkFile))return null
    const commonDir=realpathSync(path.resolve(gitDir,readFileSync(commonFile,'utf8').trim()))
    const worktreesRoot=path.join(commonDir,'worktrees')
    if(!isWithin(worktreesRoot,gitDir)||gitDir===worktreesRoot)return null
    const backlinkDotGit=realpathSync(path.resolve(gitDir,readFileSync(backlinkFile,'utf8').trim()))
    if(backlinkDotGit!==dotGit)return null
    return commonDir
  }
  try{
    const gitA=verifiedCommonGitDir(dirA),gitB=verifiedCommonGitDir(dirB)
    return Boolean(gitA&&gitB&&gitA===gitB)
  }catch{return false}
}

export const RELAY_PLACEHOLDER_PASSWORD='attested-loopback-relay'
export const RELAY_PLACEHOLDER_COOKIE='fixture-relay-placeholder'

export function parseCookiePairs(header){
  const map=new Map()
  if(typeof header!=='string')return map
  for(const part of header.split(';')){
    const eq=part.indexOf('=')
    if(eq<=0)continue
    const name=part.slice(0,eq).trim()
    const value=part.slice(eq+1).trim()
    if(name)map.set(name,value)
  }
  return map
}

export function substitutePlaceholderCookies(cookieHeader,cookieMap){
  if(typeof cookieHeader!=='string'||!cookieHeader.includes(RELAY_PLACEHOLDER_COOKIE)||!cookieMap.size){
    return cookieHeader
  }
  return cookieHeader.split(';').map(part=>{
    const trimmed=part.trim()
    const eq=trimmed.indexOf('=')
    if(eq<=0)return trimmed
    const name=trimmed.slice(0,eq).trim()
    const value=trimmed.slice(eq+1).trim()
    if(value===RELAY_PLACEHOLDER_COOKIE&&cookieMap.has(name)){
      return `${name}=${cookieMap.get(name)}`
    }
    return trimmed
  }).join('; ')
}

export function maskSetCookieHeaders(setCookie,cookieMap){
  if(!setCookie)return setCookie
  const list=Array.isArray(setCookie)?setCookie:[setCookie]
  const masked=[]
  for(const item of list){
    const [pair,...attrs]=item.split(';')
    const eq=pair.indexOf('=')
    if(eq>0){
      const name=pair.slice(0,eq).trim()
      const value=pair.slice(eq+1).trim()
      if(name){
        cookieMap.set(name,value)
        masked.push([`${name}=${RELAY_PLACEHOLDER_COOKIE}`,...attrs].join(';'))
        continue
      }
    }
    masked.push(item)
  }
  return masked
}

export function stripFixtureServerSecrets(env){
  return Object.fromEntries(Object.entries(env??{}).filter(([key])=>
    !/^(CNRS_|CODENOMAD_SERVER_PASSWORD$|OPENCODE_SERVER_PASSWORD$)/i.test(key)
    &&!/(?:^|_)(PASSWORD|SECRET|TOKEN|API_KEY)$/i.test(key)))
}

export function worktreeDependencyRoots(nodeModulesDir=worktreeNodeModules){
  assert(existsSync(nodeModulesDir),'Worktree node_modules is required; parent checkout dependencies are forbidden')
  const rootReal=realpathSync(nodeModulesDir)
  const inWorktree=isWithin(repoRootReal,rootReal)
  // Worktrees created under .codenomad/worktrees may mount node_modules as a read-only junction/symlink
  // to a lockfile-identical sibling worktree (never the parent checkout).
  const inLockMatchedSibling=nodeModulesDir===worktreeNodeModules
    && lstatSync(worktreeNodeModules).isSymbolicLink()
    && path.basename(worktreesDir)==='worktrees'
    && path.basename(path.dirname(worktreesDir))==='.codenomad'
    && path.basename(rootReal)==='node_modules'
    && path.dirname(path.dirname(rootReal))===worktreesDir
    && sameWorktreeRepoAndManifests(repoRootReal,path.dirname(rootReal))
  assert(inWorktree||inLockMatchedSibling,
    `node_modules resolved outside repository boundary: ${rootReal}`)
  return {repoRootReal,nodeModulesReal:rootReal}
}

export function assertWorktreeModuleResolution(specifier,fromFile,nodeModulesDir=worktreeNodeModules){
  const {nodeModulesReal}=worktreeDependencyRoots(nodeModulesDir)
  const scopedRequire=createRequire(fromFile)
  const cjsResolved=realpathSync(scopedRequire.resolve(specifier))
  assert(isWithin(nodeModulesReal,cjsResolved)&&cjsResolved!==nodeModulesReal,
    `Dependency ${specifier} (CJS) from ${fromFile} resolved outside worktree node_modules: ${cjsResolved}`)
  const pkg=packageNameOf(specifier)
  const pkgJsonPath=realpathSync(scopedRequire.resolve(`${pkg}/package.json`))
  assert(isWithin(nodeModulesReal,pkgJsonPath)&&pkgJsonPath!==nodeModulesReal,
    `Package metadata for ${specifier} from ${fromFile} resolved outside worktree node_modules: ${pkgJsonPath}`)
  const pkgDir=path.dirname(pkgJsonPath)
  const manifest=JSON.parse(readFileSync(pkgJsonPath,'utf8'))
  const collectTargets=(value,out=[])=>{
    if(typeof value==='string'){out.push(value);return out}
    if(value&&typeof value==='object')for(const child of Object.values(value))collectTargets(child,out)
    return out
  }
  const subpath=specifier===pkg?'.':`./${specifier.slice(pkg.length+1)}`
  const exportEntry=manifest.exports&&typeof manifest.exports==='object'
    ?(Object.hasOwn(manifest.exports,subpath)?manifest.exports[subpath]:manifest.exports['.'])
    :manifest.exports
  const candidateTargets=[...collectTargets(exportEntry),manifest.module,manifest.main].filter(t=>typeof t==='string'&&!t.includes('*'))
  for(const target of candidateTargets){
    const abs=path.resolve(pkgDir,target)
    if(!existsSync(abs))continue
    const real=realpathSync(abs)
    assert(isWithin(nodeModulesReal,real)&&real!==nodeModulesReal,
      `Dependency ${specifier} entry ${target} from ${fromFile} resolved outside worktree node_modules: ${real}`)
  }
  return pathToFileURL(cjsResolved).href
}

export function resolveWorktreePackage(specifier,nodeModulesDir=worktreeNodeModules){
  const {nodeModulesReal:rootReal}=worktreeDependencyRoots(nodeModulesDir)
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

function safePrefixLength(text,tokens,minLen=1){
  if(!text||!tokens.length)return text.length
  let unsafeSuffix=0
  for(const token of tokens){
    const maxCheck=Math.min(text.length,token.length-1)
    for(let len=maxCheck;len>=minLen&&len>unsafeSuffix;len--){
      if(text.endsWith(token.slice(0,len))){
        unsafeSuffix=len
        break
      }
    }
  }
  return text.length-unsafeSuffix
}

export function createStreamRedactor(secrets=[]){
  const tokens=[]
  for(const secret of secrets){
    if(!secret)continue
    tokens.push(secret,Buffer.from(`opencode:${secret}`).toString('base64'),Buffer.from(`codenomad:${secret}`).toString('base64'))
  }
  const overlap=tokens.reduce((max,token)=>Math.max(max,token.length),0)
  let tail=''
  return {
    push(chunk){
      if(!overlap)return String(chunk??'')
      const combined=redactSecrets(tail+String(chunk??''),secrets)
      if(combined.length<=overlap){
        tail=combined
        return ''
      }
      const cut=combined.length-overlap
      tail=combined.slice(cut)
      return combined.slice(0,cut)
    },
    flush(){
      const redacted=redactSecrets(tail,secrets)
      tail=''
      const safeLen=safePrefixLength(redacted,tokens,4)
      return safeLen<redacted.length?`${redacted.slice(0,safeLen)}<truncated>`:redacted
    },
    peek(){
      const redacted=redactSecrets(tail,secrets)
      return redacted.slice(0,safePrefixLength(redacted,tokens,1))
    },
  }
}

const {Agent,Pool,buildConnector,fetch:undiciFetch}=await import(resolveWorktreePackage('undici'))

const dispatcher=new Agent()
export const fixtureHttpAgent=new HttpAgent({keepAlive:true,proxyEnv:{}})

async function assertTargetIncarnation(pid,expectedStartId,probeIdentity=probeProcessIdentity){
  const res=await probeIdentity(pid,{refresh:true}).catch(()=>({status:'unknown',identity:null}))
  if(res.status!=='ok'||!res.identity?.startId){
    throw Error(`Unable to attest target PID ${pid} OS incarnation (status=${res.status})`)
  }
  if(expectedStartId&&res.identity.startId!==expectedStartId){
    throw Error(`Target PID ${pid} incarnation changed (expected ${expectedStartId}, got ${res.identity.startId})`)
  }
  return res.identity.startId
}

export async function originGuardProxy(localOrigin,targetPid,options={}){
  const {requireClientAttestation=false,allowDescendants=false,allowedClientPids=[],injectCookie,targetStartId:initialStartId=null,probeIdentity=probeProcessIdentity}=options
  if(!Number.isSafeInteger(targetPid)||targetPid<=0)throw Error('Attested origin guard target PID required')
  const base=new URL(localOrigin)
  assert(['http:','https:'].includes(base.protocol)&&base.hostname==='127.0.0.1'&&base.port,'Expected a loopback HTTP(S) origin for originGuardProxy')
  const isHttps=base.protocol==='https:'
  const targetPort=Number(base.port)
  let currentTargetPid=targetPid
  let currentTargetStartId=initialStartId??await assertTargetIncarnation(targetPid,null,probeIdentity)
  let generation=0
  let closed=false
  let closePromise=null
  let agent=isHttps?null:createAttestedHttpAgent(targetPort,currentTargetPid,{targetStartId:currentTargetStartId,probeIdentity})
  const injectCookieMap=parseCookiePairs(injectCookie)
  let proxyPort=0
  const clientGate=createClientPidGate(()=>proxyPort,verifyLoopbackConnectionPeer,{allowDescendants})
  for(const clientPid of allowedClientPids)clientGate.allow(clientPid)
  const detachedSockets=new Set()
  const tunnelSockets=new Set()
  const rejectDetached=(_req,socket)=>{
    detachedSockets.add(socket)
    socket.once('close',()=>detachedSockets.delete(socket))
    socket.once('error',()=>{})
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n',()=>{try{socket.destroy()}catch{}})
  }
  const server=createServer(async(req,res)=>{
    if(isHttps){res.writeHead(403);res.end('HTTPS origin requires CONNECT tunnel');return}
    let target
    try{target=new URL(req.url,localOrigin)}catch{res.writeHead(403);res.end();return}
    if(target.origin!==localOrigin){res.writeHead(403);res.end('Foreign browser origin forbidden');return}
    const reqGen=generation
    if(requireClientAttestation){
      req.pause()
      const ok=await clientGate.verify(req.socket)
      if(res.destroyed||req.socket.destroyed)return
      if(!ok){req.resume();res.writeHead(403,{connection:'close'});res.end('Attested browser client PID required');return}
    }
    if(closed||reqGen!==generation||!agent){
      if(!res.headersSent)res.writeHead(502)
      res.end('Target rotated during request admission')
      return
    }
    const reqAgent=agent
    const headers={...req.headers}
    delete headers['proxy-connection']
    if(injectCookieMap.size&&typeof headers.cookie==='string'){
      headers.cookie=substitutePlaceholderCookies(headers.cookie,injectCookieMap)
    }
    const upstream=httpRequest(target,{agent:reqAgent,method:req.method,headers:{...headers,host:target.host}},response=>{
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
      const outHeaders={...response.headers}
      if(injectCookieMap.size&&outHeaders['set-cookie']){
        outHeaders['set-cookie']=maskSetCookieHeaders(outHeaders['set-cookie'],injectCookieMap)
      }
      res.writeHead(response.statusCode,outHeaders)
      response.on('close',()=>{if(!response.complete)res.destroy()})
      response.on('error',()=>res.destroy())
      response.pipe(res)
    })
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()})
    req.on('aborted',()=>upstream.destroy())
    res.on('close',()=>upstream.destroy())
    if(req.readableEnded)upstream.end()
    else req.pipe(upstream)
  })
  server.on('connect',(req,socket,head)=>{
    if(!isHttps||req.url!==`127.0.0.1:${targetPort}`){
      rejectDetached(req,socket)
      return
    }
    let upstream
    let tunneled=false
    const teardown=(status)=>{
      if(status&&!tunneled&&!socket.destroyed){
        socket.end(`HTTP/1.1 ${status}\r\n\r\n`,()=>{try{socket.destroy()}catch{}})
      }else{
        try{socket.destroy()}catch{}
      }
      try{upstream?.destroy()}catch{}
    }
    tunnelSockets.add(socket)
    socket.once('close',()=>{tunnelSockets.delete(socket);try{upstream?.destroy()}catch{}})
    socket.once('error',()=>teardown())
    if(closed){teardown('503 Service Unavailable');return}
    socket.pause()
    const pid=currentTargetPid
    const expectedStartId=currentTargetStartId
    const reqGen=generation
    const gate=requireClientAttestation?clientGate.verify(socket):Promise.resolve(true)
    const listenerCheck=verifyLoopbackListenerOwner(targetPort,pid,undefined,{coalesce:true}).then(()=>true,()=>false)
    Promise.all([gate.catch(()=>false),listenerCheck]).then(([allowed,listenerOk])=>{
      if(!allowed||closed||socket.destroyed){teardown('403 Forbidden');return}
      if(!listenerOk||reqGen!==generation||pid!==currentTargetPid){teardown('502 Bad Gateway');return}
      upstream=net.createConnection({host:'127.0.0.1',port:targetPort})
      tunnelSockets.add(upstream)
      upstream.once('close',()=>{tunnelSockets.delete(upstream);try{socket.destroy()}catch{}})
      upstream.once('error',()=>teardown('502 Bad Gateway'))
      upstream.once('connect',()=>{
        if(closed||socket.destroyed||upstream.destroyed||!upstream.localPort||reqGen!==generation||pid!==currentTargetPid){
          teardown('502 Bad Gateway');return
        }
        attestPeerWithRetry(upstream.localPort,targetPort,pid,verifyLoopbackConnectionPeer,()=>closed||socket.destroyed||upstream.destroyed||reqGen!==generation||pid!==currentTargetPid)
          .then(()=>assertTargetIncarnation(pid,expectedStartId,probeIdentity))
          .then(()=>{
            if(closed||socket.destroyed||upstream.destroyed||reqGen!==generation||pid!==currentTargetPid){teardown('502 Bad Gateway');return}
            tunneled=true
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if(head?.length)upstream.write(head)
            socket.pipe(upstream)
            upstream.pipe(socket)
            socket.resume()
          })
          .catch(()=>teardown('502 Bad Gateway'))
      })
    }).catch(()=>teardown('502 Bad Gateway'))
  })
  server.on('upgrade',rejectDetached)
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  proxyPort=server.address().port
  return {
    port:proxyPort,
    allowClientPid:clientGate.allow,
    substituteCookies:header=>substitutePlaceholderCookies(header,injectCookieMap),
    maskSetCookies:setCookie=>maskSetCookieHeaders(setCookie,injectCookieMap),
    setTargetPid(nextPid,nextStartId=null){
      assert(Number.isSafeInteger(nextPid)&&nextPid>0,'Attested origin guard target PID required')
      generation++
      currentTargetPid=nextPid
      currentTargetStartId=nextStartId
      for(const socket of [...tunnelSockets]){try{socket.destroy()}catch{}}
      tunnelSockets.clear()
      if(!isHttps){
        agent?.destroy()
        agent=createAttestedHttpAgent(targetPort,currentTargetPid,{targetStartId:currentTargetStartId,probeIdentity})
      }
    },
    close:()=>{
      if(closePromise)return closePromise
      closed=true
      clientGate.close()
      for(const socket of [...detachedSockets,...tunnelSockets]){try{socket.destroy()}catch{}}
      detachedSockets.clear()
      tunnelSockets.clear()
      agent?.destroy()
      server.closeAllConnections()
      closePromise=new Promise((resolve,reject)=>server.close(err=>{
        if(err&&err.code!=='ERR_SERVER_NOT_RUNNING')reject(err)
        else resolve()
      }))
      return closePromise
    },
  }
}

let attestedConnectDepth=0
export function isInsideAttestedConnect(){return attestedConnectDepth>0}

export function createAttestedPool(origin,port,pid,verifyOwnerOrOptions=verifyLoopbackListenerOwner,verifyPeerArg){
  const opts=typeof verifyOwnerOrOptions==='function'
    ?{verifyOwner:verifyOwnerOrOptions,verifyPeer:verifyPeerArg}
    :(verifyOwnerOrOptions??{})
  const verifyOwner=opts.verifyOwner??verifyLoopbackListenerOwner
  const checkPeer=opts.verifyPeer??(verifyOwner===verifyLoopbackListenerOwner?verifyLoopbackConnectionPeer:(_local,remote,expectedPid)=>verifyOwner(remote,expectedPid))
  const allowSelfSigned=opts.allowSelfSigned===true
  const ca=opts.ca
  const probeIdentity=opts.probeIdentity??probeProcessIdentity
  const onAttested=typeof opts.onAttested==='function'?opts.onAttested:null
  const enforceIncarnation=verifyOwner===verifyLoopbackListenerOwner||opts.targetStartId!=null||opts.probeIdentity!=null
  let expectedStartId=opts.targetStartId??null
  const checkIncarnation=async()=>{
    if(!enforceIncarnation)return
    expectedStartId=await assertTargetIncarnation(pid,expectedStartId,probeIdentity)
  }
  const isHttps=new URL(origin).protocol==='https:'
  const connector=isHttps?null:buildConnector({})
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
          if(isHttps){
            const tcpSocket=net.createConnection({host:'127.0.0.1',port})
            let tlsSocket=null
            let settled=false
            const done=(err,sock)=>{
              if(settled)return
              settled=true
              tcpSocket.off('close',onEarlyClose)
              tcpSocket.off('error',onEarlyError)
              if(tlsSocket){
                tlsSocket.off('close',onEarlyClose)
                tlsSocket.off('error',onEarlyError)
                tlsSocket.off('secureConnect',onSecureConnect)
              }
              pendingSockets.delete(entry)
              if(err){
                try{tlsSocket?.destroy()}catch{}
                try{tcpSocket.destroy()}catch{}
              }
              cb(err,sock)
            }
            const onEarlyClose=()=>done(Error('Socket closed during peer attestation'),null)
            const onEarlyError=err=>done(err,null)
            const onSecureConnect=()=>{try{onAttested?.()}catch(err){done(err,null);return}done(null,tlsSocket)}
            const entry={socket:tcpSocket,fail:err=>done(err,null)}
            pendingSockets.add(entry)
            tcpSocket.once('close',onEarlyClose)
            tcpSocket.once('error',onEarlyError)
            tcpSocket.once('connect',()=>{
              if(closed||tcpSocket.destroyed||!tcpSocket.localPort){
                done(Error('Socket connection closed before peer attestation'),null)
                return
              }
              attestPeerWithRetry(tcpSocket.localPort,port,pid,checkPeer,()=>closed||tcpSocket.destroyed)
                .then(()=>checkIncarnation())
                .then(()=>{
                  if(closed||tcpSocket.destroyed){done(Error('Socket closed during peer attestation'),null);return}
                  const rawHost=new URL(origin).hostname
                  const unbracketedHost=rawHost.startsWith('[')&&rawHost.endsWith(']')?rawHost.slice(1,-1):rawHost
                  const servername=isIP(unbracketedHost)===0?rawHost:undefined
                  tlsSocket=tls.connect({
                    socket:tcpSocket,
                    host:unbracketedHost,
                    ...(servername?{servername}:{}),
                    ...(ca?{ca,rejectUnauthorized:true}:{rejectUnauthorized:!allowSelfSigned}),
                  })
                  tlsSocket.once('close',onEarlyClose)
                  tlsSocket.once('error',onEarlyError)
                  tlsSocket.once('secureConnect',onSecureConnect)
                })
                .catch(postError=>done(postError,null))
            })
            return
          }
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
            attestPeerWithRetry(socket.localPort,port,pid,checkPeer,()=>closed||socket.destroyed)
              .then(()=>checkIncarnation())
              .then(()=>{
                if(closed||socket.destroyed){done(Error('Socket closed during peer attestation'),null);return}
                try{onAttested?.()}catch(err){done(err,null);return}
                done(null,socket)
              })
              .catch(postError=>done(postError,null))
          })
        }finally{attestedConnectDepth--}
      },error=>cb(error,null))
    },
  })
  let closePromise=null
  const close=()=>{
    if(closePromise)return closePromise
    closed=true
    for(const entry of [...pendingSockets])entry.fail(Error('Attested pool is closed'))
    pendingSockets.clear()
    closePromise=pool.destroy()
    return closePromise
  }
  return {pool,close}
}

export function createAttestedFetch(origin,port,pid,verifyOwnerOrOptions=verifyLoopbackListenerOwner,verifyPeerArg){
  const {pool,close}=createAttestedPool(origin,port,pid,verifyOwnerOrOptions,verifyPeerArg)
  const fetchBound=(input,init={})=>{
    if(input instanceof Request){
      const {url,method,headers,body,signal}=input
      return fetchBound(url,{method,headers,body,signal,...init})
    }
    return undiciFetch(input,{...init,duplex:'half',dispatcher:pool,redirect:init.redirect??'error'})
  }
  fetchBound.request=options=>pool.request(options)
  fetchBound.close=close
  return fetchBound
}

export function createAttestedHttpAgent(port,pid,verifyOwnerOrOptions=verifyLoopbackListenerOwner,verifyPeerArg){
  const opts=typeof verifyOwnerOrOptions==='function'
    ?{verifyOwner:verifyOwnerOrOptions,verifyPeer:verifyPeerArg}
    :(verifyOwnerOrOptions??{})
  const verifyOwner=opts.verifyOwner??verifyLoopbackListenerOwner
  const checkPeer=opts.verifyPeer??(verifyOwner===verifyLoopbackListenerOwner?verifyLoopbackConnectionPeer:(_local,remote,expectedPid)=>verifyOwner(remote,expectedPid))
  const probeIdentity=opts.probeIdentity??probeProcessIdentity
  const enforceIncarnation=verifyOwner===verifyLoopbackListenerOwner||opts.targetStartId!=null||opts.probeIdentity!=null
  let expectedStartId=opts.targetStartId??null
  const checkIncarnation=async()=>{
    if(!enforceIncarnation)return
    expectedStartId=await assertTargetIncarnation(pid,expectedStartId,probeIdentity)
  }
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
        attestPeerWithRetry(socket.localPort,port,pid,checkPeer,()=>closed||settled||socket.destroyed)
          .then(()=>checkIncarnation())
          .then(()=>{
            if(closed||settled||socket.destroyed){finish(Error('Socket closed during peer attestation'));return}
            finish(null,socket)
          })
          .catch(finish)
      })
    }).catch(finish)
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

export async function createAttestedTcpRelay(port,pid,optionsOrVerifyOwner,verifyPeerArg){
  const opts=typeof optionsOrVerifyOwner==='function'
    ?{verifyOwner:optionsOrVerifyOwner,verifyPeer:verifyPeerArg}
    :(optionsOrVerifyOwner??{})
  const {
    verifyOwner=verifyLoopbackListenerOwner,
    verifyPeer=verifyLoopbackConnectionPeer,
    requireClientAttestation=false,
    allowedClientPids=[],
    targetStartId:initialStartId=null,
    probeIdentity=probeProcessIdentity,
  }=opts
  assert(Number.isSafeInteger(port)&&port>0&&port<=65535,'Invalid loopback port for TCP relay')
  assert(Number.isSafeInteger(pid)&&pid>0,'Invalid fixture PID for TCP relay')
  const enforceIncarnation=verifyOwner===verifyLoopbackListenerOwner||initialStartId!=null||opts.probeIdentity!=null
  let closed=false,relayPort=0,currentPid=pid,currentStartId=initialStartId,generation=0,closePromise=null
  if(enforceIncarnation&&!currentStartId){
    currentStartId=await assertTargetIncarnation(currentPid,null,probeIdentity)
  }
  const sockets=new Set()
  const clientGate=createClientPidGate(()=>relayPort,verifyPeer)
  for(const clientPid of allowedClientPids)clientGate.allow(clientPid)
  const server=net.createServer(client=>{
    let upstream
    const teardown=()=>{client.destroy();upstream?.destroy()}
    client.once('error',teardown)
    client.once('close',()=>{sockets.delete(client);upstream?.destroy()})
    if(closed){client.destroy();return}
    client.pause()
    sockets.add(client)
    const gate=requireClientAttestation?clientGate.verify(client):Promise.resolve(true)
    gate.then(allowed=>{
      if(!allowed||closed||client.destroyed){client.destroy();return}
      const targetPid=currentPid
      const expectedStartId=currentStartId
      const reqGen=generation
      return verifyOwner(port,targetPid).then(()=>{
        if(closed||client.destroyed||reqGen!==generation||currentPid!==targetPid){client.destroy();return}
        upstream=net.createConnection({host:'127.0.0.1',port})
        sockets.add(upstream)
        upstream.once('close',()=>{sockets.delete(upstream);client.destroy()})
        upstream.once('error',teardown)
        upstream.once('connect',()=>{
          if(closed||client.destroyed||upstream.destroyed||!upstream.localPort||reqGen!==generation||currentPid!==targetPid){
            teardown();return
          }
          attestPeerWithRetry(upstream.localPort,port,targetPid,verifyPeer,()=>closed||client.destroyed||upstream.destroyed||reqGen!==generation||currentPid!==targetPid)
            .then(()=>enforceIncarnation?assertTargetIncarnation(targetPid,expectedStartId,probeIdentity):null)
            .then(()=>{
              if(closed||client.destroyed||upstream.destroyed||reqGen!==generation||currentPid!==targetPid){teardown();return}
              client.pipe(upstream)
              upstream.pipe(client)
              client.resume()
            })
            .catch(teardown)
        })
      })
    },teardown).catch(teardown)
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  relayPort=server.address().port
  return {
    port:relayPort,
    allowClientPid:clientGate.allow,
    setTargetPid(nextPid,nextStartId=null){
      assert(Number.isSafeInteger(nextPid)&&nextPid>0,'Invalid fixture target PID')
      generation++
      currentPid=nextPid
      currentStartId=nextStartId
      for(const s of [...sockets]){try{s.destroy()}catch{}}
      sockets.clear()
    },
    close:()=>{
      if(closePromise)return closePromise
      closed=true
      clientGate.close()
      for(const s of [...sockets]){try{s.destroy()}catch{}}
      sockets.clear()
      closePromise=new Promise((resolve,reject)=>server.close(err=>{
        if(err&&err.code!=='ERR_SERVER_NOT_RUNNING')reject(err)
        else resolve()
      }))
      return closePromise
    },
  }
}

export async function createAttestedRelay(targetOrigin,pid,options){
  const opts=typeof options==='function'?{onRequest:options}:(options??{})
  const {onRequest,expectAuthorization,injectAuthorization,requireClientAttestation=false,substitutePassword,isolateSessionCookie=false}=opts
  const base=new URL(targetOrigin)
  assert(base.protocol==='http:'&&base.hostname==='127.0.0.1'&&base.port,'Expected a loopback HTTP target for attested relay')
  const agent=createAttestedHttpAgent(Number(base.port),pid)
  let relayPort=0,closePromise=null
  const relayCookieMap=new Map()
  const clientGate=createClientPidGate(()=>relayPort)
  const server=createServer(async(req,res)=>{
    const url=relayTarget(req,res,base.origin)
    if(!url)return
    if(requireClientAttestation){
      req.pause()
      const ok=await clientGate.verify(req.socket)
      if(res.destroyed||req.socket.destroyed)return
      if(!ok){
        req.resume()
        res.writeHead(403,{connection:'close'})
        res.end('Attested client PID required')
        return
      }
    }
    if(expectAuthorization&&req.headers.authorization!==expectAuthorization){
      res.writeHead(401)
      res.end('Attested relay token required')
      return
    }
    if(onRequest&&onRequest(req,res,url)===false)return
    const headers={...req.headers,host:url.host}
    if(injectAuthorization)headers.authorization=injectAuthorization
    if(isolateSessionCookie&&typeof headers.cookie==='string'){
      headers.cookie=substitutePlaceholderCookies(headers.cookie,relayCookieMap)
    }
    const handleResponse=response=>{
      if(response.statusCode>=300&&response.statusCode<400){
        response.destroy()
        if(!res.headersSent)res.writeHead(502)
        res.end('Upstream redirect forbidden in attested relay')
        return
      }
      const outHeaders={...response.headers}
      if(isolateSessionCookie&&outHeaders['set-cookie']){
        outHeaders['set-cookie']=maskSetCookieHeaders(outHeaders['set-cookie'],relayCookieMap)
      }
      res.writeHead(response.statusCode,outHeaders)
      response.on('close',()=>{if(!response.complete)res.destroy()})
      response.on('error',()=>res.destroy())
      response.pipe(res)
    }
    if(substitutePassword&&req.method==='POST'&&url.pathname==='/api/auth/login'){
      try{
        const chunks=[];let total=0
        req.resume()
        for await(const chunk of req){total+=chunk.length;if(total>=65536){res.writeHead(413);res.end();return}chunks.push(chunk)}
        const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if(payload?.password===RELAY_PLACEHOLDER_PASSWORD)payload.password=substitutePassword
        const body=Buffer.from(JSON.stringify(payload))
        headers['content-length']=String(body.length)
        delete headers['transfer-encoding']
        const upstream=httpRequest(url,{agent,method:req.method,headers},handleResponse)
        upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()})
        req.on('aborted',()=>upstream.destroy())
        res.on('close',()=>upstream.destroy())
        upstream.end(body)
        return
      }catch{
        if(!res.headersSent)res.writeHead(400)
        res.end()
        return
      }
    }
    const upstream=httpRequest(url,{agent,method:req.method,headers},handleResponse)
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()})
    req.on('aborted',()=>upstream.destroy())
    res.on('close',()=>upstream.destroy())
    if(req.readableEnded)upstream.end()
    else req.pipe(upstream)
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  relayPort=server.address().port
  return {
    origin:`http://127.0.0.1:${relayPort}`,
    allowClientPid:clientGate.allow,
    close:()=>{
      if(closePromise)return closePromise
      clientGate.close()
      agent.destroy()
      server.closeAllConnections()
      closePromise=new Promise((resolve,reject)=>server.close(err=>{
        if(err&&err.code!=='ERR_SERVER_NOT_RUNNING')reject(err)
        else resolve()
      }))
      return closePromise
    },
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
