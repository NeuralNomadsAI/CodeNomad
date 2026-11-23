import assert from 'node:assert/strict'
import {readFile,realpath} from 'node:fs/promises'
import path from 'node:path'

const inside=(parent,value)=>{const relative=path.relative(parent,value);return relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)}
export async function privateWebFixture({root,project,storageState,out,origin}){
  const target=await realpath(path.join(root,'target/rune-web-tests'))
  const directory=await realpath(project),profile=path.dirname(path.dirname(directory))
  assert(inside(target,profile)&&path.basename(profile).startsWith('launcher-')&&path.basename(directory)==='synthetic','Use the isolated launcher fixture project')
  const storage=await realpath(storageState)
  assert(inside(profile,storage),'Cookies must come from this private fixture profile')
  const auth=JSON.parse(await readFile(storage,'utf8'))
  assert(auth.cookies.length>0&&auth.cookies.every(c=>['127.0.0.1','localhost','::1'].includes(c.domain))&&(auth.origins??[]).every(o=>o.origin===origin),'Private loopback cookie state only')
  assert(inside(profile,path.resolve(out)),'Output must stay in the private fixture profile')
  return {profile,storage,project:directory,inside}
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
export function workspacePolicy({origin,project,assets=new Set(),androidPrompt,missions=false}){
  const workspaces=new Set(),claims=new Map(),owners=new Map()
  const claim=body=>typeof body?.requestId==='string'&&body.requestId.length>0&&body.requestId.length<=128&&body.requestId.trim()===body.requestId
  const creation=body=>body?.path===project&&claim(body)&&Object.keys(body).every(key=>['path','requestId'].includes(key))
  return {workspaces,
    async request(req,{allowApi=true,forbidRelease=false}={}){
      const requested=new URL(req.url()),protectedRoute=/^\/(api|workspaces)(?:\/|$)/.test(requested.pathname)
      if(requested.origin!==origin)return false
      if(protectedRoute&&(!allowApi||!(await req.allHeaders()).cookie))return false
      let body;try{body=req.postDataJSON()}catch{}
      return this.allows(req.method(),requested.pathname,body,{forbidRelease})
    },
    allows(method,p,body,{forbidRelease=false}={}){
      if(body&&Buffer.byteLength(JSON.stringify(body))>32768)return false
      if((method==='GET'||method==='HEAD')&&assets.has(p))return true
      if(method==='GET'&&['/api/workspaces','/api/meta','/api/events','/api/auth/status'].includes(p))return true
      if(method==='GET'&&(p==='/api/storage/config/ui'||p==='/api/storage/state/ui'))return true
      if(method==='POST'&&p==='/api/client-connections/pong')return true
      if(method==='POST'&&p==='/api/workspaces'&&creation(body)){if(!claims.has(body.requestId))claims.set(body.requestId,null);return true}
      if(method==='POST'&&p==='/api/workspaces/creation/cancel')return claim(body)&&claims.has(body.requestId)
      const scoped=p.match(/^\/workspaces\/([^/]+)\/instance\/api\/(.*)$/)
      if(scoped&&workspaces.has(scoped[1])&&method==='GET'&&scoped[2]==='session/ses_another/message/message-00000')return true
      if(scoped&&workspaces.has(scoped[1])&&method==='POST'&&scoped[2]==='session/ses_existing/prompt')
        return typeof androidPrompt==='string'&&body?.text===androidPrompt&&Object.keys(body).length===1
      if(scoped&&workspaces.has(scoped[1])&&method==='GET')return /^(command|model|session)$/.test(scoped[2])||/^session\/(ses_existing|ses_another|ses_linked|ses_linked_next)(?:\/(permission|form))?$/.test(scoped[2])
      const owned=p.match(/^\/api\/workspaces\/([^/]+)(?:\/(.*))?$/)
      if(!owned||!workspaces.has(owned[1]))return false
      if(method==='GET'&&owned[2]==='worktrees')return true
      if(method==='POST'&&['session-history/window','session-history/outline'].includes(owned[2]))return ['ses_existing','ses_another','ses_linked','ses_linked_next'].includes(body?.sessionID)
      if(method==='POST'&&owned[2]==='session-history/outlinePreview')return body?.sessionID==='ses_existing'
        &&Array.isArray(body.messageIDs)&&body.messageIDs.length>0&&body.messageIDs.length<=12
        &&body.messageIDs.every(id=>typeof id==='string'&&/^(message-\d{5}|timeline-(compaction|system))$/.test(id))
      if(method==='POST'&&owned[2]==='session-history/query')return body?.sessionID==='ses_existing'&&body.purpose==='search'
      if(method==='POST'&&owned[2]==='session-history/ranked')return body?.version===1&&body.limit===40
      if(missions&&method==='POST'&&owned[2]==='missions/panel-page'){
        if(body?.source==='mission')return body.header===true&&['alpha','beta','gamma'].includes(body.missionID)
        if(body?.source==='activity')return body.actorOffset===0&&['alpha','beta','gamma'].includes(body.missionID)
        if(body?.source==='tasks')return body.task?.missionID==='gamma'&&
          ([0,50].includes(body.task.offset)||body.task.attention===0||body.task.ids?.length===1&&body.task.ids[0]==='tsk-51')
        return ['summaries','cleanups'].includes(body?.source)&&Number.isSafeInteger(body?.window?.offset)
      }
      if(method==='POST'&&owned[2]==='creation/release')return claim(body)&&owners.get(owned[1])===body.requestId
      return method==='DELETE'&&!owned[2]&&!forbidRelease
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
