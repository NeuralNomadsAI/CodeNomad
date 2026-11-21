// Real CodeNomad Rust + synthetic OpenCode; no native window or user profile.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {FixtureStore} from './fixture-store.mjs'
import {responseFor} from './fixture-response.mjs'
import {privateEnvironment} from './private-profile.mjs'
const here=import.meta.dirname,profile=path.join(here,'fixture-profile',`launcher-${randomUUID()}`)
const project=path.join(profile,'projects','synthetic');await mkdir(project,{recursive:true})
const gitCount=Number(process.env.RUNE_TEST_GIT_COUNT??0)
if(gitCount)await promisify(execFile)('git',['init','--quiet',project],{windowsHide:true,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL'}})
const records=new Map(),stores=new Map(),streams=new Set(),requests=[]
const stats={created:0,prompts:0,lists:0}
const uncertain=process.argv.includes('--uncertain-create')
const withTools=process.argv.includes('--with-tools')
function add(id,title) {
  const row={id,title,projectID:'global',location:{directory:project},permissions:[{action:'*',resource:'*',effect:'deny'}],time:{created:1,busy:0,idle:1}}
  records.set(id,row);stores.set(id,new FixtureStore(0));return row
}
add('ses_existing','Existing history');stores.get('ses_existing').append('user','Existing project history');stores.get('ses_existing').append('assistant','Existing answer')
add('ses_another','Another session')
if(withTools)stores.get('ses_existing').rows[1].content.push({type:'tool',id:'historical-read',name:'read',state:{status:'completed',input:{file:'synthetic.rs'},content:[{type:'text',text:'fn historical() {}'}]}})
const upstream=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://127.0.0.1');requests.push(`${req.method} ${url.pathname}`)
    assert.equal(req.headers.authorization,`Basic ${Buffer.from('opencode:fixture-native').toString('base64')}`)
    let raw='';for await(const chunk of req){raw+=chunk;assert(raw.length<262144)}
    const json=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data))}
    if(url.pathname==='/api/event') {
      res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:randomUUID(),type:'server.connected',created:Date.now(),data:{}})}\n\n`)
      streams.add(res);req.on('close',()=>streams.delete(res));return
    }
    if(url.pathname==='/api/location')return json(gitCount?{directory:project,project:{id:'fixture_project',canonical:project,directory:project}}:{data:{directory:project}})
    if(gitCount&&url.pathname==='/api/worktree')return json(Array.from({length:gitCount},(_,i)=>({directory:i?path.join(profile,`absent-checkout-${i}`):project})))
    if(url.pathname==='/api/session'&&req.method==='GET') {
      stats.lists++
      let rows=[...records.values()]
      let next
      if(!url.searchParams.has('cursor')){
        assert.equal(url.searchParams.get('directory'),project);assert.equal(url.searchParams.get('limit'),'200')
        next=Buffer.from(JSON.stringify({directory:project,anchor:{id:rows[0].id,time:1,direction:'next'}})).toString('base64url')
        rows=rows.slice(0,1)
      }else{assert.equal(JSON.parse(Buffer.from(url.searchParams.get('cursor'),'base64url')).directory,project);rows=rows.slice(1)}
      return json({data:rows,cursor:next?{next}:{}})
    }
    if(url.pathname==='/api/session'&&req.method==='POST') {
      const body=JSON.parse(raw);assert.equal(body.location.directory,project)
      const created=add(`ses_created_${++stats.created}`,body.title)
      if(uncertain&&stats.created===1){res.statusCode=500;return json({error:'simulated response lost after creation'})}
      return json({data:created})
    }
    if(url.pathname==='/api/plugin')return json({location:{directory:project},data:[{id:'codenomad-session-pruning',state:{status:'active'}}]})
    if(url.pathname==='/api/rpc/codenomad.session-pruning/window'){
      const {input}=JSON.parse(raw);return json({output:stores.get(input.sessionID).window(input.target)})
    }
    if(url.pathname==='/api/rpc/codenomad.missions/scheduleCarrierRead')return json({output:{owned:false}})
    const match=url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/)
    if(match){
      const [,id,action]=match,record=records.get(id),store=stores.get(id);assert(record,'known fixture session')
      if(!action)return json({data:record})
      if(action==='message')return json({data:store.rows.slice(-Number(url.searchParams.get('limit'))),cursor:url.searchParams.get('order')==='asc'?{next:'future-read-anchor'}:{}})
      if(action==='environment'){res.statusCode=204;res.end();return}
      if(action==='prompt'){
        const turn=++stats.prompts;assert(id.startsWith('ses_created_'),'send belongs to selected created session')
        const body=JSON.parse(raw),reply=store.append('assistant','',false)
        // Authoritative user precedes assistant.
        store.rows.pop();store.append('user',body.text);reply.id=`reply-${id}-${turn}`;store.rows.push(reply)
        const emit=(type,data)=>{for(const stream of streams)stream.write(`data: ${JSON.stringify({id:randomUUID(),type,created:Date.now(),location:{directory:project},data:{sessionID:id,...data}})}\n\n`)}
        record.time.busy=Date.now();emit('session.step.started',{assistantMessageID:reply.id,agent:'fixture',model:{providerID:'fixture',id:'fixture'}})
        json({data:{id:`inbox-${turn}`}})
        let tool
        if(withTools){
          tool={type:'tool',id:`tool-${turn}`,name:'read',state:{status:'streaming'}};reply.content.push(tool)
          emit('session.tool.input.started',{assistantMessageID:reply.id,id:tool.id,name:'read'});await new Promise(r=>setTimeout(r,350))
          tool.state={status:'running',input:{file:'synthetic.rs'}}
          emit('session.tool.called',{assistantMessageID:reply.id,id:tool.id,input:tool.state.input,executed:true});await new Promise(r=>setTimeout(r,350))
        }
        const characters=Array.from(responseFor(turn,body.text)),size=withTools?3:1
        for(let i=0;i<characters.length;i+=size){const c=characters.slice(i,i+size).join('');reply.content[0].text+=c;emit('session.text.delta',{assistantMessageID:reply.id,ordinal:0,delta:c});await new Promise(r=>setTimeout(r,withTools?150:8))}
        if(tool){tool.state={...tool.state,status:'completed',content:[{type:'text',text:`Synthetic output ${turn}`}]} ;emit('session.tool.success',{assistantMessageID:reply.id,id:tool.id,content:tool.state.content,executed:true})}
        reply.time.completed=Date.now();record.time.idle=Date.now();emit('session.execution.succeeded',{});return
      }
    }
    res.statusCode=404;json({_tag:'RpcError',type:'rpc.method_not_found',message:'Unsupported fixture route'})
  }catch(error){console.error(error);res.statusCode=500;res.end('{}')}
})
await new Promise(r=>upstream.listen(0,'127.0.0.1',r))
const env=await privateEnvironment(profile)
Object.assign(env,{CNRS_SERVER_PASSWORD:'fixture-backend',CNRS_FIXTURE_URL:`http://127.0.0.1:${upstream.address().port}/`,CNRS_FIXTURE_PASSWORD:'fixture-native',CNRS_FIXTURE_STDIN_STOP:'1',GIT_CEILING_DIRECTORIES:profile,CODENOMAD_REMOTE_CONTROL:'disabled'})
const server=spawn(path.join(here,'../server-rs/target/debug/codenomad-rs.exe'),[path.dirname(project),path.join(profile,'identity.json'),'0','synthetic-only'],{cwd:profile,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
let log='',client,result=1;server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d)
try{
  let origin;for(const until=Date.now()+20000;!origin;){assert(Date.now()<until&&server.exitCode===null,'Rust startup');origin=log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(!origin)await new Promise(r=>setTimeout(r,50))}
  client=spawn(path.join(here,'target/debug/codenomad-rune-recovery.exe'),['--probe-launcher'],{cwd:profile,windowsHide:true,stdio:'inherit',env:{...env,RUNE_BACKEND:`${origin}/`,RUNE_PASSWORD:'fixture-backend',RUNE_TEST_FOLDER:project,RUNE_LOCALE:'fr',...(uncertain?{RUNE_TEST_CREATE_UNCERTAIN:'1'}:{}),...(withTools?{RUNE_TEST_TOOLS:'1'}:{})}})
  result=await new Promise((resolve,reject)=>{client.on('exit',resolve);client.on('error',reject)})
  assert.equal(result,0);assert.equal(stats.created,1);assert.equal(stats.prompts,2)
  if(gitCount)assert.equal(requests.filter(r=>r==='GET /api/worktree').length,0,'root mutations must not enumerate sibling worktrees')
  console.log(JSON.stringify({fixture:'launcher',uncertain,withTools,...stats,profile}))
}finally{
  if(client?.exitCode===null)client.kill();server.stdin.end()
  await Promise.race([new Promise(r=>server.on('exit',r)),new Promise(r=>setTimeout(r,3000))]);if(server.exitCode===null)server.kill()
  for(const stream of streams)stream.destroy();upstream.closeAllConnections();upstream.close()
  await writeFile(path.join(profile,'proof.json'),JSON.stringify({result,stats,requests},null,2));await writeFile(path.join(profile,'rust.log'),log)
}
process.exitCode=result??1
