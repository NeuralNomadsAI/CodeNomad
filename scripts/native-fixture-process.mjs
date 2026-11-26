import assert from 'node:assert/strict'
import {execFile,execFileSync} from 'node:child_process'
import {existsSync,lstatSync,realpathSync} from 'node:fs'
import {readdir,readFile,readlink,realpath} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const execFileAsync=promisify(execFile)
const repoRoot=path.resolve(fileURLToPath(new URL('..',import.meta.url)))

const identityCache=new Map()
const identityCacheGen=new Map()
const inFlightCachedIdentity=new Map()
let identityGen=0
let inFlightTable=null
let selfIdentityPromise=null
let cachedSystem32Dir=null

const isUnc=value=>typeof value==='string'&&(/^[\\/]{2}/.test(value)||/^[\\/]{2}/.test(path.normalize(value)))

const envValue=(source,name)=>{
  if(!source)return undefined
  if(source===process.env)return source[name]
  const target=name.toLowerCase()
  for(const [k,v] of Object.entries(source)){
    if(k.toLowerCase()===target)return v
  }
  return undefined
}

export function resolveFixtureJobBinary(sourceEnv=process.env){
  const suffix=process.platform==='win32'?'.exe':''
  const expectedName=`codenomad-fixture-job${suffix}`
  const explicit=envValue(sourceEnv,'CODENOMAD_FIXTURE_JOB_EXE')
  const cargoTarget=envValue(sourceEnv,'CARGO_TARGET_DIR')
  const cargoCandidate=typeof cargoTarget==='string'&&cargoTarget.length>0&&!isUnc(cargoTarget)
    ?path.resolve(repoRoot,cargoTarget,'debug',expectedName)
    :null
  const candidates=[
    explicit,
    cargoCandidate,
    path.join(repoRoot,'target','debug',expectedName),
  ].filter(v=>typeof v==='string'&&v.length>0&&path.isAbsolute(v)&&!isUnc(v))
  for(const candidate of candidates){
    try{
      if(path.basename(candidate).toLowerCase()!==expectedName.toLowerCase())continue
      if(!existsSync(candidate))continue
      const info=lstatSync(candidate)
      if(info.isSymbolicLink()||!info.isFile())continue
      const resolved=realpathSync(candidate)
      if(path.basename(resolved).toLowerCase()!==expectedName.toLowerCase())continue
      return resolved
    }catch{}
  }
  return null
}

export function fixtureAttestationEnv(sourceEnv=process.env,{includeServerRoots=false}={}){
  const out={}
  const jobBin=resolveFixtureJobBinary(sourceEnv)
  if(jobBin)out.CODENOMAD_FIXTURE_JOB_EXE=jobBin
  if(includeServerRoots){
    const cargoTarget=envValue(sourceEnv,'CARGO_TARGET_DIR')
    if(typeof cargoTarget==='string'&&cargoTarget.length>0&&!isUnc(cargoTarget)){
      const abs=path.resolve(repoRoot,cargoTarget)
      if(path.isAbsolute(abs)&&!isUnc(abs))out.CARGO_TARGET_DIR=abs
    }
    const serverExe=envValue(sourceEnv,'RUNE_SERVER_EXE')
    if(typeof serverExe==='string'&&serverExe.length>0&&path.isAbsolute(serverExe)&&!isUnc(serverExe)){
      out.RUNE_SERVER_EXE=serverExe
    }
  }
  return out
}

function fixtureJobBin(){
  return resolveFixtureJobBinary(process.env)
}

const system32Dir=()=>{
  if(cachedSystem32Dir)return cachedSystem32Dir
  const jobBin=fixtureJobBin()
  if(jobBin){
    try{
      const resolved=execFileSync(jobBin,['--system-dir'],{windowsHide:true,encoding:'utf8',timeout:5000}).trim()
      if(resolved&&/^[A-Za-z]:\\Windows\\System32$/i.test(resolved)&&existsSync(resolved)&&!lstatSync(resolved).isSymbolicLink()){
        const parent=path.win32.dirname(resolved)
        if(!lstatSync(parent).isSymbolicLink()){
          cachedSystem32Dir=resolved
          return cachedSystem32Dir
        }
      }
    }catch{}
  }
  const systemRoot='C:\\Windows'
  assert(existsSync(systemRoot)&&!lstatSync(systemRoot).isSymbolicLink(),`Expected non-symlink OS Windows directory at ${systemRoot}`)
  const system32=path.win32.join(systemRoot,'System32')
  assert(existsSync(system32)&&!lstatSync(system32).isSymbolicLink(),`Expected non-symlink System32 directory at ${system32}`)
  cachedSystem32Dir=system32
  return cachedSystem32Dir
}

const netstatBin=()=>{
  const candidate=path.win32.join(system32Dir(),'netstat.exe')
  assert(existsSync(candidate)&&!lstatSync(candidate).isSymbolicLink(),`Expected system netstat executable at ${candidate}`)
  return candidate
}

const powershellBin=()=>{
  try{
    const dir=system32Dir()
    const psDir=path.win32.join(dir,'WindowsPowerShell')
    const v1Dir=path.win32.join(psDir,'v1.0')
    const candidate=path.win32.join(v1Dir,'powershell.exe')
    for(const segment of [psDir,v1Dir,candidate]){
      if(!existsSync(segment)||lstatSync(segment).isSymbolicLink())return null
    }
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

async function probeViaNativeHelper(pid){
  const jobBin=fixtureJobBin()
  if(!jobBin)return null
  try{
    const {stdout}=await execFileAsync(jobBin,['--probe-pid',String(pid)],{timeout:5000,windowsHide:true,maxBuffer:4*1024*1024})
    const parsed=JSON.parse(stdout.trim())
    if(parsed?.status==='dead')return {status:'dead',identity:null}
    if(parsed?.status==='ok'&&typeof parsed.startId==='string'&&parsed.startId.length>0){
      return {
        status:'ok',
        identity:{
          ppid:Number.isSafeInteger(parsed.ppid)?parsed.ppid:(pid===process.pid?process.ppid:null),
          startId:parsed.startId,
          createdAt:BigInt(parsed.createdAt??parsed.startId),
          exe:typeof parsed.exe==='string'?parsed.exe:null,
          cwd:typeof parsed.cwd==='string'?parsed.cwd:null,
          argv:Array.isArray(parsed.argv)?parsed.argv:null,
        },
      }
    }
    return {status:'unknown',identity:null}
  }catch{
    return {status:pidAlive(pid)?'unknown':'dead',identity:null}
  }
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
    // Native Win32 OpenProcess + GetExitCodeProcess + GetProcessTimes + QueryFullProcessImageNameW
    // via codenomad-fixture-job (~2 ms, zero PowerShell/WMI on the admission path).
    const native=await probeViaNativeHelper(pid)
    if(native)return native
    return {status:pidAlive(pid)?'unknown':'dead',identity:null}
  }
  if(process.platform==='darwin'){
    const native=await probeViaNativeHelper(pid)
    if(native)return native
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
    const gen=++identityGen
    identityCache.delete(pid)
    identityCacheGen.set(pid,gen)
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
  if(!refresh&&inFlightCachedIdentity.has(pid)){
    return inFlightCachedIdentity.get(pid)
  }
  // Always start a fresh OS observation on refresh=true so admission probes never coalesce
  // with an earlier probe that began before the socket was observed.
  const gen=++identityGen
  const task=(async()=>{
    const res=await queryOsIdentity(pid)
    const latestGen=identityCacheGen.get(pid)??0
    if(gen>=latestGen){
      identityCacheGen.set(pid,gen)
      if(res.status==='ok'){
        if(identityCache.size>512){identityCache.clear();identityCacheGen.clear()}
        identityCache.set(pid,res.identity)
        identityCacheGen.set(pid,gen)
      }else if(res.status==='dead'){
        identityCache.delete(pid)
      }
    }
    return res
  })()
  if(!refresh){
    inFlightCachedIdentity.set(pid,task)
    try{return await task}finally{if(inFlightCachedIdentity.get(pid)===task)inFlightCachedIdentity.delete(pid)}
  }
  return task
}

export async function processIdentityOf(pid,{refresh=false}={}){
  const res=await probeProcessIdentity(pid,{refresh})
  return res.status==='ok'?res.identity:null
}

// Parse a Windows process command line according to the Microsoft C Runtime (CRT)
// CommandLineToArgvW grammar: argv[0] treats double quotes as simple delimiters without
// backslash escaping, whereas argv[1..] apply standard 2n/2n+1 backslash-quote rules.
export function parseWindowsCommandLine(raw){
  if(typeof raw!=='string')return []
  const args=[]
  let i=0
  const len=raw.length
  while(i<len&&(raw[i]===' '||raw[i]==='\t'))i++
  if(i>=len)return args
  // argv[0]: CRT program name rules (quotes toggle quoting; backslashes are literal).
  let first='',inQuotes=false
  while(i<len){
    const ch=raw[i]
    if(!inQuotes&&(ch===' '||ch==='\t'))break
    if(ch==='"'){inQuotes=!inQuotes;i++;continue}
    first+=ch
    i++
  }
  args.push(first)
  // argv[1..]: CRT argument rules.
  while(i<len){
    while(i<len&&(raw[i]===' '||raw[i]==='\t'))i++
    if(i>=len)break
    let current=''
    inQuotes=false
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

const NODE_VALUE_FLAGS=new Set([
  '-e','--eval','-p','--print','-r','--require','--import','--loader','--experimental-loader',
  '-C','--conditions','--env-file','--env-file-if-exists','--input-type','--redirect-warnings',
  '--diagnostic-dir','--heapsnapshot-signal','--max-old-space-size','--v8-pool-size',
  '--cpu-prof-dir','--cpu-prof-name','--cpu-prof-interval','--heap-prof-dir','--heap-prof-name',
  '--heap-prof-interval','--test-name-pattern','--test-reporter','--test-reporter-destination',
  '--test-shard','--test-concurrency','--test-timeout','--title','--openssl-config',
  '--tls-cipher-list','--icu-data-dir','--report-directory','--report-filename',
  '--report-signal','--watch-path',
])

export function extractNodeEntryScript(args){
  if(!Array.isArray(args)||args.length<2)return null
  for(let i=1;i<args.length;i++){
    const token=args[i]
    if(token==='--')return args[i+1]??null
    if(!token.startsWith('-'))return token
    if(token==='-e'||token==='--eval'||token==='-p'||token==='--print'
      ||token.startsWith('--eval=')||token.startsWith('-e=')
      ||token.startsWith('--print=')||token.startsWith('-p=')){
      return null
    }
    if(token.includes('='))continue
    if(NODE_VALUE_FLAGS.has(token)){i++;continue}
  }
  return null
}

async function processTableSnapshot(){
  if(inFlightTable)return inFlightTable
  const task=(async()=>{
    if(process.platform==='win32'){
      const powershell=powershellBin()
      if(!powershell)return null
      try{
        const {stdout}=await execFileAsync(powershell,['-NoProfile','-NonInteractive','-Command','[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { "$($_.ProcessId)|$($_.ParentProcessId)|$([int64]($_.CreationDate.ToUniversalTime().Ticks/10000))|$($_.ExecutablePath)|$($_.CommandLine -replace \'[\\r\\n]+\',\' \')" } }'],{timeout:15000,windowsHide:true,maxBuffer:16*1024*1024})
        const table=new Map()
        for(const line of stdout.split(/\r?\n/)){
          const p1=line.indexOf('|');if(p1<0)continue
          const p2=line.indexOf('|',p1+1);if(p2<0)continue
          const p3=line.indexOf('|',p2+1);if(p3<0)continue
          const p4=line.indexOf('|',p3+1);if(p4<0)continue
          const pid=Number(line.slice(0,p1).trim())
          const ppid=Number(line.slice(p1+1,p2).trim())
          const startId=line.slice(p2+1,p3).trim()
          const exe=line.slice(p3+1,p4).trim()||null
          const commandLine=line.slice(p4+1)
          if(Number.isSafeInteger(pid)&&pid>0&&Number.isSafeInteger(ppid)&&ppid>=0&&startId&&/^\d+$/.test(startId)){
            table.set(pid,{ppid,startId,createdAt:BigInt(startId),exe,commandLine})
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
  const lookup=pid=>processIdentityOf(pid,{refresh:true})
  const peerInfo=await lookup(peerPid)
  if(!peerInfo)return null
  if(peerPid===rootPid){
    if(expectedRootStartId&&peerInfo.startId!==expectedRootStartId)return null
    return peerInfo.startId
  }
  const visited=new Set([peerPid])
  let childInfo=peerInfo
  for(let depth=0;depth<maxDepth;depth++){
    const parentPid=childInfo.ppid
    if(!Number.isSafeInteger(parentPid)||parentPid<=1||visited.has(parentPid))return null
    const parentInfo=await lookup(parentPid)
    if(!parentInfo)return null
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

async function processDetailsOf(pid,table){
  if(process.platform==='linux'){
    try{
      const [rawCmd,exe,cwd]=await Promise.all([
        readFile(`/proc/${pid}/cmdline`,'utf8'),
        readlink(`/proc/${pid}/exe`).catch(()=>null),
        readlink(`/proc/${pid}/cwd`).catch(()=>null),
      ])
      const args=rawCmd.split('\0')
      while(args.length&&args.at(-1)==='')args.pop()
      return {args:args.length?args:null,exe,cwd}
    }catch{return {args:null,exe:null,cwd:null}}
  }
  if(process.platform==='win32'){
    const probed=await probeViaNativeHelper(pid)
    const snap=table??await processTableSnapshot()
    const entry=snap?.get(pid)
    const args=typeof entry?.commandLine==='string'&&entry.commandLine.trim()
      ?parseWindowsCommandLine(entry.commandLine)
      :null
    const exe=(probed?.status==='ok'?probed.identity.exe:null)??entry?.exe??null
    return {args,exe,cwd:null}
  }
  // macOS: structured KERN_PROCARGS2 via codenomad-fixture-job --probe-pid (preserves spaces, quotes, backslashes).
  const probed=await probeViaNativeHelper(pid)
  if(probed?.status==='ok'&&Array.isArray(probed.identity.argv)){
    return {args:probed.identity.argv,exe:probed.identity.exe??null,cwd:probed.identity.cwd??null}
  }
  return {args:null,exe:null,cwd:null}
}

async function resolveCanonicalMaybeMissing(candidate,baseDir=null){
  if(typeof candidate!=='string'||!candidate)return null
  const abs=path.isAbsolute(candidate)?candidate:(baseDir?path.resolve(baseDir,candidate):null)
  if(!abs)return null
  try{return await realpath(abs)}catch{}
  const pending=[]
  let current=path.resolve(abs)
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

function uniqueFlagValue(args,flag){
  let found=null
  let count=0
  for(let i=1;i<args.length;i++){
    if(args[i]==='--')break
    if(args[i]===flag){
      if(i+1>=args.length)return {ok:false,value:null}
      found=args[++i]
      count++
    }else if(args[i].startsWith(`${flag}=`)){
      found=args[i].slice(flag.length+1)
      count++
    }
  }
  return {ok:count===1,value:count===1?found:null}
}

export async function verifyExecutableMatches(pid,expectedPath){
  assert(Number.isSafeInteger(pid)&&pid>0,'Process PID required for executable attestation')
  assert(typeof expectedPath==='string'&&path.isAbsolute(expectedPath),'Absolute expected executable path required')
  const expectedReal=await realpath(expectedPath)
  const probed=await probeProcessIdentity(pid,{refresh:true})
  let exe=probed.status==='ok'?probed.identity.exe:null
  if(!exe&&process.platform==='linux'){
    exe=await readlink(`/proc/${pid}/exe`).catch(()=>null)
  }
  const actualReal=exe?await resolveCanonicalMaybeMissing(exe):null
  assert(actualReal&&normPath(actualReal)===normPath(expectedReal),
    `Process PID ${pid} executable (${exe??'unknown'}) does not match expected ${expectedReal}`)
}

export async function verifyPrivateFixtureServer({targetPid,launcherPid,profile,root,maxDepth=2,allowedLaunchers,allowedServerExecutables}){
  assert(Number.isSafeInteger(targetPid)&&targetPid>0,'Private fixture target PID required')
  assert(Number.isSafeInteger(launcherPid)&&launcherPid>0,'Private fixture launcher PID required')
  assert(typeof profile==='string'&&profile.length>0,'Private fixture profile path required')
  assert(root||Array.isArray(allowedLaunchers),'Private fixture verification requires worktree root or allowedLaunchers')
  const profileReal=await realpath(profile)
  const rootReal=root?await realpath(root):null
  const launcherIdentity=await probeProcessIdentity(launcherPid,{refresh:true})
  assert(launcherIdentity.status==='ok'&&launcherIdentity.identity?.startId,`Unable to attest private fixture launcher PID ${launcherPid}`)
  const launcherStartId=launcherIdentity.identity.startId
  assert(await isPidInOwnedTree(process.pid,launcherPid,launcherStartId,maxDepth),
    `Fixture runner PID ${process.pid} is not a direct descendant of launcher PID ${launcherPid}`)
  const targetStartId=await isPidInOwnedTree(targetPid,launcherPid,launcherStartId,maxDepth)
  assert(targetStartId,`Target server PID ${targetPid} was not launched by private fixture launcher PID ${launcherPid}`)

  // Attest launcher OS executable image (never falling back to spoofable argv[0]) and exact Node entry script operand.
  const table=process.platform==='win32'?await processTableSnapshot():null
  const launcherDetails=await processDetailsOf(launcherPid,table)
  assert(launcherDetails.args&&launcherDetails.args.length>=2,`Unable to inspect launcher PID ${launcherPid} arguments`)
  const nodeExecReal=await realpath(process.execPath)
  assert(launcherDetails.exe,`Unable to attest OS executable image of launcher PID ${launcherPid}`)
  const launcherExeReal=await resolveCanonicalMaybeMissing(launcherDetails.exe)
  assert(launcherExeReal&&normPath(launcherExeReal)===normPath(nodeExecReal),`Launcher PID ${launcherPid} is not the expected Node runtime`)
  const expectedScripts=new Set()
  if(Array.isArray(allowedLaunchers)){
    for(const script of allowedLaunchers){
      const resolved=await resolveCanonicalMaybeMissing(script)
      if(resolved)expectedScripts.add(normPath(resolved))
    }
  }else{
    for(const rel of ['packages/rune-app/fixtures/launcher-fixture.mjs','scripts/rune/web-fixture.mjs']){
      const resolved=await resolveCanonicalMaybeMissing(path.join(rootReal,rel))
      if(resolved)expectedScripts.add(normPath(resolved))
    }
  }
  const entryOperand=extractNodeEntryScript(launcherDetails.args)
  assert(entryOperand,`Launcher PID ${launcherPid} has no verifiable Node entry script operand`)
  const launcherBaseDir=launcherDetails.cwd??rootReal
  assert(path.isAbsolute(entryOperand)||launcherBaseDir,
    `Launcher PID ${launcherPid} relative entry script (${entryOperand}) cannot be verified without an attested working directory`)
  const entryReal=await resolveCanonicalMaybeMissing(entryOperand,launcherBaseDir)
  assert(entryReal&&expectedScripts.has(normPath(entryReal)),
    `Launcher PID ${launcherPid} entry script (${entryOperand}) is not an authorized private fixture launcher`)

  // Attest target server OS executable image (never argv[0]) and closed, canonically confined arguments.
  const targetDetails=await processDetailsOf(targetPid,table)
  const targetArgs=targetDetails.args
  assert(targetArgs&&targetArgs.length>=2,`Unable to inspect OS arguments of target server PID ${targetPid}`)
  assert(targetDetails.exe,`Unable to attest OS executable image of target server PID ${targetPid}`)
  const targetExeReal=await resolveCanonicalMaybeMissing(targetDetails.exe)
  assert(targetExeReal,`Unable to resolve OS executable image of target server PID ${targetPid}`)
  let isRustServer=false
  if(Array.isArray(allowedServerExecutables)){
    const allowedSet=new Set()
    for(const candidate of allowedServerExecutables){
      const resolved=await resolveCanonicalMaybeMissing(candidate)
      if(resolved)allowedSet.add(normPath(resolved))
    }
    assert(allowedSet.has(normPath(targetExeReal)),`Target server PID ${targetPid} executable (${targetExeReal}) is not allowed`)
  }else{
    const exeName=path.basename(targetExeReal).toLowerCase()
    const rustNameMatch=/^codenomad-(?:rs|server)(?:\.exe)?$/.test(exeName)
    const isNodeTsServer=normPath(targetExeReal)===normPath(nodeExecReal)
    if(rustNameMatch){
      const trustedRoots=[]
      if(rootReal)trustedRoots.push(rootReal)
      if(process.env.CARGO_TARGET_DIR&&path.isAbsolute(process.env.CARGO_TARGET_DIR)&&!isUnc(process.env.CARGO_TARGET_DIR)){
        const cargoReal=await resolveCanonicalMaybeMissing(process.env.CARGO_TARGET_DIR)
        if(cargoReal)trustedRoots.push(cargoReal)
      }
      const explicitServer=process.env.RUNE_SERVER_EXE&&path.isAbsolute(process.env.RUNE_SERVER_EXE)&&!isUnc(process.env.RUNE_SERVER_EXE)
        ?await resolveCanonicalMaybeMissing(process.env.RUNE_SERVER_EXE)
        :null
      const inTrustedRoot=trustedRoots.some(base=>isPathStrictlyInside(base,targetExeReal))
      const matchesExplicit=Boolean(explicitServer&&normPath(targetExeReal)===normPath(explicitServer))
      assert(inTrustedRoot||matchesExplicit,
        `Rust server PID ${targetPid} executable (${targetExeReal}) is outside trusted build roots`)
      isRustServer=true
    }else if(isNodeTsServer&&rootReal){
      const tsEntry=extractNodeEntryScript(targetArgs)
      const tsBaseDir=targetDetails.cwd??rootReal
      const tsEntryReal=tsEntry?await resolveCanonicalMaybeMissing(tsEntry,tsBaseDir):null
      const expectedTs=await resolveCanonicalMaybeMissing(path.join(rootReal,'packages/server-rs/bench/ts-server.mjs'))
      assert(tsEntryReal&&expectedTs&&normPath(tsEntryReal)===normPath(expectedTs),
        `Node target server PID ${targetPid} is not running packages/server-rs/bench/ts-server.mjs`)
    }else{
      assert.fail(`Target server PID ${targetPid} executable (${targetExeReal}) is not an authorized CodeNomad server`)
    }
  }

  // Contract 1: closed positional fixture-server invocation [<profile>/projects, <profile>/identity.json, <port>, <profile>/disabled-opencode-cli.exe]
  let confined=false
  if(targetArgs.length===5&&!targetArgs[1].startsWith('-')&&!targetArgs[2].startsWith('-')&&/^\d+$/.test(targetArgs[3])){
    const arg1=await resolveCanonicalMaybeMissing(targetArgs[1])
    const arg2=await resolveCanonicalMaybeMissing(targetArgs[2])
    const arg4=await resolveCanonicalMaybeMissing(targetArgs[4])
    const expectedProjects=normPath(path.join(profileReal,'projects'))
    const expectedIdentity=normPath(path.join(profileReal,'identity.json'))
    if(arg1&&arg2&&arg4
      &&normPath(arg1)===expectedProjects
      &&normPath(arg2)===expectedIdentity
      &&isPathStrictlyInside(profileReal,arg4)){
      confined=true
    }
  }
  // Contract 2: Rust `serve` or TS server with unique --config and --workspace-root strictly inside profileReal (before `--`).
  if(!confined){
    const subcommandOk=!isRustServer||targetArgs[1]==='serve'
    const cfg=uniqueFlagValue(targetArgs,'--config')
    const ws=uniqueFlagValue(targetArgs,'--workspace-root')
    if(subcommandOk&&cfg.ok&&ws.ok&&cfg.value&&ws.value){
      const cfgReal=await resolveCanonicalMaybeMissing(cfg.value,targetDetails.cwd)
      const wsReal=await resolveCanonicalMaybeMissing(ws.value,targetDetails.cwd)
      if(cfgReal&&wsReal&&isPathStrictlyInside(profileReal,cfgReal)&&isPathStrictlyInside(profileReal,wsReal)){
        confined=true
      }
    }
  }
  assert(confined,`Target server PID ${targetPid} arguments are not canonically confined to private fixture profile ${profileReal}`)
  return {targetPid,targetStartId}
}

let inFlightWin32Netstat=null
let inFlightWin32NetstatFreshTick=false

async function win32TcpTable({fresh=false}={}){
  if(fresh&&inFlightWin32Netstat&&!inFlightWin32NetstatFreshTick){
    await inFlightWin32Netstat.catch(()=>{})
  }
  if(inFlightWin32Netstat)return inFlightWin32Netstat
  const task=execFileAsync(netstatBin(),['-ano','-p','tcp'],{timeout:10000,windowsHide:true,maxBuffer:8*1024*1024})
    .then(res=>res.stdout)
  inFlightWin32Netstat=task
  inFlightWin32NetstatFreshTick=true
  queueMicrotask(()=>{if(inFlightWin32Netstat===task)inFlightWin32NetstatFreshTick=false})
  try{return await task}finally{
    if(inFlightWin32Netstat===task){
      inFlightWin32Netstat=null
      inFlightWin32NetstatFreshTick=false
    }
  }
}

export async function resolveLoopbackListenerPid(port){
  assert(Number.isSafeInteger(port)&&port>0&&port<=65535,'Invalid loopback port')
  if(process.platform==='win32'){
    const stdout=await win32TcpTable({fresh:true})
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

export async function verifyLoopbackListenerOwner(port,pid,forbidden='the shared OpenCode service is forbidden',{coalesce=false}={}){
  assert(Number.isSafeInteger(port)&&port>0&&port<=65535,'Invalid loopback port')
  assert(Number.isSafeInteger(pid)&&pid>0,'Invalid fixture PID')
  if(process.platform==='win32'){
    const parseOwners=stdout=>{
      const owners=new Set()
      for(const line of stdout.split(/\r?\n/)){
        const match=/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+0\.0\.0\.0:0\s+\S+\s+(\d+)\s*$/i.exec(line)
        if(match&&Number(match[1])===port)owners.add(Number(match[2]))
      }
      return owners
    }
    const hadInFlight=coalesce&&Boolean(inFlightWin32Netstat)
    let owners=parseOwners(await win32TcpTable({fresh:!coalesce}))
    if(hadInFlight&&!(owners.size===1&&owners.has(pid))){
      owners=parseOwners(await win32TcpTable({fresh:true}))
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
    const stdout=await win32TcpTable()
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
    const stdout=await win32TcpTable()
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
    maxUnknownMs=2500,
    sweepIntervalMs=500,
  }=options
  const allowedEntries=new Map()
  const pendingPids=new Set()
  const attestedSockets=new WeakMap()
  const inFlightVerify=new WeakMap()
  const descendantEntries=new Map()
  let sweepTimer=null,sweeping=false,sweepTick=0,entryGen=0,closed=false
  const isEntryLive=(pid,entry)=>Boolean(!closed&&entry&&allowedEntries.get(pid)===entry&&entry.tokens.size>0&&entry.startId&&pidAlive(pid))
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
  const recordUnknown=(entry)=>{
    const now=Date.now()
    entry.unknownStrikes++
    if(entry.firstUnknownAt===null)entry.firstUnknownAt=now
    return entry.unknownStrikes>=maxUnknownStrikes||(now-entry.firstUnknownAt)>=maxUnknownMs
  }
  const ensureSweep=()=>{
    if(sweepTimer||!hasTrackedSockets()||sweepIntervalMs<=0)return
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
                if(recordUnknown(entry)){destroyRootEntry(rootPid,entry);continue}
              }else{
                entry.unknownStrikes=0;entry.firstUnknownAt=null
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
                if(recordUnknown(descEntry)){destroyDescendantEntry(peerPid,descEntry);continue}
              }else{
                descEntry.unknownStrikes=0;descEntry.firstUnknownAt=null
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
    },sweepIntervalMs)
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
        descEntry={id:Symbol('desc'),rootPid,rootEntryId:rootEntry.id,startId,unknownStrikes:0,firstUnknownAt:null,sockets:new Set()}
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
    const allowGeneration=++entryGen
    let revoked=false,resolvedPid=null,boundEntry=null,task=null
    const revoke=()=>{
      if(revoked)return
      revoked=true
      if(task)pendingPids.delete(task)
      if(resolvedPid!==null&&boundEntry){
        boundEntry.tokens.delete(token)
        if(boundEntry.tokens.size===0){
          destroyRootEntry(resolvedPid,boundEntry)
        }
      }
    }
    task=Promise.resolve(pidOrPromise).then(async resolved=>{
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
        // Never allow an older allow() task to clobber a newer entry generation.
        if(entry.gen>allowGeneration)return
        destroyRootEntry(resolved,entry)
        entry=null
      }
      if(!entry){
        entry={id:Symbol('entry'),gen:allowGeneration,tokens:new Set(),startId:info.startId,unknownStrikes:0,firstUnknownAt:null,sockets:new Set()}
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
  const tryAdmit=async(socket,localPort,remotePort)=>{
    const candidates=[...allowedEntries.entries()].filter(([pid,entry])=>isEntryLive(pid,entry))
    if(!candidates.length)return false
    if(allowDescendants&&verifyPeer===verifyLoopbackConnectionPeer){
      const peerPid=await resolveLoopbackPeerPid(localPort,remotePort).catch(()=>null)
      if(closed||socket.destroyed)return false
      if(peerPid&&pidAlive(peerPid)){
        for(const [rootPid,rootEntry] of candidates){
          if(!isEntryLive(rootPid,rootEntry))continue
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
      return false
    }
    try{
      const matched=await Promise.any(candidates.map(([clientPid,entry])=>
        verifyPeer(localPort,remotePort,clientPid).then(()=>({clientPid,entry}))))
      if(closed||socket.destroyed||!isEntryLive(matched.clientPid,matched.entry))return false
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
    }catch{
      return false
    }
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
    if(inFlightVerify.has(socket))return inFlightVerify.get(socket)
    const work=(async()=>{
      const localPort=getPort()
      const remotePort=socket.remotePort
      if(closed||!localPort||!remotePort||socket.destroyed)return false
      // Try already-active allowed entries first so an unrelated slow/pending allow() never blocks them.
      if(allowedEntries.size>0&&await tryAdmit(socket,localPort,remotePort))return true
      if(pendingPids.size>0){
        await Promise.race([
          Promise.allSettled([...pendingPids]),
          new Promise(resolve=>{const t=setTimeout(resolve,5000);t.unref?.()}),
        ])
      }
      if(closed||!allowedEntries.size||socket.destroyed)return false
      for(let attempt=0;attempt<6;attempt++){
        if(closed||socket.destroyed)return false
        if(await tryAdmit(socket,localPort,remotePort))return true
        if(attempt<5&&!closed&&!socket.destroyed)await new Promise(resolve=>setTimeout(resolve,20))
      }
      return false
    })()
    inFlightVerify.set(socket,work)
    try{return await work}finally{if(inFlightVerify.get(socket)===work)inFlightVerify.delete(socket)}
  }
  const close=()=>{
    closed=true
    if(sweepTimer){clearInterval(sweepTimer);sweepTimer=null}
    pendingPids.clear()
    for(const [pid,entry] of [...allowedEntries.entries()])destroyRootEntry(pid,entry)
    for(const [peerPid,descEntry] of [...descendantEntries.entries()])destroyDescendantEntry(peerPid,descEntry)
    allowedEntries.clear()
    descendantEntries.clear()
  }
  return {allow,verify,close}
}
