import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {existsSync,lstatSync} from 'node:fs'
import {readdir,readFile,readlink,realpath} from 'node:fs/promises'
import path from 'node:path'
import {promisify} from 'node:util'

const execFileAsync=promisify(execFile)

const identityCache=new Map()
const inFlightIdentity=new Map()
let inFlightTable=null
let selfIdentityPromise=null

const system32Dir=()=>{
  const rawDrive=process.env.SystemDrive||'C:'
  assert(/^[A-Za-z]:$/.test(rawDrive),`Unexpected SystemDrive: ${rawDrive}`)
  const expectedRoot=`${rawDrive}\\Windows`
  const systemRoot=process.env.SystemRoot||process.env.WINDIR||expectedRoot
  assert(systemRoot.toLowerCase()===expectedRoot.toLowerCase(),`SystemRoot must match OS system drive Windows directory: ${systemRoot}`)
  assert(!lstatSync(systemRoot).isSymbolicLink(),`SystemRoot must not be a symbolic link: ${systemRoot}`)
  const system32=path.win32.join(systemRoot,'System32')
  assert(!lstatSync(system32).isSymbolicLink(),`System32 must not be a symbolic link: ${system32}`)
  return system32
}

const netstatBin=()=>{
  const candidate=path.win32.join(system32Dir(),'netstat.exe')
  assert(existsSync(candidate)&&!lstatSync(candidate).isSymbolicLink(),`Expected system netstat executable at ${candidate}`)
  return candidate
}

const powershellBin=()=>{
  try{
    const candidate=path.win32.join(system32Dir(),'WindowsPowerShell','v1.0','powershell.exe')
    if(!existsSync(candidate)||lstatSync(candidate).isSymbolicLink())return null
    return candidate
  }catch{return null}
}

const lsofBin=()=>{
  for(const candidate of ['/usr/sbin/lsof','/usr/bin/lsof']){
    if(existsSync(candidate))return candidate
  }
  throw Error('Expected system lsof executable at /usr/sbin/lsof or /usr/bin/lsof')
}

const psSystemBin=()=>['/bin/ps','/usr/bin/ps'].find(candidate=>existsSync(candidate))

export function pidAlive(pid){
  if(!Number.isSafeInteger(pid)||pid<=0)return false
  try{process.kill(pid,0);return true}catch(error){return error.code==='EPERM'}
}

async function queryOsIdentity(pid){
  if(process.platform==='linux'){
    try{
      const statText=await readFile(`/proc/${pid}/stat`,'utf8')
      const closeParen=statText.lastIndexOf(')')
      if(closeParen<0)return {status:pidAlive(pid)?'unknown':'dead',identity:null}
      const fields=statText.slice(closeParen+2).trim().split(/\s+/)
      const ppid=Number(fields[1])
      const startId=fields[19]
      if(!Number.isSafeInteger(ppid)||ppid<=0||!startId||!/^\d+$/.test(startId)){
        return {status:pidAlive(pid)?'unknown':'dead',identity:null}
      }
      return {status:'ok',identity:{ppid,startId,createdAt:BigInt(startId)}}
    }catch(error){
      if(error?.code==='ENOENT'||!pidAlive(pid))return {status:'dead',identity:null}
      return {status:'unknown',identity:null}
    }
  }
  if(process.platform==='win32'){
    const powershell=powershellBin()
    if(!powershell)return {status:'unknown',identity:null}
    try{
      const {stdout}=await execFileAsync(powershell,['-NoProfile','-NonInteractive','-Command',`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);try{$p=[Diagnostics.Process]::GetProcessById(${pid});[int64]($p.StartTime.ToUniversalTime().Ticks/10000)}catch{}`],{timeout:15000,windowsHide:true})
      const startId=stdout.trim()
      if(!startId||!/^\d+$/.test(startId)){
        return {status:pidAlive(pid)?'unknown':'dead',identity:null}
      }
      return {status:'ok',identity:{ppid:pid===process.pid?process.ppid:null,startId,createdAt:BigInt(startId)}}
    }catch{
      return {status:pidAlive(pid)?'unknown':'dead',identity:null}
    }
  }
  const psBin=psSystemBin()
  if(!psBin)return {status:'unknown',identity:null}
  try{
    const {stdout}=await execFileAsync(psBin,['-o','ppid=,lstart=','-p',String(pid)],{env:{LC_ALL:'C'},timeout:15000})
    const trimmed=stdout.trim()
    const match=/^(\d+)\s+(.+)$/.exec(trimmed)
    if(!match)return {status:pidAlive(pid)?'unknown':'dead',identity:null}
    const ppid=Number(match[1])
    const startId=match[2].trim()
    const parsed=Date.parse(startId)
    if(!Number.isSafeInteger(ppid)||ppid<=0||!startId||!Number.isFinite(parsed)){
      return {status:pidAlive(pid)?'unknown':'dead',identity:null}
    }
    return {status:'ok',identity:{ppid,startId,createdAt:BigInt(parsed)}}
  }catch{
    return {status:pidAlive(pid)?'unknown':'dead',identity:null}
  }
}

export async function probeProcessIdentity(pid,{refresh=false}={}){
  if(!Number.isSafeInteger(pid)||pid<=0||!pidAlive(pid)){
    identityCache.delete(pid)
    return {status:'dead',identity:null}
  }
  if(pid===process.pid){
    if(!selfIdentityPromise){
      selfIdentityPromise=queryOsIdentity(process.pid).then(res=>{
        if(res.status==='ok')return res
        selfIdentityPromise=null
        return res
      })
    }
    return selfIdentityPromise
  }
  if(!refresh&&identityCache.has(pid)){
    return {status:'ok',identity:identityCache.get(pid)}
  }
  const key=`${pid}:${refresh?1:0}`
  if(inFlightIdentity.has(key)){
    return inFlightIdentity.get(key)
  }
  const task=(async()=>{
    const res=await queryOsIdentity(pid)
    if(res.status==='ok'){
      if(identityCache.size>512)identityCache.clear()
      identityCache.set(pid,res.identity)
    }else if(res.status==='dead'){
      identityCache.delete(pid)
    }
    return res
  })()
  inFlightIdentity.set(key,task)
  try{return await task}finally{inFlightIdentity.delete(key)}
}

export async function processIdentityOf(pid,{refresh=false}={}){
  const res=await probeProcessIdentity(pid,{refresh})
  return res.status==='ok'?res.identity:null
}

export function parseWindowsCommandLine(raw){
  if(typeof raw!=='string')return []
  const args=[]
  let i=0
  const len=raw.length
  while(i<len){
    while(i<len&&(raw[i]===' '||raw[i]==='\t'))i++
    if(i>=len)break
    let current='',inQuotes=false
    while(i<len){
      if(!inQuotes&&(raw[i]===' '||raw[i]==='\t'))break
      let backslashes=0
      while(i<len&&raw[i]==='\\'){backslashes++;i++}
      if(i<len&&raw[i]==='"'){
        current+='\\'.repeat(Math.floor(backslashes/2))
        if(backslashes%2===1){
          current+='"'
          i++
        }else if(inQuotes&&i+1<len&&raw[i+1]==='"'){
          current+='"'
          i+=2
        }else{
          inQuotes=!inQuotes
          i++
        }
      }else{
        current+='\\'.repeat(backslashes)
        if(i<len){
          if(!inQuotes&&(raw[i]===' '||raw[i]==='\t'))break
          current+=raw[i]
          i++
        }
      }
    }
    args.push(current)
  }
  return args
}

function parsePosixCommandLine(raw){
  if(typeof raw!=='string')return []
  const args=[]
  let i=0,len=raw.length
  while(i<len){
    while(i<len&&(raw[i]===' '||raw[i]==='\t'))i++
    if(i>=len)break
    let current='',quote=null
    while(i<len){
      const ch=raw[i]
      if(quote){
        if(ch===quote){quote=null;i++;continue}
        if(quote==='"'&&ch==='\\'&&i+1<len){current+=raw[i+1];i+=2;continue}
        current+=ch;i++
      }else{
        if(ch===' '||ch==='\t')break
        if(ch==='"'||ch==="'"){quote=ch;i++;continue}
        if(ch==='\\'&&i+1<len){current+=raw[i+1];i+=2;continue}
        current+=ch;i++
      }
    }
    args.push(current)
  }
  return args
}

async function processTableSnapshot(){
  if(inFlightTable)return inFlightTable
  const task=(async()=>{
    if(process.platform==='win32'){
      const powershell=powershellBin()
      if(!powershell)return null
      try{
        const {stdout}=await execFileAsync(powershell,['-NoProfile','-NonInteractive','-Command','[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { "$($_.ProcessId)|$($_.ParentProcessId)|$([int64]($_.CreationDate.ToUniversalTime().Ticks/10000))|$($_.CommandLine -replace \'[\\r\\n]+\',\' \')" } }'],{timeout:15000,windowsHide:true,maxBuffer:16*1024*1024})
        const table=new Map()
        for(const line of stdout.split(/\r?\n/)){
          const first=line.indexOf('|')
          if(first<0)continue
          const second=line.indexOf('|',first+1)
          if(second<0)continue
          const third=line.indexOf('|',second+1)
          if(third<0)continue
          const pid=Number(line.slice(0,first).trim())
          const ppid=Number(line.slice(first+1,second).trim())
          const startId=line.slice(second+1,third).trim()
          const commandLine=line.slice(third+1)
          if(Number.isSafeInteger(pid)&&pid>0&&Number.isSafeInteger(ppid)&&ppid>=0&&startId&&/^\d+$/.test(startId)){
            table.set(pid,{ppid,startId,createdAt:BigInt(startId),commandLine})
          }
        }
        return table.size>0?table:null
      }catch{return null}
    }
    const psBin=psSystemBin()
    if(!psBin)return null
    try{
      const {stdout}=await execFileAsync(psBin,['-ax','-o','pid=,ppid=,lstart='],{env:{LC_ALL:'C'},timeout:8000,maxBuffer:8*1024*1024})
      const table=new Map()
      for(const line of stdout.split(/\r?\n/)){
        const match=/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
        if(!match)continue
        const pid=Number(match[1]),ppid=Number(match[2]),startId=match[3].trim()
        const parsed=Date.parse(startId)
        if(Number.isSafeInteger(pid)&&pid>0&&Number.isSafeInteger(ppid)&&ppid>=0&&startId&&Number.isFinite(parsed)){
          table.set(pid,{ppid,startId,createdAt:BigInt(parsed)})
        }
      }
      return table.size>0?table:null
    }catch{return null}
  })()
  inFlightTable=task
  try{return await task}finally{if(inFlightTable===task)inFlightTable=null}
}

export async function isPidInOwnedTree(peerPid,rootPid,expectedRootStartId,maxDepth=8){
  if(!Number.isSafeInteger(peerPid)||peerPid<=0||!Number.isSafeInteger(rootPid)||rootPid<=0)return null
  if(peerPid===rootPid){
    const peerInfo=await processIdentityOf(peerPid,{refresh:true})
    if(!peerInfo)return null
    if(expectedRootStartId&&peerInfo.startId!==expectedRootStartId)return null
    return peerInfo.startId
  }
  let lookup
  if(process.platform==='linux'){
    lookup=pid=>processIdentityOf(pid,{refresh:true})
  }else{
    const table=await processTableSnapshot()
    if(!table)return null
    lookup=pid=>Promise.resolve(table.get(pid)??null)
  }
  const peerInfo=await lookup(peerPid)
  if(!peerInfo)return null
  const visited=new Set([peerPid])
  let childInfo=peerInfo
  for(let depth=0;depth<maxDepth;depth++){
    const parentPid=childInfo.ppid
    if(!Number.isSafeInteger(parentPid)||parentPid<=1||visited.has(parentPid))return null
    const parentInfo=await lookup(parentPid)
    if(!parentInfo)return null
    // A dead parent PID recycled to a newer process starts after its supposed child.
    if(parentInfo.createdAt>childInfo.createdAt)return null
    if(parentPid===rootPid){
      if(expectedRootStartId&&parentInfo.startId!==expectedRootStartId)return null
      return peerInfo.startId
    }
    visited.add(parentPid)
    childInfo=parentInfo
  }
  return null
}

async function processArgsOf(pid,table){
  if(process.platform==='linux'){
    try{
      const raw=await readFile(`/proc/${pid}/cmdline`,'utf8')
      const parts=raw.split('\0')
      while(parts.length&&parts.at(-1)==='')parts.pop()
      return parts.length?parts:null
    }catch{return null}
  }
  if(process.platform==='win32'){
    const snap=table??await processTableSnapshot()
    const entry=snap?.get(pid)
    if(typeof entry?.commandLine!=='string'||!entry.commandLine.trim())return null
    return parseWindowsCommandLine(entry.commandLine)
  }
  const psBin=psSystemBin()
  if(!psBin)return null
  try{
    const {stdout}=await execFileAsync(psBin,['-ww','-o','command=','-p',String(pid)],{env:{LC_ALL:'C'},timeout:8000})
    const trimmed=stdout.trim()
    return trimmed?parsePosixCommandLine(trimmed):null
  }catch{return null}
}

async function resolveCanonicalMaybeMissing(candidate){
  if(typeof candidate!=='string'||!candidate||!path.isAbsolute(candidate))return null
  try{return await realpath(candidate)}catch{}
  const pending=[]
  let current=path.resolve(candidate)
  while(true){
    const parent=path.dirname(current)
    if(parent===current)return null
    pending.unshift(path.basename(current))
    current=parent
    try{
      const base=await realpath(current)
      return path.join(base,...pending)
    }catch{}
  }
}

const normPath=value=>process.platform==='win32'?path.win32.normalize(value).toLowerCase():path.posix.normalize(value)

function isPathStrictlyInside(parentReal,childReal){
  const parent=normPath(parentReal),child=normPath(childReal)
  const rel=path.relative(parent,child)
  return Boolean(rel)&&rel!=='.'&&rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel)
}

function flagValue(args,flag){
  for(let i=1;i<args.length;i++){
    if(args[i]===flag&&i+1<args.length)return args[i+1]
    if(args[i].startsWith(`${flag}=`))return args[i].slice(flag.length+1)
  }
  return null
}

export async function verifyPrivateFixtureServer({targetPid,launcherPid,profile,root,maxDepth=2,allowedLaunchers}){
  assert(Number.isSafeInteger(targetPid)&&targetPid>0,'Private fixture target PID required')
  assert(Number.isSafeInteger(launcherPid)&&launcherPid>0,'Private fixture launcher PID required')
  assert(typeof profile==='string'&&profile.length>0,'Private fixture profile path required')
  const profileReal=await realpath(profile)
  const table=process.platform==='linux'?null:await processTableSnapshot()
  const lookup=process.platform==='linux'?pid=>processIdentityOf(pid,{refresh:true}):pid=>Promise.resolve(table?.get(pid)??null)
  const inTree=async(peerPid)=>{
    const peerInfo=await lookup(peerPid)
    if(!peerInfo)return null
    if(peerPid===launcherPid)return peerInfo.startId
    const visited=new Set([peerPid])
    let childInfo=peerInfo
    for(let depth=0;depth<maxDepth;depth++){
      const parentPid=childInfo.ppid
      if(!Number.isSafeInteger(parentPid)||parentPid<=1||visited.has(parentPid))return null
      const parentInfo=await lookup(parentPid)
      if(!parentInfo)return null
      if(parentInfo.createdAt>childInfo.createdAt)return null
      if(parentPid===launcherPid)return peerInfo.startId
      visited.add(parentPid)
      childInfo=parentInfo
    }
    return null
  }
  assert(await inTree(process.pid),`Fixture runner PID ${process.pid} is not a direct descendant of launcher PID ${launcherPid}`)
  const targetStartId=await inTree(targetPid)
  assert(targetStartId,`Target server PID ${targetPid} was not launched by private fixture launcher PID ${launcherPid}`)

  if(root||allowedLaunchers){
    const launcherArgs=await processArgsOf(launcherPid,table)
    assert(launcherArgs&&launcherArgs.length>=2,`Unable to inspect launcher PID ${launcherPid} arguments`)
    const execReal=await realpath(process.execPath)
    const launcherExe=await resolveCanonicalMaybeMissing(launcherArgs[0])
    assert(launcherExe&&normPath(launcherExe)===normPath(execReal),`Launcher PID ${launcherPid} is not the expected Node runtime`)
    const expectedScripts=new Set()
    if(Array.isArray(allowedLaunchers)){
      for(const script of allowedLaunchers){
        const resolved=await resolveCanonicalMaybeMissing(script)
        if(resolved)expectedScripts.add(normPath(resolved))
      }
    }else{
      const rootReal=await realpath(root)
      for(const rel of ['packages/rune-app/fixtures/launcher-fixture.mjs','scripts/rune/web-fixture.mjs']){
        const resolved=await resolveCanonicalMaybeMissing(path.join(rootReal,rel))
        if(resolved)expectedScripts.add(normPath(resolved))
      }
    }
    let matchedLauncher=false
    for(const arg of launcherArgs.slice(1)){
      const resolved=await resolveCanonicalMaybeMissing(arg)
      if(resolved&&expectedScripts.has(normPath(resolved))){matchedLauncher=true;break}
    }
    assert(matchedLauncher,`Launcher PID ${launcherPid} is not an authorized private fixture launcher script`)
  }

  const targetArgs=await processArgsOf(targetPid,table)
  assert(targetArgs&&targetArgs.length>=2,`Unable to inspect OS arguments of target server PID ${targetPid}`)

  // Contract 1: fixture-server positional args [<profile>/projects, <profile>/identity.json, ...]
  let confined=false
  if(targetArgs.length>=5){
    const arg1=await resolveCanonicalMaybeMissing(targetArgs[1])
    const arg2=await resolveCanonicalMaybeMissing(targetArgs[2])
    const expectedProjects=normPath(path.join(profileReal,'projects'))
    const expectedIdentity=normPath(path.join(profileReal,'identity.json'))
    if(arg1&&arg2&&normPath(arg1)===expectedProjects&&normPath(arg2)===expectedIdentity){
      confined=true
    }
  }
  // Contract 2: Rust `serve` or TS server with explicit --config and --workspace-root inside profileReal
  if(!confined){
    const cfgRaw=flagValue(targetArgs,'--config')
    const wsRaw=flagValue(targetArgs,'--workspace-root')
    if(cfgRaw&&wsRaw){
      const cfgReal=await resolveCanonicalMaybeMissing(cfgRaw)
      const wsReal=await resolveCanonicalMaybeMissing(wsRaw)
      if(cfgReal&&wsReal&&isPathStrictlyInside(profileReal,cfgReal)&&isPathStrictlyInside(profileReal,wsReal)){
        confined=true
      }
    }
  }
  assert(confined,`Target server PID ${targetPid} arguments are not canonically confined to private fixture profile ${profileReal}`)
  return {targetPid,targetStartId}
}

export async function resolveLoopbackListenerPid(port){
  assert(Number.isSafeInteger(port)&&port>0&&port<=65535,'Invalid loopback port')
  if(process.platform==='win32'){
    const {stdout}=await execFileAsync(netstatBin(),['-ano','-p','tcp'],{timeout:10000,windowsHide:true,maxBuffer:8*1024*1024})
    const owners=new Set()
    for(const line of stdout.split(/\r?\n/)){
      const match=/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+0\.0\.0\.0:0\s+\S+\s+(\d+)\s*$/i.exec(line)
      if(match&&Number(match[1])===port)owners.add(Number(match[2]))
    }
    assert.equal(owners.size,1,`Loopback port 127.0.0.1:${port} must have a single listening owner`)
    return [...owners][0]
  }
  if(process.platform==='linux'){
    const target=`0100007F:${port.toString(16).toUpperCase().padStart(4,'0')}`
    const table=await readFile('/proc/net/tcp','utf8')
    const inodes=new Set()
    for(const line of table.split('\n').slice(1)){
      const cols=line.trim().split(/\s+/)
      if(cols[1]===target&&cols[3]==='0A'&&cols[9])inodes.add(`socket:[${cols[9]}]`)
    }
    assert.equal(inodes.size,1,`Loopback port 127.0.0.1:${port} must have a single listening socket`)
    const [inode]=inodes
    const entries=await readdir('/proc').catch(()=>[])
    for(const entry of entries){
      if(!/^\d+$/.test(entry))continue
      const fds=await readdir(`/proc/${entry}/fd`).catch(()=>[])
      for(const fd of fds){
        try{if(await readlink(`/proc/${entry}/fd/${fd}`)===inode)return Number(entry)}catch{}
      }
    }
    throw Error(`Unable to resolve listening PID for 127.0.0.1:${port}`)
  }
  const {stdout}=await execFileAsync(lsofBin(),['-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-Fpn'],{timeout:10000})
  const owners=new Set()
  let currentPid=null
  for(const line of stdout.split(/\r?\n/)){
    if(line.startsWith('p'))currentPid=Number(line.slice(1))
    else if(line.startsWith('n')&&line.slice(1)===`127.0.0.1:${port}`&&Number.isSafeInteger(currentPid))owners.add(currentPid)
  }
  assert.equal(owners.size,1,`Loopback port 127.0.0.1:${port} must have a single listening owner`)
  return [...owners][0]
}

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

export async function attestPeerWithRetry(localPort,remotePort,pid,checkPeer,isClosed){
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

export async function resolveLoopbackPeerPid(localPort,remotePort){
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

function isLoopbackIpv4Address(addr){
  return addr==='127.0.0.1'||addr==='::ffff:127.0.0.1'
}

export function createClientPidGate(getPort,verifyPeer=verifyLoopbackConnectionPeer,options={}){
  const {
    allowDescendants=false,
    probeIdentity=probeProcessIdentity,
    maxUnknownStrikes=process.platform==='linux'?5:3,
  }=options
  const allowedEntries=new Map()
  const pendingPids=new Set()
  const attestedSockets=new WeakMap()
  const descendantEntries=new Map()
  let sweepTimer=null,sweeping=false,sweepTick=0,closed=false
  const isEntryLive=(pid,entry)=>Boolean(!closed&&entry&&allowedEntries.get(pid)===entry&&entry.tokens.size>0&&entry.startId&&pidAlive(pid))
  const isAllowed=pid=>isEntryLive(pid,allowedEntries.get(pid))
  const hasTrackedSockets=()=>{
    for(const entry of allowedEntries.values()){if(entry.sockets.size>0)return true}
    return descendantEntries.size>0
  }
  const stopSweepIfIdle=()=>{
    if(sweepTimer&&!hasTrackedSockets()){clearInterval(sweepTimer);sweepTimer=null}
  }
  const destroyDescendantEntry=(peerPid,descEntry)=>{
    if(descendantEntries.get(peerPid)===descEntry)descendantEntries.delete(peerPid)
    for(const socket of [...descEntry.sockets]){try{socket.destroy()}catch{}}
    descEntry.sockets.clear()
    stopSweepIfIdle()
  }
  const destroyRootEntry=(rootPid,entry)=>{
    if(allowedEntries.get(rootPid)===entry)allowedEntries.delete(rootPid)
    for(const socket of [...entry.sockets]){try{socket.destroy()}catch{}}
    entry.sockets.clear()
    for(const [peerPid,descEntry] of [...descendantEntries.entries()]){
      if(descEntry.rootPid===rootPid&&descEntry.rootEntryId===entry.id){
        destroyDescendantEntry(peerPid,descEntry)
      }
    }
    stopSweepIfIdle()
  }
  const ensureSweep=()=>{
    if(sweepTimer||!hasTrackedSockets())return
    sweepTimer=setInterval(()=>{
      if(sweeping||!hasTrackedSockets())return
      sweeping=true
      sweepTick++
      const refreshIdentity=process.platform==='linux'||probeIdentity!==probeProcessIdentity||(sweepTick%4===0)
      void (async()=>{
        try{
          for(const [rootPid,entry] of [...allowedEntries.entries()]){
            if(entry.sockets.size===0)continue
            if(!isEntryLive(rootPid,entry)){
              identityCache.delete(rootPid);destroyRootEntry(rootPid,entry);continue
            }
            if(refreshIdentity){
              const res=await probeIdentity(rootPid,{refresh:true}).catch(()=>({status:'unknown',identity:null}))
              if(allowedEntries.get(rootPid)!==entry)continue
              if(res.status==='dead'||(res.status==='ok'&&res.identity.startId!==entry.startId)){
                destroyRootEntry(rootPid,entry);continue
              }
              if(res.status==='unknown'){
                entry.unknownStrikes++
                if(entry.unknownStrikes>=maxUnknownStrikes){
                  destroyRootEntry(rootPid,entry);continue
                }
              }else{
                entry.unknownStrikes=0
              }
            }
          }
          for(const [peerPid,descEntry] of [...descendantEntries.entries()]){
            const rootEntry=allowedEntries.get(descEntry.rootPid)
            if(!rootEntry||rootEntry.id!==descEntry.rootEntryId||!isEntryLive(descEntry.rootPid,rootEntry)||!pidAlive(peerPid)){
              identityCache.delete(peerPid);destroyDescendantEntry(peerPid,descEntry);continue
            }
            if(refreshIdentity){
              const peerRes=await probeIdentity(peerPid,{refresh:true}).catch(()=>({status:'unknown',identity:null}))
              if(descendantEntries.get(peerPid)!==descEntry)continue
              if(peerRes.status==='dead'||(peerRes.status==='ok'&&peerRes.identity.startId!==descEntry.startId)){
                destroyDescendantEntry(peerPid,descEntry);continue
              }
              if(peerRes.status==='unknown'){
                descEntry.unknownStrikes++
                if(descEntry.unknownStrikes>=maxUnknownStrikes){
                  destroyDescendantEntry(peerPid,descEntry);continue
                }
              }else{
                descEntry.unknownStrikes=0
                if(sweepTick%4===0){
                  const stillDesc=await isPidInOwnedTree(peerPid,descEntry.rootPid,rootEntry.startId).catch(()=>null)
                  if(descendantEntries.get(peerPid)===descEntry&&stillDesc!==descEntry.startId){
                    destroyDescendantEntry(peerPid,descEntry)
                  }
                }
              }
            }
          }
        }finally{sweeping=false;stopSweepIfIdle()}
      })()
    },500)
    sweepTimer.unref?.()
  }
  const trackSocket=(rootPid,rootEntry,peerPid,startId,socket)=>{
    rootEntry.sockets.add(socket)
    let descEntry=null
    if(allowDescendants&&peerPid!==rootPid){
      descEntry=descendantEntries.get(peerPid)
      if(descEntry&&(descEntry.startId!==startId||descEntry.rootEntryId!==rootEntry.id)){
        destroyDescendantEntry(peerPid,descEntry)
        descEntry=null
      }
      if(!descEntry){
        descEntry={id:Symbol('desc'),rootPid,rootEntryId:rootEntry.id,startId,unknownStrikes:0,sockets:new Set()}
        descendantEntries.set(peerPid,descEntry)
      }
      descEntry.sockets.add(socket)
    }
    ensureSweep()
    socket.once('close',()=>{
      rootEntry.sockets.delete(socket)
      if(descEntry){
        descEntry.sockets.delete(socket)
        if(descEntry.sockets.size===0&&descendantEntries.get(peerPid)===descEntry){
          descendantEntries.delete(peerPid)
        }
      }
      stopSweepIfIdle()
    })
    return descEntry
  }
  const allow=(pidOrPromise,exitPromise)=>{
    const token=Symbol('relay-client')
    let revoked=false,resolvedPid=null,boundEntry=null
    const revoke=()=>{
      if(revoked)return
      revoked=true
      if(resolvedPid!==null&&boundEntry){
        boundEntry.tokens.delete(token)
        if(boundEntry.tokens.size===0){
          destroyRootEntry(resolvedPid,boundEntry)
        }
      }
    }
    const task=Promise.resolve(pidOrPromise).then(async resolved=>{
      if(closed||revoked||!Number.isSafeInteger(resolved)||resolved<=0)return
      let info=null
      for(let attempt=0;attempt<3;attempt++){
        const res=await probeIdentity(resolved,{refresh:true}).catch(()=>({status:'unknown',identity:null}))
        if(res.status==='ok'){info=res.identity;break}
        if(res.status==='dead'||closed||revoked)return
        if(attempt<2)await new Promise(resolve=>setTimeout(resolve,100))
      }
      if(closed||revoked||!info?.startId||!pidAlive(resolved))return
      resolvedPid=resolved
      let entry=allowedEntries.get(resolved)
      if(entry&&entry.startId!==info.startId){
        destroyRootEntry(resolved,entry)
        entry=null
      }
      if(!entry){
        entry={id:Symbol('entry'),tokens:new Set(),startId:info.startId,unknownStrikes:0,sockets:new Set()}
        allowedEntries.set(resolved,entry)
      }
      boundEntry=entry
      entry.tokens.add(token)
    },()=>{})
    pendingPids.add(task)
    const done=()=>pendingPids.delete(task)
    task.then(done,done)
    if(exitPromise){
      const onExit=()=>{revoke()}
      Promise.resolve(exitPromise).then(onExit,onExit)
    }
    return Object.assign(task,{revoke})
  }
  const verify=async socket=>{
    if(closed||socket.destroyed)return false
    if(!isLoopbackIpv4Address(socket.localAddress)||!isLoopbackIpv4Address(socket.remoteAddress))return false
    const known=attestedSockets.get(socket)
    if(known!==undefined){
      const rootEntry=allowedEntries.get(known.rootPid)
      const rootValid=Boolean(rootEntry&&rootEntry.id===known.rootEntryId&&isEntryLive(known.rootPid,rootEntry)&&rootEntry.startId===known.rootStartId)
      const descValid=!allowDescendants||known.peerPid===known.rootPid
        ||descendantEntries.get(known.peerPid)?.id===known.descEntryId
      if(rootValid&&pidAlive(known.peerPid)&&descValid)return true
      if(known.peerPid!==known.rootPid){
        const d=descendantEntries.get(known.peerPid)
        if(d&&d.id===known.descEntryId)destroyDescendantEntry(known.peerPid,d)
      }else if(rootEntry&&rootEntry.id===known.rootEntryId){
        destroyRootEntry(known.rootPid,rootEntry)
      }
      socket.destroy()
      return false
    }
    if(pendingPids.size>0)await Promise.allSettled([...pendingPids])
    const localPort=getPort()
    const remotePort=socket.remotePort
    if(closed||!localPort||!remotePort||!allowedEntries.size||socket.destroyed)return false
    for(let attempt=0;attempt<6;attempt++){
      if(closed||socket.destroyed)return false
      const candidates=[...allowedEntries.entries()].filter(([pid,entry])=>isEntryLive(pid,entry))
      if(!candidates.length)return false
      if(allowDescendants&&verifyPeer===verifyLoopbackConnectionPeer){
        const peerPid=await resolveLoopbackPeerPid(localPort,remotePort).catch(()=>null)
        if(closed||socket.destroyed)return false
        if(peerPid&&pidAlive(peerPid)){
          for(const [rootPid,rootEntry] of candidates){
            if(!isEntryLive(rootPid,rootEntry))continue
            // Always verify fresh OS incarnation on new socket admission so recycled PIDs cannot reuse cache.
            const rootRes=await probeIdentity(rootPid,{refresh:true}).catch(()=>({status:'unknown',identity:null}))
            if(closed||socket.destroyed)return false
            if(allowedEntries.get(rootPid)!==rootEntry)continue
            if(rootRes.status==='dead'||(rootRes.status==='ok'&&rootRes.identity.startId!==rootEntry.startId)){
              destroyRootEntry(rootPid,rootEntry);continue
            }
            if(rootRes.status==='unknown')continue
            const startId=await isPidInOwnedTree(peerPid,rootPid,rootEntry.startId)
            if(closed||socket.destroyed)return false
            if(startId&&isEntryLive(rootPid,rootEntry)){
              if(peerPid===rootPid&&rootEntry.startId!==startId)continue
              const descEntry=trackSocket(rootPid,rootEntry,peerPid,startId,socket)
              attestedSockets.set(socket,{
                rootPid,
                rootEntryId:rootEntry.id,
                rootStartId:rootEntry.startId,
                peerPid,
                startId,
                descEntryId:descEntry?.id??null,
              })
              return true
            }
          }
        }
      }else{
        try{
          const matched=await Promise.any(candidates.map(([clientPid,entry])=>
            verifyPeer(localPort,remotePort,clientPid).then(()=>({clientPid,entry}))))
          if(closed||socket.destroyed||!isEntryLive(matched.clientPid,matched.entry))return false
          // Always verify fresh OS incarnation on new socket admission.
          const res=await probeIdentity(matched.clientPid,{refresh:true}).catch(()=>({status:'unknown',identity:null}))
          if(closed||socket.destroyed)return false
          if(allowedEntries.get(matched.clientPid)!==matched.entry)return false
          if(res.status==='dead'||(res.status==='ok'&&res.identity.startId!==matched.entry.startId)){
            destroyRootEntry(matched.clientPid,matched.entry);return false
          }
          if(res.status==='unknown'||!isEntryLive(matched.clientPid,matched.entry))return false
          trackSocket(matched.clientPid,matched.entry,matched.clientPid,matched.entry.startId,socket)
          attestedSockets.set(socket,{
            rootPid:matched.clientPid,
            rootEntryId:matched.entry.id,
            rootStartId:matched.entry.startId,
            peerPid:matched.clientPid,
            startId:matched.entry.startId,
            descEntryId:null,
          })
          return true
        }catch{}
      }
      if(attempt<5&&!closed&&!socket.destroyed)await new Promise(resolve=>setTimeout(resolve,20))
    }
    return false
  }
  const close=()=>{
    closed=true
    if(sweepTimer){clearInterval(sweepTimer);sweepTimer=null}
    for(const [pid,entry] of [...allowedEntries.entries()])destroyRootEntry(pid,entry)
    for(const [peerPid,descEntry] of [...descendantEntries.entries()])destroyDescendantEntry(peerPid,descEntry)
    allowedEntries.clear()
    descendantEntries.clear()
  }
  return {allow,verify,close}
}
