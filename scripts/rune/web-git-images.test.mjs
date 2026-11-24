import assert from 'node:assert/strict'
import {test} from 'node:test'
import {gitImageReadAllowed} from './web-git-images.mjs'

test('Git image fixture only admits authenticated reads of its private checkout',async()=>{
  const origin='http://127.0.0.1:54321',project='D:/private/synthetic',workspaces=new Set(['owned'])
  const route='/api/workspaces/owned/worktrees/root/git-diff?scope=unstaged&path=sample.avif'
  const read=(pathname,{base=origin,method='GET',cookie='fixture=1'}={})=>gitImageReadAllowed({
    url:()=>base+pathname,method:()=>method,allHeaders:async()=>({cookie}),
  },{origin,project,workspaces})
  assert(await read(route))
  assert(!await read(route,{method:'POST'}))
  assert(!await read(route,{cookie:''}))
  assert(!await read(route,{base:'http://localhost:54321'}))
  assert(!await read(route.replace('/owned/','/foreign/')))
  assert(!await read(route.replace('/root/','/other/')))
  assert(!await read(route.replace('scope=unstaged','scope=staged')))
  assert(!await read(route.replace('sample.avif','other.svg')))
  assert(!await read(`${route}&path=other.svg`))
  assert(await read(`/api/workspaces/owned/files?path=.&directory=${encodeURIComponent(project)}`))
  assert(!await read(`/api/workspaces/owned/files?path=..&directory=${encodeURIComponent(project)}`))
  assert(!await read('/api/workspaces/owned/files?path=.&directory=outside'))
})
