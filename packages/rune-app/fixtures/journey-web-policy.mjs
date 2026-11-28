import assert from 'node:assert/strict'
import {bundleAssetPaths,fulfillWorkspaceCreation,workspacePolicy} from '../../../scripts/rune/web-workspace-policy.mjs'
import {commit,filename,prompt,title} from './journey-host.mjs'

export async function guardJourney(context,{origin,project,web,refused,attestedFetch,cookieHeader}){
  let session, preview
  const fetchOwned=async(route,timeout,maxBytes=1048576)=>{
    if(!attestedFetch){
      const response=await route.fetch({maxRedirects:0,timeout})
      assert.equal(new URL(response.url()).origin,origin)
      const loc=response.headers()['location']
      if(loc)assert.equal(new URL(loc,origin).origin,origin,'Cross-origin redirect forbidden')
      const bytes=await response.body()
      assert(bytes.length<=maxBytes,'Fixture response exceeds byte bound')
      return {status:response.status(),headers:response.headers(),ok:response.ok(),bytes,fulfill:()=>route.fulfill({response})}
    }
    const req=route.request()
    const headers={...(await req.allHeaders())}
    delete headers['host']
    delete headers['content-length']
    if(cookieHeader)headers['cookie']=cookieHeader
    const abort=new AbortController()
    const timer=setTimeout(()=>abort.abort(Error('Owned fixture fetch timed out')),timeout)
    try{
      const response=await attestedFetch(req.url(),{
        method:req.method(),headers,body:req.postDataBuffer()??undefined,signal:abort.signal,
      })
      const loc=response.headers.get('location')
      if(loc)assert.equal(new URL(loc,origin).origin,origin,'Cross-origin redirect forbidden')
      const contentLength=Number(response.headers.get('content-length')??0)
      if(Number.isFinite(contentLength)&&contentLength>maxBytes){
        abort.abort();void response.body?.cancel?.().catch(()=>{})
        throw Error('Fixture response exceeds byte bound')
      }
      const chunks=[]
      let total=0
      const reader=response.body?.getReader()
      if(reader){
        for(;;){
          const {value,done}=await reader.read()
          if(done)break
          total+=value.byteLength
          if(total>maxBytes){
            abort.abort();void reader.cancel().catch(()=>{})
            throw Error('Fixture response exceeds byte bound')
          }
          chunks.push(Buffer.from(value))
        }
      }
      const bytes=Buffer.concat(chunks,total)
      const outHeaders=Object.fromEntries(response.headers.entries())
      return {status:response.status,headers:outHeaders,ok:response.ok,bytes,fulfill:()=>route.fulfill({status:response.status,headers:outHeaders,body:bytes})}
    }finally{clearTimeout(timer)}
  }
  const policy=workspacePolicy({origin,project,assets:await bundleAssetPaths(web),directoryBrowser:true,allowOwned({method,path,body,query,native}){
    if(native){
      if(query.has('directory')&&query.get('directory')!==project)return false
      if(method==='GET')return /^(agent|command|model(?:\/default)?|provider|location|project|session|session\/active|vcs\/status)$/.test(path)
        || Boolean(session&&[`session/${session}`,`session/${session}/permission`,`session/${session}/form`].includes(path))
      if(method!=='POST')return false
      if(path==='session')return !session&&body?.title===title
      if(!session)return false
      if(path===`session/${session}/prompt`)return body?.text===prompt
      return new RegExp(`^session/${session}/permission/per_[\\w-]+/reply$`).test(path)&&body?.decision==='once'
    }
    if(method==='POST'&&path==='session-history/window')return Boolean(session&&body?.sessionID===session)
    if(method==='GET'&&['','worktrees','pending-requests'].includes(path))return true
    if(method==='GET'&&session&&[`sessions/${session}/permission-mode`,`sessions/${session}/permission-receipts`].includes(path))return true
    if(method==='GET'&&path==='files')return query.get('directory')===project&&[null,'.',''].includes(query.get('path'))
    if(method==='GET'&&path==='files/preview')return query.get('directory')===project&&query.get('path')===filename
    if(method==='GET'&&path==='worktrees/root/git-diff')return query.get('path')===filename&&['staged','unstaged'].includes(query.get('scope'))
    if(method==='GET')return /^worktrees\/root\/git-(status|history)$/.test(path)
    if(method==='POST'&&path==='worktrees/root/git-stage')return Array.isArray(body?.paths)&&body.paths.length===1&&body.paths[0]===filename
    return method==='POST'&&path==='worktrees/root/git-commit'&&body?.message===commit
  }})
  await context.routeWebSocket('**/*',async socket=>{
    const url=new URL(socket.url())
    refused.push({method:'WebSocket',origin:url.origin,path:url.pathname})
    await socket.close({code:1008,reason:'Unexpected fixture WebSocket'})
  })
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url())
    try{
      if(await policy.request(req)){
        if(req.method()==='POST'&&url.pathname==='/api/workspaces'){
          if(attestedFetch){
            const response=await fetchOwned(route,30000)
            if(response.ok){
              assert(response.bytes.length<=1048576,'Workspace response exceeds fixture admission bound')
              policy.admit(req.postDataJSON(),JSON.parse(response.bytes.toString('utf8')),req.url())
            }
            await response.fulfill()
          }else{
            await fulfillWorkspaceCreation(route,policy)
          }
          return
        }
        if(req.method()==='POST'&&/^\/workspaces\/[^/]+\/instance\/api\/session$/.test(url.pathname)){
          const response=await fetchOwned(route,20000,64*1024-1)
          if(response.ok){
            const result=JSON.parse(response.bytes.toString()).data
            assert.match(result?.id,/^ses_[\w-]+$/)
            assert.equal(result.title,title)
            session=result.id
          }
          await response.fulfill()
          return
        }
        if(req.method()==='GET'&&url.pathname.endsWith('/files/preview')){
          const response=await fetchOwned(route,15000,64*1024-1)
          preview={status:response.status,file:JSON.parse(response.bytes.toString())}
          await response.fulfill()
          return
        }
        await route.continue()
        return
      }
    }catch(error){refused.push({admission:error.message})}
    refused.push({method:req.method(),origin:url.origin,path:url.pathname})
    await route.abort('blockedbyclient')
  })
  return {preview:()=>preview}
}
