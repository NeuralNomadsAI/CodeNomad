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
  let created=0,turn=0,closed=false
  const authorization=`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  const emit=(sessionID,type,data)=>{
    const event={id:randomUUID(),type,created:Date.now(),location:{directory:project},data:{sessionID,...data}}
    const frame=`data: ${JSON.stringify(event)}\n\n`
    for(const stream of [...streams]){
      if(stream.destroyed||stream.writableEnded){streams.delete(stream);continue}
      try{stream.write(frame)}catch{streams.delete(stream)}
    }
  }
  const parseObject=text=>{
    const parsed=JSON.parse(text)
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new SyntaxError('Expected JSON object')
    return parsed
  }
  const server=createServer(async(req,res)=>{
    let pathname=req.url??'/'
    const note=status=>void appendFile(requests,`${status} ${req.method} ${pathname}\n`).catch(()=>{})
    const json=(value,status=200)=>{
      note(status)
      if(!res.headersSent&&!res.writableEnded){
        res.writeHead(status,{'content-type':'application/json'})
        res.end(JSON.stringify(value))
      }
    }
    const empty=()=>{
      note(204)
      if(!res.headersSent&&!res.writableEnded){res.writeHead(204);res.end()}
    }
    try{
      const url=new URL(req.url,'http://127.0.0.1')
      pathname=url.pathname
      if(req.headers.authorization!==authorization){note(401);res.writeHead(401);res.end();return}
      const chunks=[];let bytes=0
      for await(const chunk of req){
        const buf=typeof chunk==='string'?Buffer.from(chunk):chunk
        bytes+=buf.length
        if(bytes>262144){note(413);res.writeHead(413);res.end();return}
        chunks.push(buf)
      }
      const raw=Buffer.concat(chunks,bytes).toString('utf8')
      const directory=url.searchParams.get('location[directory]')??project
      if(url.pathname==='/api/event'){
        note(200);res.writeHead(200,{'content-type':'text/event-stream'})
        res.write(`data: ${JSON.stringify({id:'connected',type:'server.connected',created:Date.now(),data:{}})}\n\n`)
        streams.add(res);req.on('close',()=>streams.delete(res));return
      }
      // project lets the server prove the opened folder is this native project's checkout and read its Git.
      if(url.pathname==='/api/location')return json({data:{directory:project},directory,project:{id:'synthetic_project',canonical:project,directory}})
      if(url.pathname==='/api/debug/location')return json([{directory:project}])
      // The server reads the project's Git itself once the native worktree list names it.
      if(url.pathname==='/api/worktree'&&req.method==='GET')return json([{directory:project}])
      if(url.pathname==='/api/worktree/refresh')return empty()
      if(url.pathname==='/api/plugin')return json({location:{directory},data:[{id:'codenomad-session-pruning',state:{status:'active'}}]})
      if(url.pathname==='/api/session'&&req.method==='GET')return json({data:[...records.values()],cursor:{}})
      if(url.pathname==='/api/session'&&req.method==='POST'){
        let body
        try{body=parseObject(raw||'{}')}catch{return json({error:'Invalid JSON body'},400)}
        return json({data:add(`ses_created_${++created}`,typeof body.title==='string'?body.title:'',0)})
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
        let payload
        try{payload=parseObject(raw)}catch{return json({error:'Invalid JSON body'},400)}
        const input=payload.input
        if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.sessionID!=='string'||!input.target||typeof input.target!=='object'){
          return json({error:'Invalid window input'},400)
        }
        const store=stores.get(input.sessionID)
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
        if(action==='message'){
          const limit=Number(url.searchParams.get('limit')||200)
          const count=Number.isFinite(limit)&&limit>0?limit:200
          return json({data:store.rows.slice(-count),cursor:{}})
        }
        if(['permission','form','inbox'].includes(action))return json({data:[]})
        if(action==='environment')return empty()
        if(action==='prompt'&&req.method==='POST'){
          let body
          try{body=parseObject(raw)}catch{return json({error:'Invalid JSON body'},400)}
          const current=++turn,promptText=typeof body.text==='string'?body.text:''
          store.append('user',promptText)
          const reply=store.append('assistant','',false);reply.id=`reply-${id}-${current}`
          record.time.busy=Date.now()
          emit(id,'session.step.started',{assistantMessageID:reply.id,agent:'fixture',model:{providerID:'fixture',id:'fixture'}})
          json({data:{id:typeof body.id==='string'&&body.id?body.id:`inbox-${current}`}})
          const text=textStream(reply,(type,data)=>emit(id,type,data))
          for(const character of responseFor(current,promptText)){
            if(closed)return
            text.append(character)
            await new Promise(resolve=>setTimeout(resolve,15))
          }
          if(closed)return
          text.close();reply.time.completed=Date.now();record.time.idle=Date.now()
          emit(id,'session.execution.succeeded',{});return
        }
      }
      json({_tag:'RpcError',type:'rpc.method_not_found',message:'Synthetic endpoint: unsupported'},404)
    }catch(error){
      note(500)
      if(!res.headersSent&&!res.writableEnded){
        res.writeHead(500,{'content-type':'application/json'})
        res.end(JSON.stringify({error:error?.message??'Internal server error'}))
      }else if(!res.writableEnded){
        res.end()
      }
    }
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  return {
    origin:`http://127.0.0.1:${server.address().port}/`,
    close:()=>new Promise(resolve=>{closed=true;for(const stream of streams)stream.destroy();streams.clear();server.close(resolve)}),
  }
}
