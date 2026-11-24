import assert from 'node:assert/strict'
import {bundleAssetPaths,fulfillWorkspaceCreation,workspacePolicy} from '../../../scripts/rune/web-workspace-policy.mjs'
import {commit,filename,prompt,title} from './journey-host.mjs'

export async function guardJourney(context,{origin,project,web,refused}){
  let session, preview
  const policy=workspacePolicy({origin,project,assets:await bundleAssetPaths(web),allowOwned({method,path,body,query,native}){
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
          await fulfillWorkspaceCreation(route,policy)
          return
        }
        if(req.method()==='POST'&&/^\/workspaces\/[^/]+\/instance\/api\/session$/.test(url.pathname)){
          const response=await route.fetch({maxRedirects:0,timeout:20000})
          assert.equal(new URL(response.url()).origin,origin)
          const loc=response.headers()['location']
          if(loc)assert.equal(new URL(loc,origin).origin,origin,'Cross-origin redirect forbidden')
          if(response.ok()){
            const bytes=await response.body()
            assert(bytes.length<64*1024,'Bounded session creation response required')
            const result=JSON.parse(bytes.toString()).data
            assert.match(result?.id,/^ses_[\w-]+$/)
            assert.equal(result.title,title)
            session=result.id
          }
          await route.fulfill({response})
          return
        }
        if(req.method()==='GET'&&url.pathname.endsWith('/files/preview')){
          const response=await route.fetch({maxRedirects:0,timeout:15000})
          assert.equal(new URL(response.url()).origin,origin)
          const loc=response.headers()['location']
          if(loc)assert.equal(new URL(loc,origin).origin,origin,'Cross-origin redirect forbidden')
          const bytes=await response.body()
          assert(bytes.length<64*1024,'Bounded fixture file preview required')
          preview={status:response.status(),file:JSON.parse(bytes)}
          await route.fulfill({response})
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
