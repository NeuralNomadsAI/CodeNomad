import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs'
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
const worktreeNodeModules=path.join(repoRoot,'node_modules')

function isWithin(root,target){
  const rel=path.relative(root,target)
  return rel===''||(Boolean(rel)&&!path.isAbsolute(rel)&&rel.split(path.sep)[0]!=='..')
}

function packageNameOf(specifier){
  const parts=specifier.split('/')
  return specifier.startsWith('@')?parts.slice(0,2).join('/'):parts[0]
}

function sameLockfile(dirA,dirB){
  const lockA=path.join(dirA,'package-lock.json'),lockB=path.join(dirB,'package-lock.json')
  if(!existsSync(lockA)||!existsSync(lockB))return false
  const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
  return hash(lockA)===hash(lockB)
}

export const RELAY_PLACEHOLDER_PASSWORD='attested-loopback-relay'

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
    && sameLockfile(repoRootReal,path.dirname(rootReal))
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

const netstatBin=()=>{
  const systemRoot=process.env.SystemRoot||process.env.WINDIR||'C:\\Windows'
  assert(/^[A-Za-z]:\\Windows$/i.test(systemRoot),`Unexpected SystemRoot for netstat.exe: ${systemRoot}`)
  assert(!lstatSync(systemRoot).isSymbolicLink(),`SystemRoot must not be a symbolic link: ${systemRoot}`)
  const system32=path.win32.join(systemRoot,'System32')
  assert(!lstatSync(system32).isSymbolicLink(),`System32 must not be a symbolic link: ${system32}`)
  const candidate=path.win32.join(system32,'netstat.exe')
  assert(existsSync(candidate)&&!lstatSync(candidate).isSymbolicLink(),`Expected system netstat executable at ${candidate}`)
  return candidate
}
const lsofBin=()=>{
  for(const candidate of ['/usr/sbin/lsof','/usr/bin/lsof']){
    if(existsSync(candidate))return candidate
  }
  throw Error('Expected system lsof executable at /usr/sbin/lsof or /usr/bin/lsof')
}

const {Agent,Pool,buildConnector,fetch:undiciFetch}=await import(resolveWorktreePackage('undici'))

const dispatcher=new Agent()
export const fixtureHttpAgent=new HttpAgent({keepAlive:true,proxyEnv:{}})

export async function verifyLoopbackListenerOwner(port,pid,forbidden='the shared OpenCode service is forbidden'){
  assert(Number.isSafeInteger(port)&&port>0&&port<=65535,'Invalid loopback port')
  assert(Number.isSafeInteger(pid)&&pid>0,'Invalid fixture PID')
  if(process.platform==='win32'){
    const {stdout}=await execFileAsync(netstatBin(),['-ano','-p','tcp'],{timeout:10000,windowsHide:true,maxBuffer:8*1024*1024})
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
  const {stdout}=await execFileAsync(lsofBin(),['-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-Fpn'],{timeout:10000})
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
    const {stdout}=await execFileAsync(netstatBin(),['-ano','-p','tcp'],{timeout:10000,windowsHide:true,maxBuffer:8*1024*1024})
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
  const {stdout}=await execFileAsync(lsofBin(),['-nP',`-iTCP:${remotePort}`,'-sTCP:ESTABLISHED','-Fpn'],{timeout:10000})
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

function pidAlive(pid){
  if(!Number.isSafeInteger(pid)||pid<=0)return false
  try{process.kill(pid,0);return true}catch(error){return error.code==='EPERM'}
}

const psSystemBin=()=>['/bin/ps','/usr/bin/ps'].find(candidate=>existsSync(candidate))

async function processIdentityOf(pid){
  if(!Number.isSafeInteger(pid)||pid<=0)return null
  if(process.platform==='linux'){
    try{
      const statText=await readFile(`/proc/${pid}/stat`,'utf8')
      const closeParen=statText.lastIndexOf(')')
      if(closeParen<0)return null
      const fields=statText.slice(closeParen+2).trim().split(/\s+/)
      const ppid=Number(fields[1])
      const startId=fields[19]
      if(!Number.isSafeInteger(ppid)||ppid<=0||!startId)return null
      return {ppid,startId}
    }catch{return null}
  }
  if(process.platform==='win32'){
    const systemRoot=process.env.SystemRoot||process.env.WINDIR||'C:\\Windows'
    const powershell=path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
    if(!existsSync(powershell)||lstatSync(powershell).isSymbolicLink())return null
    try{
      const {stdout}=await execFileAsync(powershell,['-NoProfile','-NonInteractive','-Command',`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){"$($p.ParentProcessId)|$($p.CreationDate.ToUniversalTime().Ticks)"}`],{timeout:5000,windowsHide:true})
      const [rawPpid,startId]=stdout.trim().split('|')
      const ppid=Number(rawPpid)
      if(!Number.isSafeInteger(ppid)||ppid<=0||!startId)return null
      return {ppid,startId}
    }catch{return null}
  }
  const psBin=psSystemBin()
  if(!psBin)return null
  try{
    const {stdout}=await execFileAsync(psBin,['-o','ppid=,lstart=','-p',String(pid)],{timeout:5000})
    const trimmed=stdout.trim()
    const match=/^(\d+)\s+(.+)$/.exec(trimmed)
    if(!match)return null
    const ppid=Number(match[1])
    const startId=match[2].trim()
    if(!Number.isSafeInteger(ppid)||ppid<=0||!startId)return null
    return {ppid,startId}
  }catch{return null}
}

async function isPidInOwnedTree(peerPid,rootPid){
  const peerInfo=await processIdentityOf(peerPid)
  if(!peerInfo)return null
  if(peerPid===rootPid)return peerInfo.startId
  let current=peerInfo.ppid
  if(current===rootPid)return peerInfo.startId
  for(let depth=1;depth<8&&current>1;depth++){
    const info=await processIdentityOf(current)
    if(!info||info.ppid===current)return null
    if(info.ppid===rootPid)return peerInfo.startId
    current=info.ppid
  }
  return null
}

async function resolveLoopbackPeerPid(localPort,remotePort){
  if(process.platform==='win32'){
    const {stdout}=await execFileAsync(netstatBin(),['-ano','-p','tcp'],{timeout:10000,windowsHide:true,maxBuffer:8*1024*1024})
    const owners=new Set()
    for(const line of stdout.split(/\r?\n/)){
      const match=/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+127\.0\.0\.1:(\d+)\s+ESTABLISHED\s+(\d+)\s*$/i.exec(line)
      if(match&&Number(match[1])===remotePort&&Number(match[2])===localPort)owners.add(Number(match[3]))
    }
    return owners.size===1?[...owners][0]:null
  }
  if(process.platform==='linux'){
    const peerAddr=`0100007F:${remotePort.toString(16).toUpperCase().padStart(4,'0')}`
    const localAddr=`0100007F:${localPort.toString(16).toUpperCase().padStart(4,'0')}`
    const table=await readFile('/proc/net/tcp','utf8')
    const inodes=new Set()
    for(const line of table.split('\n').slice(1)){
      const cols=line.trim().split(/\s+/)
      if(cols.length>=10&&cols[1]===peerAddr&&cols[2]===localAddr&&cols[3]==='01')inodes.add(`socket:[${cols[9]}]`)
    }
    if(inodes.size!==1)return null
    const [inode]=inodes
    const entries=await readdir('/proc').catch(()=>[])
    for(const entry of entries){
      if(!/^\d+$/.test(entry))continue
      const fds=await readdir(`/proc/${entry}/fd`).catch(()=>[])
      for(const fd of fds){
        try{if(await readlink(`/proc/${entry}/fd/${fd}`)===inode)return Number(entry)}catch{}
      }
    }
    return null
  }
  const {stdout}=await execFileAsync(lsofBin(),['-nP',`-iTCP:${remotePort}`,'-sTCP:ESTABLISHED','-Fpn'],{timeout:10000})
  const owners=new Set()
  let currentPid=null
  const expected=`127.0.0.1:${remotePort}->127.0.0.1:${localPort}`
  for(const line of stdout.split(/\r?\n/)){
    if(line.startsWith('p'))currentPid=Number(line.slice(1))
    else if(line.startsWith('n')&&line.slice(1)===expected&&Number.isSafeInteger(currentPid))owners.add(currentPid)
  }
  return owners.size===1?[...owners][0]:null
}

export async function originGuardProxy(localOrigin,targetPid,options={}){
  const {requireClientAttestation=false,allowDescendants=false,allowedClientPids=[]}=options
  if(!Number.isSafeInteger(targetPid)||targetPid<=0)throw Error('Attested origin guard target PID required')
  const base=new URL(localOrigin)
  const agent=createAttestedHttpAgent(Number(base.port),targetPid)
  let proxyPort=0
  const clientGate=createClientPidGate(()=>proxyPort,verifyLoopbackConnectionPeer,{allowDescendants})
  for(const clientPid of allowedClientPids)clientGate.allow(clientPid)
  const detachedSockets=new Set()
  const rejectDetached=(_req,socket)=>{
    detachedSockets.add(socket)
    socket.once('close',()=>detachedSockets.delete(socket))
    socket.once('error',()=>{})
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n',()=>{try{socket.destroy()}catch{}})
  }
  const server=createServer(async(req,res)=>{
    let target
    try{target=new URL(req.url,localOrigin)}catch{res.writeHead(403);res.end();return}
    if(target.origin!==localOrigin){res.writeHead(403);res.end('Foreign browser origin forbidden');return}
    if(requireClientAttestation){
      req.pause()
      const ok=await clientGate.verify(req.socket)
      if(res.destroyed||req.destroyed)return
      if(!ok){res.writeHead(403);res.end('Attested browser client PID required');return}
    }
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
      response.on('close',()=>{if(!response.complete)res.destroy()})
      response.on('error',()=>res.destroy())
      response.pipe(res)
    })
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()})
    req.on('aborted',()=>upstream.destroy())
    res.on('close',()=>upstream.destroy())
    req.pipe(upstream)
  })
  server.on('connect',rejectDetached)
  server.on('upgrade',rejectDetached)
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  proxyPort=server.address().port
  return {
    port:proxyPort,
    allowClientPid:clientGate.allow,
    close:()=>{
      clientGate.close()
      for(const socket of [...detachedSockets]){try{socket.destroy()}catch{}}
      detachedSockets.clear()
      agent.destroy()
      server.closeAllConnections()
      return new Promise(resolve=>server.close(resolve))
    },
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

export function createClientPidGate(getPort,verifyPeer=verifyLoopbackConnectionPeer,options={}){
  const {allowDescendants=false}=options
  const allowedTokens=new Map()
  const pendingPids=new Set()
  const attestedSockets=new WeakMap()
  const socketsByPid=new Map()
  const descendantEntries=new Map()
  let sweepTimer=null,sweeping=false
  const isAllowed=pid=>allowedTokens.has(pid)&&allowedTokens.get(pid).size>0&&pidAlive(pid)
  const stopSweepIfIdle=()=>{
    if(sweepTimer&&descendantEntries.size===0){clearInterval(sweepTimer);sweepTimer=null}
  }
  const destroyDescendant=peerPid=>{
    const entry=descendantEntries.get(peerPid)
    if(!entry)return
    descendantEntries.delete(peerPid)
    for(const socket of [...entry.sockets]){try{socket.destroy()}catch{}}
    stopSweepIfIdle()
  }
  const ensureSweep=()=>{
    if(!allowDescendants||sweepTimer||descendantEntries.size===0)return
    sweepTimer=setInterval(()=>{
      if(sweeping||descendantEntries.size===0)return
      sweeping=true
      void (async()=>{
        try{
          for(const [peerPid,entry] of [...descendantEntries.entries()]){
            if(!isAllowed(entry.rootPid)||!pidAlive(peerPid)){destroyDescendant(peerPid);continue}
            const info=await processIdentityOf(peerPid).catch(()=>null)
            if(!info||info.startId!==entry.startId)destroyDescendant(peerPid)
          }
        }finally{sweeping=false;stopSweepIfIdle()}
      })()
    },500)
    sweepTimer.unref?.()
  }
  const trackSocket=(rootPid,peerPid,startId,socket)=>{
    let set=socketsByPid.get(rootPid)
    if(!set){set=new Set();socketsByPid.set(rootPid,set)}
    set.add(socket)
    let descEntry=null
    if(allowDescendants&&peerPid!==rootPid){
      descEntry=descendantEntries.get(peerPid)
      if(descEntry&&descEntry.startId!==startId){destroyDescendant(peerPid);descEntry=null}
      if(!descEntry){descEntry={rootPid,startId,sockets:new Set()};descendantEntries.set(peerPid,descEntry)}
      descEntry.sockets.add(socket)
      ensureSweep()
    }
    socket.once('close',()=>{
      const current=socketsByPid.get(rootPid)
      if(current){current.delete(socket);if(current.size===0)socketsByPid.delete(rootPid)}
      if(descEntry){
        descEntry.sockets.delete(socket)
        if(descEntry.sockets.size===0){descendantEntries.delete(peerPid);stopSweepIfIdle()}
      }
    })
  }
  const destroyPidSockets=pid=>{
    const set=socketsByPid.get(pid)
    if(set){
      socketsByPid.delete(pid)
      for(const socket of [...set]){try{socket.destroy()}catch{}}
    }
    for(const [peerPid,entry] of [...descendantEntries.entries()]){
      if(entry.rootPid===pid)destroyDescendant(peerPid)
    }
  }
  const allow=(pidOrPromise,exitPromise)=>{
    const token=Symbol('relay-client')
    let revoked=false,resolvedPid=null
    const revoke=()=>{
      if(revoked)return
      revoked=true
      if(resolvedPid!==null){
        const tokens=allowedTokens.get(resolvedPid)
        if(tokens){
          tokens.delete(token)
          if(tokens.size===0){
            allowedTokens.delete(resolvedPid)
            destroyPidSockets(resolvedPid)
          }
        }
      }
    }
    const task=Promise.resolve(pidOrPromise).then(resolved=>{
      if(revoked||!Number.isSafeInteger(resolved)||resolved<=0)return
      resolvedPid=resolved
      let tokens=allowedTokens.get(resolved)
      if(!tokens){tokens=new Set();allowedTokens.set(resolved,tokens)}
      tokens.add(token)
    },()=>{})
    pendingPids.add(task)
    void task.finally(()=>pendingPids.delete(task))
    if(exitPromise)void Promise.resolve(exitPromise).finally(revoke)
    return Object.assign(task,{revoke})
  }
  const verify=async socket=>{
    if(socket.destroyed)return false
    const known=attestedSockets.get(socket)
    if(known!==undefined){
      const descValid=!allowDescendants||known.peerPid===known.rootPid
        ||descendantEntries.get(known.peerPid)?.startId===known.startId
      if(isAllowed(known.rootPid)&&pidAlive(known.peerPid)&&descValid)return true
      if(known.peerPid!==known.rootPid)destroyDescendant(known.peerPid)
      else destroyPidSockets(known.rootPid)
      socket.destroy()
      return false
    }
    if(pendingPids.size>0)await Promise.allSettled([...pendingPids])
    const localPort=getPort()
    const remotePort=socket.remotePort
    if(!localPort||!remotePort||!allowedTokens.size||socket.destroyed)return false
    for(let attempt=0;attempt<6;attempt++){
      if(socket.destroyed)return false
      const candidates=[...allowedTokens.keys()].filter(isAllowed)
      if(!candidates.length)return false
      if(allowDescendants&&verifyPeer===verifyLoopbackConnectionPeer){
        const peerPid=await resolveLoopbackPeerPid(localPort,remotePort).catch(()=>null)
        if(peerPid&&pidAlive(peerPid)){
          for(const rootPid of candidates){
            const startId=await isPidInOwnedTree(peerPid,rootPid)
            if(startId&&isAllowed(rootPid)&&!socket.destroyed){
              attestedSockets.set(socket,{rootPid,peerPid,startId})
              trackSocket(rootPid,peerPid,startId,socket)
              return true
            }
          }
        }
      }else{
        try{
          const matchedPid=await Promise.any(candidates.map(clientPid=>
            verifyPeer(localPort,remotePort,clientPid).then(()=>clientPid)))
          if(socket.destroyed||!isAllowed(matchedPid))return false
          attestedSockets.set(socket,{rootPid:matchedPid,peerPid:matchedPid,startId:null})
          trackSocket(matchedPid,matchedPid,null,socket)
          return true
        }catch{}
      }
      if(attempt<5&&!socket.destroyed)await new Promise(resolve=>setTimeout(resolve,20))
    }
    return false
  }
  const close=()=>{
    if(sweepTimer){clearInterval(sweepTimer);sweepTimer=null}
    for(const pid of [...allowedTokens.keys()]){
      allowedTokens.delete(pid)
      destroyPidSockets(pid)
    }
    for(const peerPid of [...descendantEntries.keys()])destroyDescendant(peerPid)
  }
  return {allow,verify,close}
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
  }=opts
  assert(Number.isSafeInteger(port)&&port>0&&port<=65535,'Invalid loopback port for TCP relay')
  assert(Number.isSafeInteger(pid)&&pid>0,'Invalid fixture PID for TCP relay')
  let closed=false,relayPort=0
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
      return verifyOwner(port,pid).then(()=>{
        if(closed||client.destroyed){client.destroy();return}
        upstream=net.createConnection({host:'127.0.0.1',port})
        sockets.add(upstream)
        upstream.once('close',()=>{sockets.delete(upstream);client.destroy()})
        upstream.once('error',teardown)
        upstream.once('connect',()=>{
          if(closed||client.destroyed||upstream.destroyed||!upstream.localPort){
            teardown();return
          }
          attestPeerWithRetry(upstream.localPort,port,pid,verifyPeer,()=>closed||client.destroyed||upstream.destroyed).then(()=>{
            if(closed||client.destroyed||upstream.destroyed){teardown();return}
            client.pipe(upstream)
            upstream.pipe(client)
            client.resume()
          },teardown)
        })
      })
    },teardown).catch(teardown)
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  relayPort=server.address().port
  return {
    port:relayPort,
    allowClientPid:clientGate.allow,
    close:()=>{
      closed=true
      clientGate.close()
      for(const s of [...sockets]){try{s.destroy()}catch{}}
      sockets.clear()
      return new Promise(resolve=>server.close(resolve))
    },
  }
}

export async function createAttestedRelay(targetOrigin,pid,options){
  const opts=typeof options==='function'?{onRequest:options}:(options??{})
  const {onRequest,expectAuthorization,injectAuthorization,requireClientAttestation=false}=opts
  const base=new URL(targetOrigin)
  assert(base.protocol==='http:'&&base.hostname==='127.0.0.1'&&base.port,'Expected a loopback HTTP target for attested relay')
  const agent=createAttestedHttpAgent(Number(base.port),pid)
  let relayPort=0
  const clientGate=createClientPidGate(()=>relayPort)
  const server=createServer(async(req,res)=>{
    const url=relayTarget(req,res,base.origin)
    if(!url)return
    if(requireClientAttestation){
      req.pause()
      const ok=await clientGate.verify(req.socket)
      if(res.destroyed||req.destroyed)return
      if(!ok){
        res.writeHead(403)
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
    const upstream=httpRequest(url,{agent,method:req.method,headers},response=>{
      if(response.statusCode>=300&&response.statusCode<400){
        response.destroy()
        if(!res.headersSent)res.writeHead(502)
        res.end('Upstream redirect forbidden in attested relay')
        return
      }
      res.writeHead(response.statusCode,response.headers)
      response.on('close',()=>{if(!response.complete)res.destroy()})
      response.on('error',()=>res.destroy())
      response.pipe(res)
    })
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()})
    req.on('aborted',()=>upstream.destroy())
    res.on('close',()=>upstream.destroy())
    req.pipe(upstream)
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  relayPort=server.address().port
  return {
    origin:`http://127.0.0.1:${relayPort}`,
    allowClientPid:clientGate.allow,
    close:()=>{clientGate.close();agent.destroy();server.closeAllConnections();return new Promise(resolve=>server.close(resolve))},
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
