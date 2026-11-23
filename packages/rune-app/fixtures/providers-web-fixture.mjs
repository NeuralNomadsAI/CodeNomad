import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {chromium} from 'playwright'
import {bundleAssetPaths} from '../../../scripts/rune/web-workspace-policy.mjs'

const bundle = path.resolve(process.argv[2] ?? 'target/rune-web-settings-providers')
const files = await bundleAssetPaths(bundle)
const directory = '/fixture/project'
const project = {id:'catalogue',path:directory,location:{directory}}
const base = '/workspaces/catalogue/instance/api/'
const streams = new Map()
const unexpected = []
const reads = []
const mime = {'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.woff2':'font/woff2'}
let account = 'First fixture account', detached = false
const server = createServer(async (req,res) => {
  const url = new URL(req.url,'http://localhost')
  const p = url.pathname
  const json = value => res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value))
  try {
    if (p === '/api/meta') return json({apiContract:1,serverId:'fixture-settings',capabilities:['integrations']})
    if (p === '/api/auth/status') return json({authenticated:true})
    if (p === '/api/workspaces' && req.method === 'GET') return json([project])
    if (p === '/api/workspaces' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const {path:requested,requestId} = JSON.parse(body)
      assert.equal(requested,directory)
      return json({...project,requestId})
    }
    if (p === '/api/workspaces/catalogue' && req.method === 'DELETE') return res.writeHead(204).end()
    if (p === '/api/events') {
      const client = url.searchParams.get('clientId')
      if (detached && !client.endsWith('-preferences')) return res.writeHead(503).end()
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'})
      res.write(': ready\n\n')
      streams.set(client,res)
      res.on('close',()=>{if(streams.get(client)===res) streams.delete(client)})
      return
    }
    if (p.startsWith('/api/storage/')) return json({})
    if (p === '/api/workspaces/catalogue/worktrees') return json({repository:'uninitialized',worktrees:[]})
    if (p === '/api/workspaces/catalogue/provider-accounts/example') {
      assert.equal(url.searchParams.get('directory'),directory)
      return json({logins:{active:'account@example.test',secondary:'other@example.test'}})
    }
    if (p === `${base}session`) return json({data:[],cursor:{}})
    if (p.startsWith(base) && ['integration','provider','model','websearch/provider'].includes(p.slice(base.length))) {
      reads.push(p)
      const data = {
        integration:[{id:'example',name:'Fixture Provider',connections:[{type:'credential',id:'active',label:account}]}],
        provider:[{id:'example',name:'Fixture Provider'}],
        model:[{id:'model',providerID:'example'}],
        'websearch/provider':[],
      }
      return json({location:{directory},data:data[p.slice(base.length)]})
    }
    if (files.has(p)) {
      const filename = p === '/' ? '/index.html' : p
      const bytes = await readFile(path.join(bundle, filename))
      return res.writeHead(200,{'content-type':mime[path.extname(filename)] ?? 'application/octet-stream'}).end(bytes)
    }
    unexpected.push(`${req.method} ${p}`)
    res.writeHead(404).end()
  } catch (error) {
    unexpected.push(String(error))
    res.writeHead(500).end()
  }
})

await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
let browser
try {
  browser = await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined,args:['--enable-unsafe-webgpu','--use-angle=swiftshader']})
  const page = await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true})
  const click = name => page.getByRole('button',{name,exact:true}).click({force:true,timeout:15000})
  const visible = name => page.getByText(name,{exact:true}).waitFor({state:'attached',timeout:15000})
  await page.goto(`http://127.0.0.1:${server.address().port}/?locale=en`)
  await click('Connect')
  await click(directory)
  await visible('No session selected')
  await click('Providers')
  await visible(account)
  const nonConversation = () => Array.from(streams).find(([client])=>!client.endsWith('-preferences'))?.[1]
  assert(nonConversation(),'The catalogue has an EventSource without a conversation')
  account = 'default'
  nonConversation().write(`data: ${JSON.stringify({type:'instance.event',instanceId:'catalogue',event:{type:'credential.switched'}})}\n\n`)
  await visible('account@example.test')
  detached = true
  nonConversation().destroy()
  await page.getByText('account@example.test',{exact:true}).waitFor({state:'detached',timeout:15000})
  const atDisconnect = reads.length
  account = 'Reconnected fixture account'
  detached = false
  await visible(account)
  assert.equal(reads.length-atDisconnect,4,'The reconnected catalogue reloads its four source lists once')
  assert(!unexpected.some(entry=>/\/session-history|\/prompt|\/session\//.test(entry)),unexpected.join('\n'))
  console.log(JSON.stringify({fixture:'providers-web',updated:true,revokedWhileDisconnected:true,reconnected:true,requests:reads.length}))
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve=>server.close(resolve))
}
