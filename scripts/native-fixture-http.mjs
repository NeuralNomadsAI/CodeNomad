import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {existsSync,realpathSync} from 'node:fs'
import {readdir,readFile,readlink} from 'node:fs/promises'
import {Agent as HttpAgent,createServer,request as httpRequest} from 'node:http'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
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
  const resolvedUrl=import.meta.resolve(specifier)
  assert(resolvedUrl.startsWith('file://'),`Dependency ${specifier} must resolve to a local file`)
  const resolvedPath=realpathSync(fileURLToPath(resolvedUrl))
  assert(isWithin(rootReal,resolvedPath)&&resolvedPath!==rootReal,
    `Dependency ${specifier} resolved outside worktree node_modules: ${resolvedPath}`)
  return resolvedUrl
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
    const fds=await readdir(`/proc/${pid}/fd`)
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

export async function originGuardProxy(localOrigin){
  const server=createServer((req,res)=>{
    let target
    try{target=new URL(req.url,localOrigin)}catch{res.writeHead(403);res.end();return}
    if(target.origin!==localOrigin){res.writeHead(403);res.end('Foreign browser origin forbidden');return}
    const headers={...req.headers}
    delete headers['proxy-connection']
    const upstream=httpRequest(target,{agent:fixtureHttpAgent,method:req.method,headers:{...headers,host:target.host}},response=>{
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
    close:()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve))},
  }
}

export function createAttestedFetch(origin,port,pid,verifyOwner=verifyLoopbackListenerOwner){
  const connector=buildConnector({})
  const pool=new Pool(origin,{
    connections:8,
    keepAliveTimeout:60_000,
    connect(opts,cb){
      verifyOwner(port,pid).then(()=>{
        connector(opts,(error,socket)=>{
          if(error||!socket){cb(error??Error('Socket connection failed'),null);return}
          verifyOwner(port,pid).then(()=>cb(null,socket),postError=>{
            try{socket.destroy()}catch{}
            cb(postError,null)
          })
        })
      },error=>cb(error,null))
    },
  })
  const fetchBound=(input,init={})=>{
    if(input instanceof Request){
      const {url,method,headers,body,signal}=input
      return fetchBound(url,{method,headers,body,signal,...init})
    }
    return undiciFetch(input,{...init,duplex:'half',dispatcher:pool,redirect:'error'})
  }
  fetchBound.close=()=>pool.destroy().catch(()=>{})
  return fetchBound
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
