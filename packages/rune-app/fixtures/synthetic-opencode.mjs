// A synthetic OpenCode endpoint for an owned server: one project with a long conversation to
// scroll and a short one, new conversations, and a scripted reply to every prompt.
import {randomUUID} from 'node:crypto'
import {appendFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {FixtureStore} from './fixture-store.mjs'
import {responseFor,textStream} from './fixture-response.mjs'

const model={id:'fixture',providerID:'fixture',name:'Fixture',limit:{context:100000,output:4096},cost:[],variants:[]}

/// Listens on loopback and answers `password`'s Basic credentials; every request path goes to
/// the `requests` file, with `404` in front of the ones it does not answer.
export async function syntheticOpenCode({project,password,requests}) {
  const records=new Map(),stores=new Map(),streams=new Set()
  const add=(id,title,count)=>{
    const row={id,title,projectID:'global',location:{directory:project},time:{created:1,busy:0,idle:1}}
    records.set(id,row);stores.set(id,new FixtureStore(count));return row
  }
  add('ses_long','Long synthetic history',2000)
  add('ses_short','Short conversation',0)
  stores.get('ses_short').append('user','Bonjour')
  stores.get('ses_short').append('assistant','Bonjour. Ceci est une conversation synthétique.')
  let created=0,turn=0
  const authorization=`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  const emit=(sessionID,type,data)=>{
    const event={id:randomUUID(),type,created:Date.now(),location:{directory:project},data:{sessionID,...data}}
    for(const stream of streams)stream.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  // A request this endpoint fails on answers 500: an unhandled rejection would end the process
  // and leave the server it serves without its OpenCode.
  const server=createServer((req,res)=>void answer(req,res).catch(()=>{
    if(!res.headersSent)res.writeHead(500)
    res.end()
  }))
  async function answer(req,res){
    const url=new URL(req.url,'http://127.0.0.1')
    const note=status=>void appendFile(requests,`${status} ${req.method} ${url.pathname}\n`).catch(()=>{})
    if(req.headers.authorization!==authorization){note(401);res.writeHead(401);res.end();return}
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>262144){res.writeHead(413);res.end();return}}
    const json=(value,status=200)=>{note(status);res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}
    const empty=()=>{note(204);res.writeHead(204);res.end()}
    const directory=url.searchParams.get('location[directory]')??project
    if(url.pathname==='/api/event'){
      note(200);res.writeHead(200,{'content-type':'text/event-stream'})
      res.write(`data: ${JSON.stringify({id:'connected',type:'server.connected',created:Date.now(),data:{}})}\n\n`)
      streams.add(res);req.on('close',()=>streams.delete(res));return
    }
    if(url.pathname==='/api/location')return json({data:{directory:project}})
    if(url.pathname==='/api/plugin')return json({location:{directory},data:[{id:'codenomad-session-pruning',state:{status:'active'}}]})
    if(url.pathname==='/api/session'&&req.method==='GET')return json({data:[...records.values()],cursor:{}})
    if(url.pathname==='/api/session'&&req.method==='POST'){
      const body=JSON.parse(raw||'{}')
      return json({data:add(`ses_created_${++created}`,body.title??'',0)})
    }
    if(url.pathname==='/api/session/active')return json({data:{}})
    if(url.pathname==='/api/project')return json([])
    if(url.pathname==='/api/config')return json([{type:'directory',path:project}])
    if(url.pathname==='/api/provider')return json({data:[{id:'fixture',name:'Fixture'}]})
    if(url.pathname==='/api/model')return json({location:{directory},data:[{...model,enabled:true}]})
    if(url.pathname==='/api/model/default')return json({data:model})
    if(url.pathname==='/api/agent')return json({data:[{id:'build',name:'Build',mode:'primary'},{id:'plan',name:'Plan',mode:'primary'}]})
    if(['/api/mcp','/api/command'].includes(url.pathname))return json({location:{directory},data:[]})
    if(url.pathname==='/api/rpc/codenomad.missions/scheduleCarrierRead')return json({output:{owned:false}})
    if(['/api/rpc/codenomad.session-pruning/window','/api/rpc/codenomad.session-pruning/windowUserFilesV1'].includes(url.pathname)){
      const {input}=JSON.parse(raw),store=stores.get(input.sessionID)
      if(!store)return json({output:{status:'blocked',reason:'session_missing'}})
      const window=store.window(input.target)
      if(url.pathname.endsWith('windowUserFilesV1')&&window.status==='window')window.userFiles='reference-v1'
      return json({output:window})
    }
    const match=url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/)
    const record=match&&records.get(match[1]),store=match&&stores.get(match[1])
    if(record){
      const [,id,action]=match
      if(!action)return json({data:record})
      if(action==='message')return json({data:store.rows.slice(-Number(url.searchParams.get('limit')||200)),cursor:{}})
      if(['permission','form','inbox'].includes(action))return json({data:[]})
      if(action==='environment')return empty()
      if(action==='prompt'&&req.method==='POST'){
        const body=JSON.parse(raw),current=++turn
        store.append('user',body.text??'')
        const reply=store.append('assistant','',false);reply.id=`reply-${id}-${current}`
        record.time.busy=Date.now()
        emit(id,'session.step.started',{assistantMessageID:reply.id,agent:'fixture',model:{providerID:'fixture',id:'fixture'}})
        json({data:{id:body.id??`inbox-${current}`}})
        const text=textStream(reply,(type,data)=>emit(id,type,data))
        for(const character of responseFor(current,body.text??'')){text.append(character);await new Promise(resolve=>setTimeout(resolve,15))}
        text.close();reply.time.completed=Date.now();record.time.idle=Date.now()
        emit(id,'session.execution.succeeded',{});return
      }
    }
    json({_tag:'RpcError',type:'rpc.method_not_found',message:'Synthetic endpoint: unsupported'},404)
  }
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  return {
    origin:`http://127.0.0.1:${server.address().port}/`,
    close:()=>new Promise(resolve=>{for(const stream of streams)stream.destroy();server.close(resolve)}),
  }
}
