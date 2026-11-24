import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
import {bundleAssetPaths,workspacePolicy,fulfillWorkspaceCreation} from './web-workspace-policy.mjs'

const origin='http://127.0.0.1:12345',project='D:/private/projects/synthetic'
async function handler(file,assets,connected=true){
  const text=await readFile(new URL(file,import.meta.url),'utf8'),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),callbacks=[]
  const visit=node=>{if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='route'&&node.arguments[0]?.text==='**/*')callbacks.push(node.arguments[1]);ts.forEachChild(node,visit)};visit(ast)
  assert.equal(callbacks.length,1);assert(ts.isArrowFunction(callbacks[0]))
  const policy=workspacePolicy({origin,project,assets}),input={path:project,requestId:'owned'}
  policy.allows('POST','/api/workspaces',input);policy.admit(input,{id:'one',requestId:'owned',location:{directory:project}},origin)
  const callback=new Function('assert','url','values','policy','routes','errors','forbiddenRequests','fulfillWorkspaceCreation','record','stamp','forbidRelease','missions','holdOlder','holdAnchor','holdPreview','outlineGate',`return (${callbacks[0].getText(ast)})`)(assert,new URL(origin),{connected,project},policy,[],[],[],fulfillWorkspaceCreation,{requests:[],forbidden:[],errors:[]},()=>1,false,null,undefined,undefined,undefined,undefined)
  return async(method,pathname,{cookie='private=fixture',body,base=origin}={})=>{
    let disposition
    await callback({request:()=>({url:()=>new URL(pathname,base).href,method:()=>method,postDataJSON:()=>body,allHeaders:async()=>({cookie})}),continue:async()=>{disposition='continued'},abort:async()=>{disposition='aborted'},fetch:async()=>{throw Error('The boundary reproduction must never use the network')}})
    return disposition
  }
}
for(const file of ['web-smoke.mjs','web-restore.mjs'])test(`${file}: real route callback closes every relay and mutation boundary`,async()=>{
  const assets=new Set(['/','/boot.js','/nested/bridge.js','/Inter-Regular.ttf']),route=await handler(file,assets)
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS'])for(const address of ['/sidecars/foreign/action','/','/boot.js','/nested/bridge.js'])assert.equal(await route(method,address),'aborted',`${method} ${address}`)
  for(const address of ['/sidecars/foreign/action','/unknown.js','/nested/foreign.js','/nested/bridge.js/extra','/api','/workspaces','/api/session','/api/workspaces/foreign'])assert.equal(await route('GET',address),'aborted',address)
  for(const method of ['GET','HEAD'])for(const address of assets)assert.equal(await route(method,address,{cookie:''}),'continued',`${method} listed ${address}`)
  assert.equal(await route('HEAD','/api/meta'),'aborted')
  assert.equal(await route('GET','/boot.js',{base:'http://localhost:12345'}),'aborted','Another loopback origin is foreign')
  assert.equal(await route('GET','data:text/plain,foreign'),'aborted','Non-HTTP URLs have no bundle authority')
  assert.equal(await route('GET','/api/meta',{cookie:''}),'aborted','Protected reads require the fixture cookie')
  assert.equal(await route('GET','/api/meta'),'continued')
  assert.equal(await route('GET','/workspaces/one/instance/api/session/ses_existing'),'continued')
  assert.equal(await route('POST','/workspaces/one/instance/api/session/ses_existing/prompt',{body:{text:'forbidden'}}),'aborted')
   assert.equal(await route('POST','/api/workspaces/one/session-history/window',{body:{sessionID:'ses_existing'}}),'continued')
  assert.equal(await route('POST','/api/workspaces/one/missions/panel-page',{body:{source:'summaries',window:{offset:0}}}),'aborted')
  assert.equal(await route('POST','/api/workspaces/one/creation/release',{body:{requestId:'owned'}}),'continued')
  assert.equal(await route('DELETE','/api/workspaces/one'),'continued')
  assert.equal(await route('POST','/api/workspaces/one/creation/release',{body:{requestId:'foreign'}}),'aborted')
  if(file==='web-smoke.mjs'){
    const offline=await handler(file,assets,false)
    assert.equal(await offline('GET','/api/meta'),'aborted')
    assert.equal(await offline('GET','/boot.js'),'continued')
  }
})
test('static authority comes from exact safe paths in the owned bundle manifest',async()=>{
  const target=fileURLToPath(new URL('../../target/',import.meta.url));await mkdir(target,{recursive:true})
  const directory=await mkdtemp(path.join(target,'web-policy-manifest-')),file=path.join(directory,'bundle-manifest.json')
  const put=files=>writeFile(file,JSON.stringify({generator:'scripts/rune/bundle-web.mjs',files:files.map(file=>({file}))}))
  try{
    await put(['boot.js','nested/bridge.js','Inter-Regular.ttf'])
    assert.deepEqual([...await bundleAssetPaths(directory)],['/','/boot.js','/nested/bridge.js','/Inter-Regular.ttf'])
    for(const files of [[],['../sidecars/action'],['/api/meta'],['api/meta'],['nested\\escape.js'],['boot.js','boot.js']]){await put(files);await assert.rejects(bundleAssetPaths(directory))}
  }finally{assert.equal(path.dirname(directory),path.resolve(target));await rm(directory,{recursive:true,force:true})}
})
