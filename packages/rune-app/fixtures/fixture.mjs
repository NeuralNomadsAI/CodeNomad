// Synthetic loopback backend with CodeNomad's HTTP/SSE wire shapes.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawnFixtureChild as spawn} from '../../../scripts/native-fixture-guards.mjs'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {responseFor,textStream} from './fixture-response.mjs'
import {FixtureStore} from './fixture-store.mjs'
import {requireTestSupport,clientBinary} from './fixture-binaries.mjs'
requireTestSupport()
const code = 'fn main() {\n    println!("Rune · Code Nomad");\n}'
const streams = new Set()
let count = 0
const workspace = 'rune-synthetic'
const session = 'ses_rune_synthetic'
const directory = '/synthetic'
const base = `/api/workspaces/${workspace}`
const requests = []
const store = new FixtureStore()
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  requests.push(`${req.method} ${req.url}`)
  let raw = ''
  for await (const chunk of req) { raw += chunk; assert(raw.length < 16384) }
  if (req.url?.startsWith('/api/events?')) {
    assert.equal(req.method, 'GET')
    res.writeHead(200, {'content-type':'text/event-stream'})
    res.write('event: codenomad.client.ping\ndata: {"ts":1}\n\n')
    streams.add(res); req.on('close', () => streams.delete(res)); return
  }
  res.setHeader('content-type', 'application/json')
  if (req.method === 'GET' && url.pathname === '/api/meta') {
    res.end(JSON.stringify({apiContract:1,serverId:'rune-synthetic'})); return
  }
  if (req.method === 'POST' && url.pathname === `${base}/session-history/window`) {
    assert.equal(JSON.parse(raw).sessionID,session)
    res.end(JSON.stringify(store.window(JSON.parse(raw).target)));return
  }
  if (req.method === 'POST' && url.pathname === `/workspaces/${workspace}/instance/api/session/${session}/prompt`) {
    assert.equal(url.searchParams.get('directory'), directory)
    assert.equal(decodeURIComponent(req.headers['x-codenomad-session-directory'] ?? ''), directory)
    assert.equal(typeof JSON.parse(raw).text, 'string')
    assert(streams.size > 0, 'subscribe before prompting')
    const messageID = `reply-${++count}`
    store.append('user',JSON.parse(raw).text)
    const stored=store.append('assistant','',false);stored.id=messageID
    const emit = (type, data) => {
      const event = {type:'instance.event', instanceId:workspace, event:{id:randomUUID(),type,
        created:Date.now(),location:{directory}, data:{sessionID:session,...data}}}
      for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    emit('session.step.started', {assistantMessageID:messageID,agent:'fixture',model:{providerID:'fixture',id:'fixture'}})
    res.end(JSON.stringify({data:{id:`inbox-fixture-${count}`}}))
    const text=textStream(stored,emit)
    for (const character of responseFor(count,JSON.parse(raw).text)) {
      text.append(character)
      await new Promise(r => setTimeout(r, 10))
    }
    text.close();stored.time.completed=Date.now()
    emit('session.execution.succeeded', {})
    return
  }
  if (url.pathname === '/api/client-connections/pong') { res.statusCode = 204; res.end(); return }
  if (req.method === 'GET' && url.pathname === `/workspaces/${workspace}/instance/api/session/${session}`) {
    res.end(JSON.stringify({data:{id:session,location:{directory},time:{created:1}}}));return
  }
  res.statusCode = 404; res.end('{}')
})
await new Promise(r => server.listen(0,'127.0.0.1',r))
const child = spawn(clientBinary, process.argv.slice(2), {
  cwd: path.resolve(import.meta.dirname,'..'), windowsHide:true, stdio:'inherit', env:{...process.env,
    RUNE_BACKEND:`http://127.0.0.1:${server.address().port}/`,RUNE_WORKSPACE:workspace,RUNE_SESSION:session,
    RUNE_BOOTSTRAP_TOKEN:'',RUNE_LOCALE:'fr',CODENOMAD_PROFILE:'trial-rune-fixture'},
})
const result = await new Promise((resolve,reject) => { child.on('exit',resolve); child.on('error',reject) })
for (const stream of streams) stream.end()
server.closeAllConnections(); server.close()
console.log(JSON.stringify({fixture:'synthetic-http-sse',exitCode:result,prompts:count,requests},null,2))
if(process.argv.includes('--probe-contract')) assert(requests.includes('POST /api/client-connections/pong'))
process.exitCode = result ?? 1
