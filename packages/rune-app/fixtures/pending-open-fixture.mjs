import assert from 'node:assert/strict'
import {createServer,request} from 'node:http'
import {fixtureChildPid,spawnFixtureChild as spawn,stopFixtureChild} from '../../../scripts/native-fixture-guards.mjs'
import {
  RELAY_PLACEHOLDER_PASSWORD,
  createAttestedHttpAgent,
  createClientPidGate,
  maskSetCookieHeaders,
  relayTarget,
  stripFixtureServerSecrets,
  substitutePlaceholderCookies,
} from '../../../scripts/native-fixture-http.mjs'
import {mkdir,writeFile} from 'node:fs/promises'
import path from 'node:path'

export async function pendingOpenFixture({origin,serverPid,backendPassword,profile,project,env,clientBinary}) {
  assert(Number.isSafeInteger(serverPid)&&serverPid>0,'Attested server PID required for pending-open fixture')
  assert(typeof backendPassword==='string'&&backendPassword.length>0,'Backend password required for pending-open fixture')
  const base=new URL(origin)
  const targetPort=Number(base.port)
  const proofs=[]
  const clientEnv=stripFixtureServerSecrets(env)
  for(const mode of ['capacity','post','ack','quota']) {
    const gate=path.join(profile,`pending-${mode}.held`)
    let first=true,held,original,creates=0,cancels=0,forwarded=false,proxyPort=0
    const agent=createAttestedHttpAgent(targetPort,serverPid)
    const clientGate=createClientPidGate(()=>proxyPort)
    const cookieMap=new Map()
    const proxy=createServer(async(req,res)=>{
      try {
        const url=relayTarget(req,res,base.origin)
        if(!url)return
        req.pause()
        const ok=await clientGate.verify(req.socket)
        if(res.destroyed||req.socket.destroyed)return
        if(!ok){req.resume();res.writeHead(403,{connection:'close'});res.end('Attested client PID required');return}
        req.resume()
        const chunks=[];let total=0
        for await(const chunk of req){total+=chunk.length;assert(total<262144);chunks.push(chunk)}
        let body=Buffer.concat(chunks)
        const headers={...req.headers,host:url.host}
        if(typeof headers.cookie==='string'){
          headers.cookie=substitutePlaceholderCookies(headers.cookie,cookieMap)
        }
        if(req.method==='POST'&&url.pathname==='/api/auth/login'){
          const payload=JSON.parse(body.toString('utf8'))
          if(payload?.password===RELAY_PLACEHOLDER_PASSWORD)payload.password=backendPassword
          body=Buffer.from(JSON.stringify(payload))
          headers['content-length']=String(body.length)
          delete headers['transfer-encoding']
        }
        const forward=(hold=false)=>new Promise((resolve,reject)=>{
          const upstream=request(url,{agent,method:req.method,headers},reply=>{
            if(reply.statusCode>=300&&reply.statusCode<400){
              reply.destroy()
              if(!res.headersSent)res.writeHead(502)
              res.end('Upstream redirect forbidden')
              resolve()
              return
            }
            const outHeaders={...reply.headers}
            if(outHeaders['set-cookie']){
              outHeaders['set-cookie']=maskSetCookieHeaders(outHeaders['set-cookie'],cookieMap)
            }
            const replyChunks=[];reply.on('data',c=>replyChunks.push(c));reply.on('end',async()=>{
              const bytes=Buffer.concat(replyChunks)
              const send=()=>{res.writeHead(reply.statusCode,outHeaders);res.end(bytes)}
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
      }catch(error){console.error(error);if(!res.headersSent){res.statusCode=500;res.end('{}')}}
    })
    await new Promise(r=>proxy.listen(0,'127.0.0.1',r))
    proxyPort=proxy.address().port
    const state=path.join(profile,`pending-state-${mode}`);await mkdir(state,{recursive:true})
    let output='',lines='',proof
    const client=spawn(clientBinary,['--probe-pending-open'],{cwd:profile,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...clientEnv,RUNE_BACKEND:`http://127.0.0.1:${proxyPort}/`,RUNE_PASSWORD:RELAY_PLACEHOLDER_PASSWORD,RUNE_TEST_FOLDER:project,RUNE_LOCALE:'fr',RUNE_STATE_DIR:state,RUNE_TEST_PENDING_GATE:gate,RUNE_TEST_PENDING_CASE:mode}})
    const closed=new Promise((resolve,reject)=>{client.once('exit',resolve);client.once('error',reject)})
    clientGate.allow(fixtureChildPid(client),closed)
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
      const code=await closed
      assert.equal(code,0,`Pending creation ${mode}`);assert(proof);assert.equal(creates,mode==='capacity'?33:2);if(mode!=='capacity')assert(cancels>=1);assert.equal(proof.recordsRemaining,0)
      proofs.push({...proof,creates,cancels,confirmedOldRecord:!!original})
    }finally{
      clearTimeout(timer)
      await stopFixtureChild(client,closed).catch(()=>{})
      clientGate.close()
      agent.destroy()
      proxy.closeAllConnections()
      await new Promise(r=>proxy.close(r))
      await writeFile(path.join(profile,`pending-${mode}.log`),output)
    }
  }
  await writeFile(path.join(profile,'pending-open-proof.json'),JSON.stringify(proofs,null,2))
  return proofs
}
