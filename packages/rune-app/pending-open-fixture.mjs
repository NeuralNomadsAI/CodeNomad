import assert from 'node:assert/strict'
import {createServer,request} from 'node:http'
import {spawn} from 'node:child_process'
import {mkdir,writeFile} from 'node:fs/promises'
import path from 'node:path'

export async function pendingOpenFixture({origin,profile,project,env,clientBinary}) {
  const proofs=[]
  for(const mode of ['capacity','post','ack','quota']) {
    const gate=path.join(profile,`pending-${mode}.held`)
    let first=true,held,original,creates=0,cancels=0,forwarded=false
    const proxy=createServer(async(req,res)=>{
      try {
        const chunks=[];for await(const chunk of req){chunks.push(chunk);assert(chunks.reduce((n,c)=>n+c.length,0)<262144)}
        const body=Buffer.concat(chunks),url=new URL(req.url,origin)
        const forward=(hold=false)=>new Promise((resolve,reject)=>{
          const upstream=request(url,{method:req.method,headers:{...req.headers,host:url.host}},reply=>{
            const chunks=[];reply.on('data',c=>chunks.push(c));reply.on('end',async()=>{
              const bytes=Buffer.concat(chunks)
              const send=()=>{res.writeHead(reply.statusCode,reply.headers);res.end(bytes)}
              if(hold){assert.equal(reply.statusCode,201);original=JSON.parse(bytes).id;held=send;await writeFile(gate,'held')}
              else send()
              resolve()
            })
          });upstream.on('error',reject);upstream.end(body)
        })
        if(req.method==='POST'&&url.pathname==='/api/workspaces') {
          creates++
          if(first&&mode!=='capacity'){
            first=false
            if(mode==='post') {held=()=>{forwarded=true;return forward()};await writeFile(gate,'held');return}
            await forward(true);return
          }
        }
        await forward()
        if(req.method==='POST'&&url.pathname==='/api/workspaces/creation/cancel') {
          cancels++
          if(mode==='post'&&held&&!forwarded)await held()
        }
      }catch(error){console.error(error);res.statusCode=500;res.end('{}')}
    })
    await new Promise(r=>proxy.listen(0,'127.0.0.1',r))
    const state=path.join(profile,`pending-state-${mode}`);await mkdir(state,{recursive:true})
    let output='',lines='',proof
    const client=spawn(clientBinary,['--probe-pending-open'],{cwd:profile,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...env,RUNE_BACKEND:`http://127.0.0.1:${proxy.address().port}/`,RUNE_PASSWORD:'fixture-backend',RUNE_TEST_FOLDER:project,RUNE_LOCALE:'fr',RUNE_STATE_DIR:state,RUNE_TEST_PENDING_GATE:gate,RUNE_TEST_PENDING_CASE:mode}})
    client.stdout.on('data',chunk=>{
      output+=chunk;process.stdout.write(chunk);lines+=chunk
      for(let at;(at=lines.indexOf('\n'))>=0;){const line=lines.slice(0,at);lines=lines.slice(at+1);let json;try{json=JSON.parse(line)}catch{continue}
        if(json.type==='pending-open-stage'){
          if(mode!=='post')held()
          writeFile(gate.replace(/\.held$/,'.released'),'released').catch(console.error)
        }
        if(json.type==='pending-open-proof')proof=json
      }
    })
    client.stderr.on('data',chunk=>{output+=chunk;process.stderr.write(chunk)})
    const timer=setTimeout(()=>client.kill(),60000)
    try {
      const code=await new Promise((resolve,reject)=>{client.once('exit',resolve);client.once('error',reject)})
      assert.equal(code,0,`Pending creation ${mode}`);assert(proof);assert.equal(creates,mode==='capacity'?33:2);if(mode!=='capacity')assert(cancels>=1);assert.equal(proof.recordsRemaining,0)
      proofs.push({...proof,creates,cancels,confirmedOldRecord:!!original})
    }finally{clearTimeout(timer);proxy.closeAllConnections();await new Promise(r=>proxy.close(r));await writeFile(path.join(profile,`pending-${mode}.log`),output)}
  }
  await writeFile(path.join(profile,'pending-open-proof.json'),JSON.stringify(proofs,null,2))
  return proofs
}
