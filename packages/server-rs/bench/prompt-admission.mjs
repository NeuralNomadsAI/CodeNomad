// Real HTTP servers, independent recording OpenCode substitutes, no provider or service discovery.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {spawnFixtureChild as spawn} from '../../../scripts/native-fixture-guards.mjs'
import {createHash, randomUUID} from 'node:crypto'
import {createServer, request as httpRequest} from 'node:http'
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {privateEnvironment} from '../../rune-app/fixtures/private-profile.mjs'
import {sanitizeBenchEnvPath} from './private-profile.mjs'
import {out, repo, rustBinary} from './fixtures.mjs'

const post = body => ({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
const canonical = value => Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
// GIT_CEILING_DIRECTORIES makes strict TS discovery inconclusive in this fixture.
const assertIndependentRefusal = (label, body) => assert.deepEqual(body, {
  error:'Session does not belong to workspace', ...(label==='rs'?{reason:'session_located_elsewhere'}:{}),
})
const digest = body => createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex')
const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)))
const close = server => new Promise(resolve => {server.closeAllConnections();server.close(resolve)})
const data = size => `data:application/octet-stream;base64,${Buffer.alloc(size,97).toString('base64')}`
const http = (url,init={}) => new Promise((resolve,reject)=>{
  let responded=false
  const request=httpRequest(url,{method:init.method??'GET',headers:{...init.headers,...(init.chunked?{'transfer-encoding':'chunked'}:init.body!==undefined?{'content-length':Buffer.byteLength(init.body)}:{})}},response=>{
    responded=true
    const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,
      headers:{get:key=>response.headers[key]},text:async()=>Buffer.concat(chunks).toString(),arrayBuffer:async()=>Buffer.concat(chunks)}))
  });request.on('error',error=>{if(!responded)resolve({status:error.code??String(error),headers:{get:()=>null},text:async()=>'',arrayBuffer:async()=>{}})});request.setTimeout(30000,()=>request.destroy(Error('HTTP deadline')))
  const body=Buffer.from(init.body??'');(async()=>{for(let at=0;at<body.length&&!responded;at+=262144){
    if(at+262144>=body.length){request.end(body.subarray(at));return}
    request.write(body.subarray(at,at+262144));await delay(1)
  }request.end()})().catch(reject)
})

async function upstream(profile) {
  const directory = path.join(profile,'workspace'), foreign = path.join(profile,'foreign'),tree=path.join(profile,'tree')
  const plain=path.join(profile,'plain'), plainNested=path.join(plain,'sub')
  await mkdir(plainNested,{recursive:true})
  await mkdir(directory);await mkdir(foreign)
  await writeFile(path.join(foreign,'private.txt'),'Synthetic foreign file.\n')
  await writeFile(path.join(directory,'a b#%.txt'),'synthetic\n')
  await mkdir(path.join(directory,'sub'))
  const env=await privateEnvironment(profile)
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(profile,'private.gitconfig')})
  const git=(...args)=>promisify(execFile)('git',args,{env,cwd:profile,windowsHide:true})
  await git('init','--quiet',directory)
  await git('-C',directory,'-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','--quiet','--allow-empty','-m','synthetic')
  await git('-C',directory,'worktree','add','--quiet','--detach',tree,'HEAD')
  await writeFile(path.join(tree,'tree.txt'),'synthetic tree\n')
  const treeNested=path.join(tree,'sub'), independent=path.join(tree,'independent')
  const treeHeadDir=path.join(tree,'head-directory')
  const localTree=path.join(directory,'.codenomad','worktrees','nested')
  const localIndependent=path.join(localTree,'independent')
  await mkdir(path.dirname(localTree),{recursive:true})
  await git('-C',directory,'worktree','add','--quiet','--detach',localTree,'HEAD')
  await mkdir(treeNested)
  await mkdir(path.join(treeNested,'.git','objects'),{recursive:true})
  await mkdir(path.join(treeNested,'.git','refs'))
  await writeFile(path.join(treeNested,'.git','HEAD'),'ref: invalid\n')
  for(const entry of ['objects','refs','HEAD']) await mkdir(path.join(treeHeadDir,'.git',entry),{recursive:true})
  await git('init','--quiet',independent)
  await git('init','--quiet',localIndependent)
  const calls = [], sessions = new Map(), password = randomUUID(),state={carrier:'absent'}
  for (const [id,dir,metadata] of [['ses_owned',directory,{}],['ses_nested',path.join(directory,'sub'),{}],['ses_tree',tree,{}],['ses_foreign',foreign,{}],['ses_cn_schedule_reserved',directory,{}],['ses_carrier',directory,{'codenomad.schedule-carrier':true}]])
    sessions.set(id,{id,title:'Synthetic',projectID:'project_fixture',location:{directory:dir},metadata,time:{created:1,updated:1}})
  sessions.set('ses_plain',{id:'ses_plain',title:'Synthetic without Git',projectID:'global',location:{directory:plainNested},time:{created:1,updated:1}})
  for(const [id,dir] of [['ses_tree_nested',treeNested],['ses_tree_head_dir',treeHeadDir],['ses_independent',independent],['ses_local_independent',localIndependent]])
    sessions.set(id,{id,title:'Synthetic checkout',projectID:'project_fixture',location:{directory:dir},time:{created:1,updated:1}})
  const server = createServer(async(req,res)=>{
    try {
      assert.equal(req.headers.authorization,`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`)
      const url = new URL(req.url,'http://fixture'), chunks=[]
      for await(const chunk of req) chunks.push(chunk)
      const raw=Buffer.concat(chunks).toString(),body=raw?JSON.parse(raw):undefined
      calls.push({method:req.method,path:url.pathname,body})
      const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}
       if(url.pathname==='/api/info')return send({version:'2.4.2',pid:process.pid})
       if(url.pathname==='/api/config')return send([{type:'directory',path:path.join(profile,'config')}])
      if(url.pathname==='/api/event'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': isolated\n\n');return}
      if(url.pathname==='/api/location'){
        const local=url.searchParams.get('location[directory]')??directory
        const noGit=local===plain||local===plainNested
        return send({directory:local,project:{id:noGit?'global':'project_fixture',canonical:noGit?plain:directory,directory:local}})
      }
      if(url.pathname==='/api/worktree')return send([{directory},{directory:tree},{directory:localTree}])
      if(url.pathname==='/api/worktree/refresh'){res.writeHead(204);return res.end()}
      if(url.pathname==='/api/project')return send([{id:'project_fixture',canonical:directory,sandboxes:[],time:{created:1,updated:1}}])
      if(url.pathname==='/api/session/active')return send({data:{}})
      if(url.pathname==='/api/session')return send({data:[],cursor:{}})
      if(url.pathname.endsWith('/scheduleCarrierRead')){
        if(state.carrier==='owned')return send({output:{owned:true}})
        if(state.carrier==='unavailable')return send({error:'Synthetic unavailable'},503)
        if(state.carrier==='move')sessions.get('ses_owned').location.directory=foreign
      }
      if(url.pathname.startsWith('/api/rpc/'))return send({_tag:'RpcError',type:'rpc.method_not_found',message:'Fixture plugin absent'},400)
       const match=url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/)
       if(match){const session=sessions.get(match[1]);if(!session)return send({type:'session.not_found'},404)
         if(match[2]==='revert/stage' && req.method==='POST'){
           if(body.messageID==='busy')return send({_tag:'SessionBusyError',sessionID:session.id,message:'Busy'},409)
           session.revert={messageID:body.messageID}
           return send({data:session.revert})
         }
         if(match[2]==='revert' && req.method==='DELETE'){
           delete session.revert
           res.writeHead(204);return res.end()
         }
         if(match[2]==='fork' && req.method==='POST'){
           const copy={...session,id:'ses_copy',fork:{sessionID:session.id,boundary:{type:'through',messageID:'appended'}}}
           sessions.set(copy.id,copy)
           return send({data:copy})
         }
         if(!match[2] && req.method==='DELETE' && session.fork){
           sessions.delete(session.id);res.writeHead(204);return res.end()
         }
         if(!match[2])return send({data:session})
        if(match[2]==='environment'){res.writeHead(204);return res.end()}
        if(match[2]==='prompt')return send({data:{id:body.id??`inbox_${calls.length}`,sessionID:session.id,type:'user',payload:body}})
        if(match[2]==='command'){
          if(typeof body.name!=='string'||typeof body.text!=='string')return send({error:'Invalid native command input'},400)
          res.writeHead(204);return res.end()
        }
        if(match[2]==='interrupt')return send({data:true})
      }
      return send({data:[]})
    }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}))}
  })
  return {directory,foreign,tree,plain,calls,password,state,sessions,origin:await listen(server),close:()=>close(server)}
}

async function start(label,profile,native) {
  const env=await sanitizeBenchEnvPath(await privateEnvironment(profile),{allowedRoot:profile}),password=randomUUID(),config=path.join(profile,'config/config.yaml')
  await writeFile(config,`server:\n  opencodeBinary: ${JSON.stringify(path.join(profile,'disabled-opencode.exe'))}\n  environmentVariables:\n    FIXTURE_SETTING: "profile"\n`)
  Object.assign(env,{CLI_CONFIG:config,CNRS_FIXTURE_URL:native.origin+'/',CNRS_FIXTURE_PASSWORD:native.password,
    CNRS_FIXTURE_PID:String(process.pid),CNRS_SERVER_PASSWORD:password,CODENOMAD_SERVER_PASSWORD:password,
    CNRS_FIXTURE_STDIN_STOP:'1',CODENOMAD_NATIVE_BROWSER_AUTOMATION:'0'})
  const probe=createServer(),reserved=await listen(probe),port=new URL(reserved).port;await close(probe)
  const args=label==='ts'?[path.join(repo,'packages/server-rs/bench/ts-server.mjs'),'--http','true','--https','false','--http-port',port,
    '--ui-no-update','--config',config,'--workspace-root',profile]:[profile,path.join(profile,'rust.json'),port,'']
  const child=spawn(label==='ts'?process.execPath:rustBinary(),args,{cwd:profile,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
  let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{if(log.length<2**20)log+=chunk})
  const exit=new Promise(resolve=>child.once('close',resolve));child.stdin.on('error',()=>{})
  const origin=`http://127.0.0.1:${port}`
  const request=(route,init={})=>http(origin+route,init)
  const stop=async()=>{if(child.exitCode===null){child.stdin.end(label==='ts'?'codenomad:shutdown\n':'shutdown\n');await Promise.race([exit,delay(2000)])}
    if(child.exitCode===null){child.kill();await exit}await writeFile(path.join(profile,`${label}.log`),log.replaceAll(password,'<redacted>').replaceAll(native.password,'<redacted>'))}
  try{
    for(const end=Date.now()+60000;;await delay(100)){
      if((await request('/api/auth/status').catch(()=>undefined))?.status===200)break
      assert(child.exitCode===null&&Date.now()<end,`${label} startup failed: ${log.slice(-1800)}`)
    }
    const login=await request('/api/auth/login',post({username:'codenomad',password}));assert.equal(login.status,200)
    const cookie=String(login.headers.get('set-cookie')).split(';')[0]
    const call=(route,init={})=>request(route,{...init,headers:{...init.headers,cookie}})
    const opened=await call('/api/workspaces',post({path:native.directory}));const text=await opened.text()
    assert.equal(opened.status,201,`${label} workspace: ${text}`)
    return {call,base:`/workspaces/${JSON.parse(text).id}/instance/api`,config,stop}
  }catch(error){await stop();throw error}
}

function cases(native){
  const file=path.join(native.directory,'a b#%.txt'),uri=pathToFileURL(file)
  const mib=1024*1024
  return [
    ['text-first',{text:'first',id:'inbox_first'}],['text-second',{text:'second',id:'inbox_second'}],
    ['all-fields',{text:'context',files:[{uri:uri.href,source:{type:'uri',uri:uri.href},name:'a b#%.txt',description:'fixture',mention:{start:0,end:7,text:'context'}}],agents:[{name:'build'}],skills:[{id:'fixture'}],metadata:{display:'fixture'},resume:false,id:'inbox_context',delivery:'queue'}],
    ['inline',{text:'bytes',files:[{uri:data(1024*1024)}]}],
    ['project-path',{text:'path',files:[{uri:file}]}],['remote-uri',{text:'remote',files:[{uri:'https://fixture.invalid/resource'}]}],
    ['project-dot-path',{files:[{uri:`${native.directory}/sub/../a b#%.txt`}]}],
    ['worktree-file',{text:'tree',files:[{uri:pathToFileURL(path.join(native.tree,'tree.txt')).href}]}],
    ['uri-count',{files:Array.from({length:11},()=>({uri:uri.href}))}],
    ['file-exact',{files:[{uri:data(5*mib)}]}],['file-over',{files:[{uri:data(5*mib+1)}]}],
    ['count-exact',{files:Array.from({length:10},()=>({uri:data(1)}))}],['count-over',{files:Array.from({length:11},()=>({uri:data(1)}))}],
    ['total-exact',{files:Array.from({length:4},()=>({uri:data(5*mib)}))}],['total-over',{files:[...Array.from({length:4},()=>({uri:data(5*mib)})),{uri:data(1)}]}],
    ['bad-base64',{files:[{uri:'data:text/plain;base64,abc'}]}],['bad-percent',{files:[{uri:'data:text/plain,%zz'}]}],
    ['percent-utf8',{files:[{uri:'data:text/plain,%C3%A9'}]}],['files-object',{files:{}}],['file-null',{files:[null]}],['file-empty',{files:[{uri:' '}]}],
    ['relative',{files:[{uri:'relative.txt'}]}],['file-query',{files:[{uri:uri.href+'?x=1'}]}],['file-encoded-slash',{files:[{uri:'file:///D:/a%2fb'}]}],
    ['foreign-file',{files:[{uri:path.join(native.foreign,'private.txt')}]}],['foreign-location',{text:'x',location:{directory:native.foreign}}],
    ['selector-directory-foreign',{text:'x',directory:native.foreign},403],['selector-directory-owned',{text:'x',directory:native.directory},200],
    ['selector-workspaceID',{text:'x',workspaceID:'foreign'},400],['selector-workspace',{text:'x',workspace:'foreign'},400],
    ['selector-workspace-null',{text:'x',workspace:null},400],['selector-workspaceID-null',{text:'x',workspaceID:null},400],
    ['selector-directory-invalid',{text:'x',directory:42},400],['selector-directory-null',{text:'x',directory:null},200],
    ['selector-directory-tree',{text:'x',directory:native.tree},200],
    ['selector-location-null',{text:'x',location:null},200],['selector-location-empty',{text:'x',location:{}},200],
    ['selector-location-tree',{text:'x',location:{directory:native.tree}},200],
    ['selector-location-extra',{text:'x',location:{directory:native.directory,future:true}},200],
    ['selector-location-null-directory',{text:'x',location:{directory:null}},200],
    ['selector-location-workspace',{text:'x',location:{workspace:'foreign'}},400],
    ['combined-invalid-location',{text:'x',files:[{uri:'data:;base64,abc'}],location:{directory:native.foreign}},400],
    ['combined-over-location',{text:'x',files:[{uri:data(5*mib+1)}],location:{directory:native.foreign}},413],
    ['carrier-metadata',{text:'x',metadata:{schedule:null}}],['automation-metadata',{text:'x',metadata:{automation:null}}],
    ['carrier-marker',{text:'x',metadata:{'codenomad.schedule-carrier':null}}],['unknown-native-field',{text:'x',future:'kept'}],
    ['json-exact',{text:'x'.repeat(32*mib-11)}],['json-over',{text:'x'.repeat(32*mib-10)}],
  ]
}

export async function run(commandOnly=false){
  const root=await mkdtemp(path.join(out,'trial-prompt-admission-')),result={root,binary:rustBinary(),environments:'real TS/Rust; separate simulated OpenCode; no model',sides:{},errorBodies:{},outsideJson:{}}
  result.binarySha256=createHash('sha256').update(await readFile(result.binary)).digest('hex')
  result.benchSha256=createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex')
  const active=[]
  try{
    for(const label of ['ts','rs']){
      const profile=path.join(root,label);await mkdir(profile)
      const native=await upstream(profile);active.push(()=>native.close())
      const host=await start(label,profile,native);active.push(()=>host.stop())
       const rows=result.sides[label]=[],errors=result.errorBodies[label]={}
       if(process.argv.includes('--message-actions-only')){
         const owned='/session/ses_owned'
         for(const [name, suffix, init, expected, forwards] of [
           ['stage',`${owned}/revert/stage`,post({messageID:'msg_original'}),200,1],
           ['busy',`${owned}/revert/stage`,post({messageID:'busy'}),409,1],
           ['clear',`${owned}/revert`,{method:'DELETE'},204,1],
           ['foreign','/session/ses_foreign/revert/stage',post({messageID:'msg_original'}),403,0],
           ['fork',`${owned}/fork`,post({}),200,1],
           ['remove-copy','/session/ses_copy',{method:'DELETE'},204,1],
         ]){
           const before=native.calls.length
           const response=await host.call(host.base+suffix,init)
           const text=await response.text()
           assert.equal(response.status,expected,`${label}/${name}: ${text}`)
           const sent=native.calls.slice(before).filter(call=>call.path===`/api${suffix}` && call.method===init.method)
           assert.equal(sent.length,forwards,`${label}/${name} native calls`)
           if(name==='stage')assert.equal(JSON.parse(text).data.messageID,'msg_original')
           rows.push({name,status:response.status,forwarded:sent.length})
         }
         assert(native.sessions.has('ses_owned') && !native.sessions.has('ses_copy'))
         assert(!native.sessions.get('ses_owned').revert)
         await host.stop();active.pop();await native.close();active.pop()
         continue
       }
       if(commandOnly){
        await commandCases(label,host,native,rows,errors)
        await host.stop();active.pop();await native.close();active.pop()
        continue
      }
      const inputs=process.argv.includes('--transport-only')?[]:cases(native)
      for(const [name,body,expectedStatus] of process.argv.includes('--admission-order-only')?inputs.filter(([name])=>name.startsWith('combined-')):inputs){
        const before=native.calls.length,response=await host.call(`${host.base}/session/ses_owned/prompt`,post(body)).catch(error=>({status:error.code??String(error),arrayBuffer:async()=>{}}))
        const received=await response.arrayBuffer()
        if(typeof response.status==='number'&&response.status>=400)errors[name]=JSON.parse(Buffer.from(received).toString())
        const calls=native.calls.slice(before),forwarded=calls.filter(r=>r.path==='/api/session/ses_owned/prompt')
        if(forwarded.length)assert.deepEqual(forwarded[0].body,body,`${label} ${name} forwarding`)
        if(response.status===200){
          assert.equal(forwarded.length,1,`${label}/${name} one native send`)
          assert.equal(calls.filter(r=>r.path.endsWith('/environment')).length,1,`${label}/${name} environment`)
          assert(calls.findIndex(r=>r.path.endsWith('/environment'))<calls.findIndex(r=>r.path.endsWith('/prompt')))
          if(body.id)assert.equal(JSON.parse(Buffer.from(received).toString()).data.id,body.id,`${label}/${name} distinct receipt`)
        }
        if(label==='ts'){
          const malformed=['bad-base64','bad-percent','files-object','file-null','file-empty','relative','file-query','file-encoded-slash']
          const expected=expectedStatus??(name.endsWith('-over')?413:malformed.includes(name)?400:['foreign-file','foreign-location','carrier-metadata','automation-metadata','carrier-marker'].includes(name)?403:200)
          assert.equal(response.status,expected,`Reference control ${name}`)
        }
        rows.push({name,status:response.status,bytes:Buffer.byteLength(JSON.stringify(body)),forwarded:forwarded.length,
           environment:calls.filter(r=>r.path.endsWith('/environment')).length,bodyHashVerified:forwarded.length?digest(forwarded[0].body)===digest(body):null,
           ...(response.status===502?{nativeRoutes:calls.map(call=>call.path)}:{})})
      }
      for(const session of ['ses_foreign','ses_cn_schedule_reserved','ses_carrier']){
        const before=native.calls.length,response=await host.call(`${host.base}/session/${session}/prompt`,post({text:'refuse'}));errors[session]=JSON.parse(Buffer.from(await response.arrayBuffer()).toString())
        rows.push({name:session,status:response.status,forwarded:native.calls.slice(before).filter(r=>r.path.endsWith('/prompt')||r.path.endsWith('/environment')).length})
      }
      for (const [name,session,expected] of [
        ['worktree-session','ses_tree',200],
        ['session-subfolder','ses_nested',200],
        ['worktree-subfolder','ses_tree_nested',200],
        ['worktree-subfolder-head-directory','ses_tree_head_dir',200],
        ['independent-inside-opened-folder','ses_local_independent',200],
        ['nested-independent-repo','ses_independent',403],
      ]) {
        const before=native.calls.length,response=await host.call(`${host.base}/session/${session}/prompt`,post({text:'owned folder',id:'inbox_tree'}))
        const received=await response.arrayBuffer(),calls=native.calls.slice(before)
        const body=JSON.parse(Buffer.from(received).toString())
        assert.equal(response.status,expected,`${label}/${name}: ${Buffer.from(received)}`)
        const forwarded=calls.filter(r=>r.path.endsWith('/prompt')), environment=calls.filter(r=>r.path.endsWith('/environment'))
        const dispatch=expected===200
        assert.deepEqual(forwarded.map(call=>call.path),dispatch?[`/api/session/${session}/prompt`]:[])
        assert.deepEqual(environment.map(call=>call.path),dispatch?[`/api/session/${session}/environment`]:[])
        if(dispatch) assert.equal(body.data.id,'inbox_tree')
        else assertIndependentRefusal(label,body)
        rows.push({name,status:response.status,forwarded:forwarded.length,environment:environment.length})
      }
      for(const [carrier,expected] of [['owned',403],['unavailable',503],['move',403]]){
        native.state.carrier=carrier
        const name=`native-carrier-${carrier}`,before=native.calls.length,response=await host.call(`${host.base}/session/ses_owned/prompt`,post({text:'guard',files:[{uri:data(1)}]}))
        const received=Buffer.from(await response.arrayBuffer()).toString(),calls=native.calls.slice(before)
        if(label==='ts')assert.equal(response.status,expected,`Reference native guard ${name}: ${received}`)
        errors[name]=JSON.parse(received)
        rows.push({name,status:response.status,forwarded:calls.filter(r=>r.path.endsWith('/prompt')||r.path.endsWith('/environment')).length})
        native.state.carrier='absent';native.sessions.get('ses_owned').location.directory=native.directory
      }
      for(const [name,context,body,expected,forwardedBody=body] of [
        ['context-root-aligned',{directory:native.directory},{text:'x',directory:native.directory},200],
        ['context-directory-conflict',{directory:native.directory},{text:'x',directory:native.tree},400],
        ['context-location-conflict',{directory:native.directory},{text:'x',location:{directory:native.tree}},400],
        ['context-tree-alone',{directory:native.tree},{text:'x'},200],
        ['context-tree-aligned',{directory:native.tree},{text:'x',directory:native.tree},200],
        ['context-foreign',{directory:native.foreign},{text:'x'},403],
        ['context-workspaceID',{directory:native.directory,workspaceID:null},{text:'x'},400],
        ['context-invalid',{directory:42},{text:'x'},400],
        ['context-directory-dot',undefined,{text:'x',directory:native.directory+'/.'},200,{text:'x',directory:native.directory}],
        ['context-directory-dot-aligned',{directory:native.directory},{text:'x',directory:native.directory+'/.'},200,{text:'x',directory:native.directory}],
        ['context-header-dot-aligned',{directory:native.directory+'/.'},{text:'x',directory:native.directory},200],
        ['context-location-dot-aligned',{directory:native.directory},{text:'x',location:{directory:native.directory+'/.',future:true}},200,{text:'x',location:{directory:native.directory,future:true}}],
        ['context-directory-subfolder',undefined,{text:'x',directory:path.join(native.directory,'sub')},200],
        ['context-location-subfolder',undefined,{text:'x',location:{directory:path.join(native.directory,'sub')}},200],
        ['context-directory-trim',undefined,{text:'x',directory:' '+native.directory+' '},200,{text:'x',directory:native.directory}],
        ['context-directory-case',undefined,{text:'x',directory:native.directory.toLowerCase()},200,{text:'x',directory:native.directory}],
        ['context-directory-missing',undefined,{text:'x',directory:path.join(native.directory,'missing','nested')},200],
      ]){
        const before=native.calls.length,response=await host.call(`${host.base}/session/ses_owned/prompt`,{...post(body),headers:{'content-type':'application/json',...(context?{'x-codenomad-location':encodeURIComponent(JSON.stringify(context))}:{})}})
        const received=Buffer.from(await response.arrayBuffer()).toString(),calls=native.calls.slice(before)
        if(label==='ts')assert.equal(response.status,expected,`Reference context ${name}: ${received}`)
        if(typeof response.status==='number'&&response.status>=400)errors[name]=JSON.parse(received)
        if(response.status===200)assert.deepEqual(calls.find(r=>r.path.endsWith('/prompt'))?.body,forwardedBody,`${label}/${name} normalized directory payload`)
        rows.push({name,status:response.status,forwarded:calls.filter(r=>r.path.endsWith('/prompt')||r.path.endsWith('/environment')).length})
      }
       for(const [name,route,body] of [['interrupt-valid','interrupt',{}],['interrupt-invalid','interrupt',{resume:'bad'}],['model-large','model',{model:'x'.repeat(1024*1024)}]]){
         const before=native.calls.length
         const response=await host.call(`${host.base}/session/ses_owned/${route}`,post(body))
         const received=await response.text()
         if(name==='model-large'){
           assert.equal(native.calls.slice(before).filter(call=>call.path.endsWith('/model')).length,0)
           // Fastify may reject Content-Length before the upload finishes, resetting
           // the socket. The chunked case below compares the exact HTTP refusal.
           assert(response.status===413 || label==='ts' && response.status==='ECONNRESET',`${label}/${name}: ${response.status}`)
           ;(result.declaredOverrun??={})[label]={status:response.status,body:received?JSON.parse(received):null}
           if(response.status===413) assert.equal(result.declaredOverrun[label].body.code,'FST_ERR_CTP_BODY_TOO_LARGE')
           continue
         }
         if(typeof response.status==='number'&&response.status>=400)errors[name]=JSON.parse(received)
        rows.push({name,status:response.status})
      }
      for(const [name,route,body,chunked,type,expected] of process.argv.includes('--admission-order-only')?[]:[
        ['invalid-json','prompt','{]',false,'application/json',400],['array-json','prompt','[]',false,'application/json',400],
        ['null-json','prompt','null',false,'application/json',400],['empty-json','prompt','',false,'application/json',200],
        ['chunked-inline','prompt',JSON.stringify({text:'chunked',files:[{uri:data(1024*1024)}]}),true,'application/json',200],
        ['model-large-chunked','model',JSON.stringify({model:'x'.repeat(1024*1024)}),true,'application/json',413],
        ['prompt-large-chunked','prompt',JSON.stringify({text:'x'.repeat(32*1024*1024-10)}),true,'application/json',413],
      ]){
        const before=native.calls.length,response=await host.call(`${host.base}/session/ses_owned/${route}`,{method:'POST',headers:{'content-type':type},body,chunked})
        const received=Buffer.from(await response.arrayBuffer()??'').toString(),calls=native.calls.slice(before)
        if(typeof response.status==='number'&&response.status>=400)errors[name]=JSON.parse(received)
        if(label==='ts')assert.equal(response.status,expected,`Reference transport ${name}`)
        rows.push({name,status:response.status,bytes:Buffer.byteLength(body),framing:chunked?'chunked':'content-length',forwarded:calls.filter(r=>r.path.endsWith('/prompt')||r.path.endsWith('/environment')).length})
      }
      // Source uses application/json. Keep the observed plain-stream behavior explicit
      // outside that contract, including the reference's serialization failure.
      const plain=await host.call(`${host.base}/session/ses_owned/prompt`,{method:'POST',headers:{'content-type':'text/plain'},body:'text'})
      result.outsideJson[label]={status:plain.status,body:JSON.parse(Buffer.from(await plain.arrayBuffer()).toString())}
      result.sides[label]=rows
      await host.stop();active.pop();await native.close();active.pop()
    }
    result.differences=result.sides.ts.flatMap((row,index)=>JSON.stringify(row)===JSON.stringify(result.sides.rs[index])?[]:[{name:row.name,ts:row,rs:result.sides.rs[index]}])
    result.errorBodyDifferences=Object.keys(result.errorBodies.ts).filter(name=>digest(result.errorBodies.ts[name])!==digest(result.errorBodies.rs[name]??null))
    assert.equal(result.differences.length,0,`Session input parity: ${result.differences.map(row=>`${row.name} TS=${row.ts.status} Rust=${row.rs.status}`).join(', ')}`)
    assert.deepEqual(result.errorBodyDifferences,[], 'HTTP error envelopes must also match')
  }catch(error){result.error=String(error.stack);process.exitCode=1}
  finally{for(const stop of active.reverse())await stop();await writeFile(path.join(root,'proof.json'),JSON.stringify(result,null,2)+'\n')}
  console.log(JSON.stringify({root,differences:result.differences?.map(row=>({name:row.name,ts:row.ts.status,rs:row.rs.status})),error:result.error}))
}

async function commandCases(label, host, native, rows, errors) {
  const command = {name:'fixture',text:'arguments',delivery:'steer'}
  const opened=await host.call('/api/workspaces',post({path:native.plain}))
  assert.equal(opened.status,201,`${label}: ${await opened.text()}`)
  const plainBase=`/workspaces/${JSON.parse(await opened.text()).id}/instance/api`
  for(const [name,session,body,expected,dispatch] of [
    ['ordinary','ses_owned',command,204,true],
    ['nested-session','ses_nested',command,204,true],
    ['linked-subfolder-incomplete-git','ses_tree_nested',command,204,true],
    ['linked-subfolder-head-directory','ses_tree_head_dir',command,204,true],
    ['nested-repo-inside-opened-folder','ses_local_independent',command,204,true],
    ['nested-independent-repo','ses_independent',command,403,false],
    ['nested-no-repo','ses_plain',command,204,true],
    ['files','ses_owned',{...command,files:[{uri:pathToFileURL(path.join(native.directory,'a b#%.txt')).href}]},204,true],
    ['foreign-file','ses_owned',{...command,files:[{uri:path.join(native.foreign,'private.txt')}]},403,false],
    ['invalid-attachment','ses_owned',{...command,files:[{uri:'data:;base64,abc'}]},400,false],
    ['foreign-session','ses_foreign',command,403,false],
    ['carrier','ses_cn_schedule_reserved',command,403,false],
    ['reserved-metadata','ses_owned',{...command,metadata:{schedule:null}},403,false],
    ['body-limit','ses_owned',{...command,text:'x'.repeat(1024*1024)},413,false],
    ['native-validation','ses_owned',{...command,name:42},400,true],
  ]){
    const route=`/session/${session}/command`,before=native.calls.length
    // Chunked framing gives both servers the whole near-limit body before Fastify
    // closes a refusal; a declared overrun can reset the socket while uploading.
    const response=await host.call((name==='nested-no-repo'?plainBase:host.base)+route,{
      ...post(body),chunked:name==='body-limit',
    })
    const responseBody=await response.text()
    assert.equal(response.status,expected,`${label}/${name}: ${responseBody || "no HTTP body"}`)
    const calls=native.calls.slice(before)
    const forwarded=calls.filter(r=>r.path===`/api${route}`)
    const environment=calls.filter(r=>r.path.endsWith('/environment'))
    assert.equal(forwarded.length,Number(dispatch))
    assert.equal(environment.length,Number(dispatch))
    if(dispatch){
      assert.deepEqual(forwarded[0].body,body)
      assert(calls.indexOf(environment[0])<calls.indexOf(forwarded[0]))
      assert.equal(environment[0].body.variables.FIXTURE_SETTING,'profile')
    }
    if(name==='nested-independent-repo') assertIndependentRefusal(label,JSON.parse(responseBody))
    else if(response.status>=400)errors[name]=JSON.parse(responseBody)
    rows.push({name,status:response.status,forwarded:forwarded.length,environment:environment.length})
  }
  const beforePrompt=native.calls.length
  const prompt=await host.call(`${host.base}/session/ses_owned/prompt`,post({text:'after command'}))
  assert.equal(prompt.status,200,`${label}/prompt-after-command`)
  await prompt.arrayBuffer()
  const environment=native.calls.slice(beforePrompt).filter(call=>call.path.endsWith('/environment'))
  assert.equal(environment.length,1)
  assert.equal(environment[0].body.variables.FIXTURE_SETTING,'profile')
  rows.push({name:'prompt-after-command',status:prompt.status,environment:environment.length})
  for (const [name,profile] of [
    ['profile-invalid','server: {environmentVariables: []}\n'],
    ['profile-legacy-at-runtime','preferences: {environmentVariables: {FIXTURE_SETTING: legacy}}\n'],
    ['profile-non-string','server: {environmentVariables: {FIXTURE_SETTING: 0012}}\n'],
    ['profile-binary','server: {environmentVariables: {FIXTURE_SETTING: !!binary YQ==}}\n'],
  ]) {
    await writeFile(host.config,profile)
    const before=native.calls.length
    const response=await host.call(`${host.base}/session/ses_owned/command`,post(command))
    assert.equal(response.status,502,`${label}/${name}`)
    errors[name]=JSON.parse(await response.text())
    assert.equal(native.calls.slice(before).filter(call=>/\/(?:environment|command)$/.test(call.path)).length,0)
    rows.push({name,status:response.status,forwarded:0,environment:0})
  }
}

if (process.argv.includes('--message-actions-only') && pathToFileURL(process.argv[1] ?? '').href === import.meta.url)
  await run()
