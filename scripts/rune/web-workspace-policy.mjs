import assert from 'node:assert/strict'
import {constants as fsConstants} from 'node:fs'
import {lstat,mkdir,open,readdir,readFile,realpath} from 'node:fs/promises'
import path from 'node:path'
import {privateEnvironment} from '../../packages/rune-app/fixtures/private-profile.mjs'

const inside=(parent,value)=>{const relative=path.relative(parent,value);return relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)}

export async function privateChromiumEnv(profile){
  const env=await privateEnvironment(profile)
  for(const key of ['DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR','LANG','LC_ALL','TZ']){
    if(process.env[key])env[key]=process.env[key]
  }
  return env
}

export async function assertWorktreeTestRoot(root){
  const rootReal=await realpath(root)
  const targetPath=path.join(rootReal,'target')
  const targetStat=await lstat(targetPath).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
  if(targetStat){
    assert(!targetStat.isSymbolicLink()&&targetStat.isDirectory(),`Fixture target path must be a real directory inside the worktree: ${targetPath}`)
    assert(inside(rootReal,await realpath(targetPath)),`Fixture target path escapes canonical worktree: ${targetPath}`)
  }
  const testsPath=path.join(targetPath,'rune-web-tests')
  const testsStat=await lstat(testsPath).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
  if(testsStat){
    assert(!testsStat.isSymbolicLink()&&testsStat.isDirectory(),`Fixture test root must be a real directory inside the worktree: ${testsPath}`)
    assert(inside(rootReal,await realpath(testsPath)),`Fixture test root escapes canonical worktree: ${testsPath}`)
  }
  await mkdir(testsPath,{recursive:true})
  const testsReal=await realpath(testsPath)
  assert(inside(rootReal,testsReal),`Fixture test root escapes canonical worktree: ${testsReal}`)
  return {rootReal,testsReal}
}

export function assertPrivateDirStat(stat,label){
  assert(!stat.isSymbolicLink()&&stat.isDirectory(),`Output path must be a non-symlink directory: ${label}`)
  if(process.platform!=='win32'){
    assert.equal(Number(stat.uid),process.getuid(),`Output directory must be owned by current user: ${label}`)
    assert.equal(Number(stat.mode)&0o077,0,`Output directory must not be group/world accessible: ${label}`)
  }
}

export async function createPrivateOutputDir(out,allowedRoot){
  const rootReal=await realpath(allowedRoot)
  const resolved=path.resolve(out)
  const parentReal=await realpath(path.dirname(resolved))
  assert(parentReal===rootReal||inside(rootReal,parentReal),`Output parent escapes allowed fixture root: ${parentReal}`)
  const existing=await lstat(resolved).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
  if(existing){
    assertPrivateDirStat(existing,resolved)
    const entries=await readdir(resolved)
    assert.equal(entries.length,0,`Refusing to write into non-empty output directory: ${resolved}`)
  }else{
    await mkdir(resolved,{mode:0o700})
    assertPrivateDirStat(await lstat(resolved),resolved)
  }
  const outReal=await realpath(resolved)
  assert(inside(rootReal,outReal),`Output link escapes fixture root: ${outReal}`)
  return outReal
}

async function openVerifiedPrivateFile(filePath,allowedRoot,extraFlags=0,expectedDirIdentity=null){
  const rootReal=await realpath(allowedRoot)
  const resolved=path.resolve(filePath)
  const parentPath=path.dirname(resolved)
  const dirReal=await realpath(parentPath)
  assert(dirReal===rootReal||inside(rootReal,dirReal),`Output directory escapes allowed fixture root: ${dirReal}`)
  if(expectedDirIdentity){
    const dirStat=await lstat(parentPath,{bigint:true})
    assertPrivateDirStat(dirStat,parentPath)
    assert(dirStat.dev===expectedDirIdentity.dev&&dirStat.ino===expectedDirIdentity.ino,`Output directory identity changed before open: ${parentPath}`)
  }
  const existing=await lstat(resolved).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
  assert(!existing||(!existing.isSymbolicLink()&&existing.isFile()&&existing.nlink===1),`Refusing to overwrite symlink, hardlink, or non-file output: ${resolved}`)
  const flags=fsConstants.O_WRONLY|fsConstants.O_CREAT|extraFlags|(fsConstants.O_NOFOLLOW??0)
  const handle=await open(resolved,flags,0o600)
  try{
    const fdStat=await handle.stat()
    assert(fdStat.isFile()&&fdStat.nlink===1,`Opened output file failed link/type verification: ${resolved}`)
    const recheckDir=await realpath(parentPath)
    assert(recheckDir===dirReal&&(recheckDir===rootReal||inside(rootReal,recheckDir)),`Output parent shifted during open: ${resolved}`)
    if(expectedDirIdentity){
      const afterDirStat=await lstat(parentPath,{bigint:true})
      assertPrivateDirStat(afterDirStat,parentPath)
      assert(afterDirStat.dev===expectedDirIdentity.dev&&afterDirStat.ino===expectedDirIdentity.ino,`Output directory identity shifted during open: ${parentPath}`)
    }
    return handle
  }catch(error){
    await handle.close().catch(()=>{})
    throw error
  }
}

export async function writePrivateFile(filePath,content,allowedRoot,expectedDirIdentity=null){
  const handle=await openVerifiedPrivateFile(filePath,allowedRoot,0,expectedDirIdentity)
  try{
    await handle.truncate(0)
    await handle.writeFile(content)
  }finally{await handle.close()}
}

export async function writeExclusivePrivateFile(filePath,content,allowedRoot,expectedDirIdentity=null){
  const handle=await openVerifiedPrivateFile(filePath,allowedRoot,fsConstants.O_EXCL,expectedDirIdentity)
  try{
    await handle.writeFile(content)
  }finally{await handle.close()}
}

export async function appendPrivateFile(filePath,content,allowedRoot,expectedDirIdentity=null){
  const handle=await openVerifiedPrivateFile(filePath,allowedRoot,fsConstants.O_APPEND,expectedDirIdentity)
  try{
    await handle.writeFile(content)
  }finally{await handle.close()}
}

export async function privateWebFixture({root,project,storageState,out,origin}){
  const rootReal=await realpath(root)
  const target=await realpath(path.join(rootReal,'target/rune-web-tests'))
  assert(inside(rootReal,target),'Fixture test root must stay inside the canonical worktree')
  const directory=await realpath(project),profile=path.dirname(path.dirname(directory))
  assert(inside(target,profile)&&path.basename(profile).startsWith('launcher-')&&path.basename(directory)==='synthetic','Use the isolated launcher fixture project')
  const storage=await realpath(storageState)
  assert(inside(profile,storage),'Cookies must come from this private fixture profile')
  const auth=JSON.parse(await readFile(storage,'utf8'))
  const parsedOrigin=new URL(origin)
  assert(parsedOrigin.hostname==='127.0.0.1'&&['http:','https:'].includes(parsedOrigin.protocol),'Private 127.0.0.1 fixture origin required')
  assert(Array.isArray(auth.cookies)&&auth.cookies.length>0,'Private 127.0.0.1 cookie state only')
  const seenNames=new Set()
  for(const c of auth.cookies){
    assert(c.domain==='127.0.0.1'&&(!c.path||c.path==='/'),'Private 127.0.0.1 root-scoped cookie state only')
    assert(typeof c.name==='string'&&c.name.length>0&&!seenNames.has(c.name),'Ambiguous duplicate cookie name in fixture storage state')
    seenNames.add(c.name)
  }
  assert((auth.origins??[]).every(o=>o.origin===origin),'Private 127.0.0.1 cookie state only')
  const output=path.resolve(out)
  const parent=await realpath(path.dirname(output))
  const leaf=await lstat(output).catch(error=>{if(error.code!=='ENOENT')throw error})
  assert((parent===profile||inside(profile,parent))&&(!leaf||leaf.isDirectory()&&!leaf.isSymbolicLink()),
    'Output must stay in the private fixture profile')
  return {profile,storage,project:directory,inside,rootReal}
}
export async function bundleAssetPaths(directory){
  const manifest=JSON.parse(await readFile(path.join(directory,'bundle-manifest.json'),'utf8'))
  assert.equal(manifest.generator,'scripts/rune/bundle-web.mjs')
  assert(Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=4096,'Bounded bundle file manifest required')
  const paths=new Set(['/'])
  for(const entry of manifest.files){
    assert(typeof entry.file==='string'&&entry.file.length<=1024&&!entry.file.includes('\\')&&entry.file.split('/').every(part=>part&&part!=='.'&&part!=='..'),'Invalid bundle asset path')
    const url='/'+entry.file.split('/').map(encodeURIComponent).join('/')
    assert(!/^\/(api|workspaces)(?:\/|$)/.test(url),'Bundle assets cannot claim protected routes')
    assert(!paths.has(url),'Duplicate bundle asset path');paths.add(url)
  }
  return paths
}
function hidesFixtureThinking(body){
  const settings=body?.settings, defaults=settings?.toolCallExpansionDefaults
  const expanded=mode=>mode==='expanded'||mode==='collapsed'
  const visibility=mode=>expanded(mode)||mode==='hidden'
  return settings?.showThinkingBlocks===false&&Object.keys(body).length===1&&
    Object.keys(settings).every(key=>['showThinkingBlocks','toolCallExpansionDefaults',
      'toolGroupVisibility','usageMetricsExpansion'].includes(key))&&
    (!Object.hasOwn(settings,'toolGroupVisibility')||visibility(settings.toolGroupVisibility))&&
    (!Object.hasOwn(settings,'usageMetricsExpansion')||expanded(settings.usageMetricsExpansion))&&
    defaults?.preset==='custom'&&expanded(defaults.thinking)&&Object.keys(defaults).length===3&&
    defaults.tools&&Object.entries(defaults.tools).every(([key,mode])=>
      /^(bash|read|write|edit|patch|webfetch|websearch|glob|grep|task|execute|skill|question|invalid|other)$/.test(key)&&visibility(mode))
}

export function workspacePolicy({origin,project,assets=new Set(),androidPrompt,menuPrompt,missions=false,mobilePreferences=false,markerFilters=false,keyboardActions=false,allowOwned}){
  const workspaces=new Set(),claims=new Map(),owners=new Map()
  const historyKeys=new Set(project?[project,path.join(path.dirname(project),'linked')]:[])
  const claim=body=>typeof body?.requestId==='string'&&body.requestId.length>0&&body.requestId.length<=128&&body.requestId.trim()===body.requestId
  const creation=body=>body?.path===project&&claim(body)&&Object.keys(body).every(key=>['path','requestId'].includes(key))
  return {workspaces,
    async request(req,{allowApi=true,forbidRelease=false}={}){
      const requested=new URL(req.url()),protectedRoute=/^\/(api|workspaces)(?:\/|$)/.test(requested.pathname)
      if(requested.origin!==origin)return false
      if(protectedRoute&&(!allowApi||!(await req.allHeaders()).cookie))return false
      let body;try{body=req.postDataJSON()}catch{}
       return this.allows(req.method(),requested.pathname,body,{forbidRelease,query:requested.searchParams})
    },
     allows(method,p,body,{forbidRelease=false,query=new URLSearchParams()}={}){
      if(body&&Buffer.byteLength(JSON.stringify(body))>32768)return false
      if((method==='GET'||method==='HEAD')&&assets.has(p))return true
      if(method==='GET'&&['/api/workspaces','/api/meta','/api/events','/api/auth/status'].includes(p))return true
      if(method==='GET'&&(p==='/api/storage/config/ui'||p==='/api/storage/state/ui'))return true
      if(mobilePreferences&&method==='GET'&&p==='/api/memory/settings')return true
      if(mobilePreferences&&method==='GET'&&p==='/api/filesystem'){
        const leaf=project?path.basename(project):null
        const target=query.get('path')
        return query.get('includeFiles')===''&&[...query.keys()].every(k=>k==='includeFiles'||k==='path')&&
          (target===null||target==='.'||target===leaf)
      }
      if(markerFilters&&method==='PATCH'&&p==='/api/storage/config/ui')
        return !!hidesFixtureThinking(body)
      const history=p.match(/^\/api\/storage\/instances\/([^/]+)$/)
      if(history&&workspaces.size){
        let key
        try{key=decodeURIComponent(history[1])}catch{return false}
        if(method==='GET')return historyKeys.has(key)||workspaces.has(history[1])
        if(method==='PUT'&&typeof menuPrompt==='string')return key===project&&
          body?.messageHistory?.[0]===menuPrompt&&Array.isArray(body.messageHistory)&&
          Object.keys(body).every(key=>['messageHistory','agentModelSelections'].includes(key))
      }
      if(method==='POST'&&p==='/api/client-connections/pong')return true
      if(method==='POST'&&p==='/api/workspaces'&&creation(body)){if(keyboardActions&&(workspaces.size>0||claims.size>0)&&!claims.has(body.requestId))return false;if(!claims.has(body.requestId))claims.set(body.requestId,null);return true}
      if(method==='POST'&&p==='/api/workspaces/creation/cancel')return claim(body)&&claims.has(body.requestId)
      const scoped=p.match(/^\/workspaces\/([^/]+)\/instance\/api\/(.*)$/)
      if(scoped&&workspaces.has(scoped[1])&&allowOwned)
        return allowOwned({method,path:scoped[2],body,query,native:true})
      if(scoped&&workspaces.has(scoped[1])&&method==='GET'&&/^session\/ses_another\/message\/message-0000[01]$/.test(scoped[2]))return true
      if(scoped&&workspaces.has(scoped[1])&&method==='POST'&&scoped[2]==='session/ses_existing/prompt'){
        if(typeof menuPrompt==='string')return body?.text===menuPrompt&&body.delivery==='queue'&&body.resume===false&&
          body.files?.length===1&&body.files[0].name==='mobile-menu.txt'&&body.files[0].uri==='data:text/plain;base64,bWVudSBmaWxl'
        return typeof androidPrompt==='string'&&body?.text===androidPrompt&&Object.keys(body).length===1
      }
      if(keyboardActions&&scoped&&workspaces.size===1&&workspaces.has(scoped[1])&&method==='POST'&&scoped[2]==='session/ses_existing/permission/permission-keyboard/reply')
        return body?.decision==='reject'&&typeof body?.message==='string'
      if(keyboardActions&&scoped&&workspaces.size===1&&workspaces.has(scoped[1])&&method==='DELETE'&&scoped[2]==='session/ses_another/form/form-keyboard')
        return true
      if(scoped&&workspaces.has(scoped[1])&&method==='GET')return /^(command|model|session)$/.test(scoped[2])||/^session\/(ses_existing|ses_another|ses_linked|ses_linked_next)(?:\/(permission|form|inbox))?$/.test(scoped[2])
       const owned=p.match(/^\/api\/workspaces\/([^/]+)(?:\/(.*))?$/)
       if(!owned||!workspaces.has(owned[1]))return false
       if(method==='POST'&&owned[2]==='creation/release')return claim(body)&&owners.get(owned[1])===body.requestId
       if(method==='DELETE'&&!owned[2])return !forbidRelease
       if(allowOwned)return allowOwned({method,path:owned[2]??'',body,query,native:false})
      if(method==='GET'&&['worktrees','pending-requests'].includes(owned[2]))return true
      if(method==='GET'&&/^sessions\/(ses_existing|ses_another|ses_linked|ses_linked_next)\/permission-(?:mode|receipts)$/.test(owned[2]))return true
      if(method==='POST'&&['session-history/window','session-history/outline'].includes(owned[2]))return ['ses_existing','ses_another','ses_linked','ses_linked_next'].includes(body?.sessionID)
      if(method==='POST'&&owned[2]==='session-history/outlinePreview')return body?.sessionID==='ses_existing'
        &&Array.isArray(body.messageIDs)&&body.messageIDs.length>0&&body.messageIDs.length<=12
        &&body.messageIDs.every(id=>typeof id==='string'&&/^(message-\d{5}|timeline-(compaction|system))$/.test(id))
      if(method==='POST'&&owned[2]==='session-history/query')return body?.sessionID==='ses_existing'&&body.purpose==='search'
      if(method==='POST'&&owned[2]==='session-history/ranked')return body?.version===1&&body.limit===40
      if(missions&&method==='POST'&&owned[2]==='missions/gamma/control')return ['start','pause','stop'].includes(body?.action)&&
        Number.isSafeInteger(body.expectedRevision)&&body.expectedRevision>0&&typeof body.requestId==='string'&&/^[a-f0-9-]{36}$/.test(body.requestId)&&
        Object.keys(body).every(key=>['action','expectedRevision','requestId','graceful'].includes(key))&&
        (body.graceful===undefined||body.action==='pause'&&body.graceful===true)
      if(missions&&method==='POST'&&owned[2]==='missions/panel-page'){
        if(body?.source==='mission')return body.header===true&&['alpha','beta','gamma'].includes(body.missionID)||
          body.missionID==='gamma'&&body.field==='control'&&['receipts','pending'].includes(body.part)&&[0,50].includes(body.window?.offset)
        if(body?.source==='activity')return body.actorOffset===0&&['alpha','beta','gamma'].includes(body.missionID)
        if(body?.source==='tasks')return body.task?.missionID==='gamma'&&
          ([0,50].includes(body.task.offset)||body.task.attention===0||body.task.ids?.length===1&&body.task.ids[0]==='tsk-51')
        return ['summaries','cleanups'].includes(body?.source)&&Number.isSafeInteger(body?.window?.offset)
      }
       return false
    },
    admit(input,body,responseUrl){
      assert.equal(new URL(responseUrl).origin,origin,'Workspace response changed origin')
      assert(creation(input)&&claims.has(input.requestId),'Workspace creation was not authorized')
      assert(typeof body?.id==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(body.id),'Invalid private workspace identity')
      assert.equal(body.requestId,input.requestId,'Workspace creation claim mismatch')
      assert.equal(body.location?.directory,project,'Workspace belongs to another project')
      assert(!Object.hasOwn(body.location,'workspaceID'),'Foreign native workspace location')
      assert(!owners.has(body.id)||owners.get(body.id)===input.requestId,'Workspace identity belongs to another claim')
      assert(claims.get(input.requestId)===null||claims.get(input.requestId)===body.id,'Creation claim changed workspace identity')
      assert(!keyboardActions||workspaces.size===0||workspaces.has(body.id),'Keyboard viewport policy admits one workspace per context')
      claims.set(input.requestId,body.id);owners.set(body.id,input.requestId);workspaces.add(body.id)
      return body.id
    },
  }
}
export async function fulfillWorkspaceCreation(route,policy){
  const response=await route.fetch({maxRedirects:0,timeout:30000})
  let admission={}
  if(response.ok()){
    const bytes=await response.body();assert(bytes.length<=1048576,'Workspace response exceeds fixture admission bound')
    const workspaceId=policy.admit(route.request().postDataJSON(),JSON.parse(bytes.toString('utf8')),response.url())
    admission={workspaceId,admittedBeforeFulfill:true}
  }
  await route.fulfill({response})
  return admission
}
