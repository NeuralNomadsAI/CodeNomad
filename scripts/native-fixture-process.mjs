import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {existsSync,lstatSync} from 'node:fs'
import {readdir,readFile,readlink,realpath} from 'node:fs/promises'
import path from 'node:path'
import {promisify} from 'node:util'

const execFileAsync=promisify(execFile)

const SELF_STARTED_MS=Math.floor(Date.now()-process.uptime()*1000)
const SELF_START_ID=`self-${process.pid}-${SELF_STARTED_MS}`
const WINDOWS_EPOCH_OFFSET_MS=62135596800000n
const SELF_CREATED_AT=process.platform==='win32'
  ?BigInt(SELF_STARTED_MS-2000)+WINDOWS_EPOCH_OFFSET_MS
  :BigInt(SELF_STARTED_MS-2000)

const identityCache=new Map()
const inFlightIdentity=new Map()

const system32Dir=()=>{
  const systemRoot=process.env.SystemRoot||process.env.WINDIR||'C:\\Windows'
  assert(/^[A-Za-z]:\\Windows$/i.test(systemRoot),`Unexpected SystemRoot: ${systemRoot}`)
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
  const candidate=path.win32.join(system32Dir(),'WindowsPowerShell','v1.0','powershell.exe')
  if(!existsSync(candidate)||lstatSync(candidate).isSymbolicLink())return null
  return candidate
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

export async function probeProcessIdentity(pid,{refresh=false}={}){
  if(!Number.isSafeInteger(pid)||pid<=0||!pidAlive(pid)){
    identityCache.delete(pid)
    return {status:'dead',identity:null}
  }
  if(pid===process.pid){
    return {status:'ok',identity:{ppid:process.ppid,startId:SELF_START_ID,createdAt:SELF_CREATED_AT}}
  }
  if(!refresh&&identityCache.has(pid)){
    return {status:'ok',identity:identityCache.get(pid)}
  }
  if(inFlightIdentity.has(pid)){
    return inFlightIdentity.get(pid)
  }
  const task=(async()=>{
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
        const identity={ppid,startId,createdAt:BigInt(startId)}
        identityCache.set(pid,identity)
        return {status:'ok',identity}
      }catch(error){
        if(error?.code==='ENOENT'||!pidAlive(pid)){
          identityCache.delete(pid)
          return {status:'dead',identity:null}
        }
        return {status:'unknown',identity:null}
      }
    }
    if(process.platform==='win32'){
      const powershell=powershellBin()
      if(!powershell)return {status:'unknown',identity:null}
      try{
        // Query Win32 process start time directly via .NET Process (no WMI/CIM overhead).
        const {stdout}=await execFileAsync(powershell,['-NoProfile','-NonInteractive','-Command',`try{$p=[Diagnostics.Process]::GetProcessById(${pid});[int64]($p.StartTime.ToUniversalTime().Ticks/10000)}catch{}`],{timeout:15000,windowsHide:true})
        const startId=stdout.trim()
        if(!startId||!/^\d+$/.test(startId)){
          if(!pidAlive(pid)){identityCache.delete(pid);return {status:'dead',identity:null}}
          return {status:'unknown',identity:null}
        }
        const identity={ppid:null,startId,createdAt:BigInt(startId)}
        identityCache.set(pid,identity)
        return {status:'ok',identity}
      }catch{
        if(!pidAlive(pid)){identityCache.delete(pid);return {status:'dead',identity:null}}
        return {status:'unknown',identity:null}
      }
    }
    const psBin=psSystemBin()
    if(!psBin)return {status:'unknown',identity:null}
    try{
      const {stdout}=await execFileAsync(psBin,['-o','ppid=,lstart=','-p',String(pid)],{env:{LC_ALL:'C'},timeout:15000})
      const trimmed=stdout.trim()
      const match=/^(\d+)\s+(.+)$/.exec(trimmed)
      if(!match){
        if(!pidAlive(pid)){identityCache.delete(pid);return {status:'dead',identity:null}}
        return {status:'unknown',identity:null}
      }
      const ppid=Number(match[1])
      const startId=match[2].trim()
      const parsed=Date.parse(startId)
      if(!Number.isSafeInteger(ppid)||ppid<=0||!startId||!Number.isFinite(parsed)){
        return {status:pidAlive(pid)?'unknown':'dead',identity:null}
      }
      const identity={ppid,startId,createdAt:BigInt(parsed)}
      identityCache.set(pid,identity)
      return {status:'ok',identity}
    }catch{
      if(!pidAlive(pid)){identityCache.delete(pid);return {status:'dead',identity:null}}
      return {status:'unknown',identity:null}
    }
  })()
  inFlightIdentity.set(pid,task)
  try{return await task}finally{inFlightIdentity.delete(pid)}
}

export async function processIdentityOf(pid,{refresh=false}={}){
  const res=await probeProcessIdentity(pid,{refresh})
  return res.status==='ok'?res.identity:null
}

let inFlightTable=null

async function processTableSnapshot(){
  if(inFlightTable)return inFlightTable
  const task=(async()=>{
    if(process.platform==='win32'){
      const powershell=powershellBin()
      if(!powershell)return null
      try{
        const {stdout}=await execFileAsync(powershell,['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { "$($_.ProcessId)|$($_.ParentProcessId)|$([int64]($_.CreationDate.ToUniversalTime().Ticks/10000))|$($_.CommandLine -replace \'[\\r\\n]+\',\' \')" } }'],{timeout:15000,windowsHide:true,maxBuffer:16*1024*1024})
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
    const peerInfo=await processIdentityOf(peerPid)
    if(!peerInfo)return null
    if(expectedRootStartId&&peerInfo.startId!==expectedRootStartId)return null
    return peerInfo.startId
  }
  let lookup
  if(process.platform==='linux'){
    lookup=processIdentityOf
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
      const matchesSelf=rootPid===process.pid&&expectedRootStartId===SELF_START_ID
      if(expectedRootStartId&&!matchesSelf&&parentInfo.startId!==expectedRootStartId)return null
      return peerInfo.startId
    }
    visited.add(parentPid)
    childInfo=parentInfo
  }
  return null
}

async function processCommandLineOf(pid,table){
  if(process.platform==='linux'){
    try{
      const raw=await readFile(`/proc/${pid}/cmdline`,'utf8')
      return raw.split('\0').filter(Boolean).join(' ')
    }catch{return null}
  }
  if(process.platform==='win32'){
    const snap=table??await processTableSnapshot()
    const entry=snap?.get(pid)
    return typeof entry?.commandLine==='string'&&entry.commandLine.length>0?entry.commandLine:null
  }
  const psBin=psSystemBin()
  if(!psBin)return null
  try{
    const {stdout}=await execFileAsync(psBin,['-ww','-o','command=','-p',String(pid)],{env:{LC_ALL:'C'},timeout:8000})
    const trimmed=stdout.trim()
    return trimmed.length>0?trimmed:null
  }catch{return null}
}

export async function verifyPrivateFixtureServer({targetPid,launcherPid,profile,maxDepth=2}){
  assert(Number.isSafeInteger(targetPid)&&targetPid>0,'Private fixture target PID required')
  assert(Number.isSafeInteger(launcherPid)&&launcherPid>0,'Private fixture launcher PID required')
  assert(typeof profile==='string'&&profile.length>0,'Private fixture profile path required')
  const profileReal=await realpath(profile)
  const table=process.platform==='linux'?null:await processTableSnapshot()
  const lookup=process.platform==='linux'?processIdentityOf:pid=>Promise.resolve(table?.get(pid)??null)
  const inTree=async(peerPid)=>{
    if(peerPid===launcherPid)return Boolean(await lookup(peerPid))
    const peerInfo=await lookup(peerPid)
    if(!peerInfo)return false
    const visited=new Set([peerPid])
    let childInfo=peerInfo
    for(let depth=0;depth<maxDepth;depth++){
      const parentPid=childInfo.ppid
      if(!Number.isSafeInteger(parentPid)||parentPid<=1||visited.has(parentPid))return false
      const parentInfo=await lookup(parentPid)
      if(!parentInfo)return false
      if(parentInfo.createdAt>childInfo.createdAt)return false
      if(parentPid===launcherPid)return true
      visited.add(parentPid)
      childInfo=parentInfo
    }
    return false
  }
  assert(await inTree(process.pid),`Fixture runner PID ${process.pid} is not a direct descendant of launcher PID ${launcherPid}`)
  assert(await inTree(targetPid),`Target server PID ${targetPid} was not launched by private fixture launcher PID ${launcherPid}`)
  const commandLine=await processCommandLineOf(targetPid,table)
  assert(typeof commandLine==='string'&&commandLine.length>0,`Unable to inspect OS command line of target server PID ${targetPid}`)
  const normalize=value=>process.platform==='win32'?value.replace(/\\/g,'/').toLowerCase():value
  const cmdNorm=normalize(commandLine)
  const expected=[normalize(profileReal),normalize(path.resolve(profile))]
  assert(expected.some(candidate=>cmdNorm.includes(candidate)),
    `Target server PID ${targetPid} command line is not scoped to private fixture profile ${profileReal}`)
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

export function createClientPidGate(getPort,verifyPeer=verifyLoopbackConnectionPeer,options={}) {
  const {allowDescendants=false}=options
  const allowedEntries=new Map()
  const pendingPids=new Set()
  const attestedSockets=new WeakMap()
  const socketsByPid=new Map()
  const descendantEntries=new Map()
  let sweepTimer=null,sweeping=false,closed=false
  const isAllowed=pid=>{
    if(closed)return false
    const entry=allowedEntries.get(pid)
    return Boolean(entry&&entry.tokens.size>0&&entry.startId&&pidAlive(pid))
  }
  const hasTrackedSockets=()=>socketsByPid.size>0||descendantEntries.size>0
  const stopSweepIfIdle=()=>{
    if(sweepTimer&&!hasTrackedSockets()){clearInterval(sweepTimer);sweepTimer=null}
  }
  const destroyDescendant=peerPid=>{
    const entry=descendantEntries.get(peerPid)
    if(!entry)return
    descendantEntries.delete(peerPid)
    for(const socket of [...entry.sockets]){try{socket.destroy()}catch{}}
    stopSweepIfIdle()
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
    stopSweepIfIdle()
  }
  const ensureSweep=()=>{
    if(sweepTimer||!hasTrackedSockets())return
    sweepTimer=setInterval(()=>{
      if(sweeping||!hasTrackedSockets())return
      sweeping=true
      void (async()=>{
        try{
          for(const rootPid of [...socketsByPid.keys()]){
            const allowed=allowedEntries.get(rootPid)
            if(!allowed||allowed.tokens.size===0||!allowed.startId||!pidAlive(rootPid)){
              allowedEntries.delete(rootPid);identityCache.delete(rootPid);destroyPidSockets(rootPid);continue
            }
            // Avoid spawning PowerShell/ps every 500ms; only Linux /proc is cheap enough to re-read live.
            // A probe timeout returns 'unknown' (keep and recheck later), never banning a live PID.
            if(process.platform==='linux'){
              const res=await probeProcessIdentity(rootPid,{refresh:true})
              if(res.status==='dead'||(res.status==='ok'&&res.identity.startId!==allowed.startId)){
                allowedEntries.delete(rootPid);destroyPidSockets(rootPid)
              }
            }
          }
          for(const [peerPid,entry] of [...descendantEntries.entries()]){
            const rootAllowed=allowedEntries.get(entry.rootPid)
            if(!isAllowed(entry.rootPid)||!pidAlive(peerPid)){
              identityCache.delete(peerPid);destroyDescendant(peerPid);continue
            }
            if(process.platform==='linux'){
              const rootRes=await probeProcessIdentity(entry.rootPid,{refresh:true})
              if(rootRes.status==='dead'||(rootRes.status==='ok'&&rootRes.identity.startId!==rootAllowed.startId)){
                allowedEntries.delete(entry.rootPid);destroyPidSockets(entry.rootPid);continue
              }
              const peerRes=await probeProcessIdentity(peerPid,{refresh:true})
              if(peerRes.status==='dead'||(peerRes.status==='ok'&&peerRes.identity.startId!==entry.startId)){
                destroyDescendant(peerPid)
              }
            }
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
    }
    ensureSweep()
    socket.once('close',()=>{
      const current=socketsByPid.get(rootPid)
      if(current){current.delete(socket);if(current.size===0)socketsByPid.delete(rootPid)}
      if(descEntry){
        descEntry.sockets.delete(socket)
        if(descEntry.sockets.size===0)descendantEntries.delete(peerPid)
      }
      stopSweepIfIdle()
    })
  }
  const allow=(pidOrPromise,exitPromise)=>{
    const token=Symbol('relay-client')
    let revoked=false,resolvedPid=null
    const revoke=()=>{
      if(revoked)return
      revoked=true
      if(resolvedPid!==null){
        const entry=allowedEntries.get(resolvedPid)
        if(entry){
          entry.tokens.delete(token)
          if(entry.tokens.size===0){
            allowedEntries.delete(resolvedPid)
            destroyPidSockets(resolvedPid)
          }
        }
      }
    }
    const task=Promise.resolve(pidOrPromise).then(async resolved=>{
      if(closed||revoked||!Number.isSafeInteger(resolved)||resolved<=0)return
      let info=null
      for(let attempt=0;attempt<3;attempt++){
        const res=await probeProcessIdentity(resolved)
        if(res.status==='ok'){info=res.identity;break}
        if(res.status==='dead'||closed||revoked)return
        if(attempt<2)await new Promise(resolve=>setTimeout(resolve,100))
      }
      if(closed||revoked||!info?.startId||!pidAlive(resolved))return
      resolvedPid=resolved
      let entry=allowedEntries.get(resolved)
      if(entry&&entry.startId!==info.startId){
        destroyPidSockets(resolved)
        entry=null
      }
      if(!entry){entry={tokens:new Set(),startId:info.startId};allowedEntries.set(resolved,entry)}
      entry.tokens.add(token)
    },()=>{})
    pendingPids.add(task)
    void task.finally(()=>pendingPids.delete(task))
    if(exitPromise)void Promise.resolve(exitPromise).catch(()=>{}).finally(revoke)
    return Object.assign(task,{revoke})
  }
  const verify=async socket=>{
    if(closed||socket.destroyed)return false
    if(!isLoopbackIpv4Address(socket.localAddress)||!isLoopbackIpv4Address(socket.remoteAddress))return false
    const known=attestedSockets.get(socket)
    if(known!==undefined){
      const rootEntry=allowedEntries.get(known.rootPid)
      const rootValid=Boolean(rootEntry&&rootEntry.tokens.size>0&&rootEntry.startId&&pidAlive(known.rootPid)&&rootEntry.startId===known.rootStartId)
      const descValid=!allowDescendants||known.peerPid===known.rootPid
        ||descendantEntries.get(known.peerPid)?.startId===known.startId
      if(rootValid&&pidAlive(known.peerPid)&&descValid)return true
      if(known.peerPid!==known.rootPid)destroyDescendant(known.peerPid)
      else destroyPidSockets(known.rootPid)
      socket.destroy()
      return false
    }
    if(pendingPids.size>0)await Promise.allSettled([...pendingPids])
    const localPort=getPort()
    const remotePort=socket.remotePort
    if(!localPort||!remotePort||!allowedEntries.size||socket.destroyed)return false
    for(let attempt=0;attempt<6;attempt++){
      if(socket.destroyed)return false
      const candidates=[...allowedEntries.keys()].filter(isAllowed)
      if(!candidates.length)return false
      if(allowDescendants&&verifyPeer===verifyLoopbackConnectionPeer){
        const peerPid=await resolveLoopbackPeerPid(localPort,remotePort).catch(()=>null)
        if(peerPid&&pidAlive(peerPid)){
          for(const rootPid of candidates){
            const rootEntry=allowedEntries.get(rootPid)
            if(!rootEntry?.startId)continue
            const rootRes=await probeProcessIdentity(rootPid)
            if(rootRes.status==='dead'||(rootRes.status==='ok'&&rootRes.identity.startId!==rootEntry.startId)){
              allowedEntries.delete(rootPid);destroyPidSockets(rootPid);continue
            }
            if(rootRes.status==='unknown')continue
            const cachedDesc=descendantEntries.get(peerPid)
            let startId=null
            if(cachedDesc&&cachedDesc.rootPid===rootPid&&pidAlive(peerPid)){
              const peerRes=await probeProcessIdentity(peerPid)
              if(peerRes.status==='ok'&&peerRes.identity.startId===cachedDesc.startId){
                startId=cachedDesc.startId
              }
            }
            if(!startId){
              startId=await isPidInOwnedTree(peerPid,rootPid,rootEntry.startId)
            }
            if(startId&&isAllowed(rootPid)&&!socket.destroyed){
              if(peerPid===rootPid&&rootEntry.startId!==startId)continue
              attestedSockets.set(socket,{rootPid,rootStartId:rootEntry.startId,peerPid,startId})
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
          const rootEntry=allowedEntries.get(matchedPid)
          if(!rootEntry?.startId)return false
          const res=await probeProcessIdentity(matchedPid)
          if(res.status==='dead'||(res.status==='ok'&&res.identity.startId!==rootEntry.startId)){
            allowedEntries.delete(matchedPid);destroyPidSockets(matchedPid);return false
          }
          if(res.status==='unknown')return false
          attestedSockets.set(socket,{rootPid:matchedPid,rootStartId:rootEntry.startId,peerPid:matchedPid,startId:rootEntry.startId})
          trackSocket(matchedPid,matchedPid,rootEntry.startId,socket)
          return true
        }catch{}
      }
      if(attempt<5&&!socket.destroyed)await new Promise(resolve=>setTimeout(resolve,20))
    }
    return false
  }
  const close=()=>{
    closed=true
    if(sweepTimer){clearInterval(sweepTimer);sweepTimer=null}
    for(const pid of [...allowedEntries.keys()]){
      allowedEntries.delete(pid)
      destroyPidSockets(pid)
    }
    for(const peerPid of [...descendantEntries.keys()])destroyDescendant(peerPid)
  }
  return {allow,verify,close}
}
