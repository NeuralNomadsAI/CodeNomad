import assert from 'node:assert/strict'
import {execFileSync, spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import {createServer, request} from 'node:http'
import path from 'node:path'
import {chromium} from 'playwright'
import {bundleAssetPaths} from '../../../scripts/rune/web-workspace-policy.mjs'
import {serverBinary} from './fixture-binaries.mjs'
import {privateEnvironment} from './private-profile.mjs'

const bundle = path.resolve(process.argv[2])
const loseCreation = !process.argv.includes('--success')
const files = await bundleAssetPaths(bundle)
const profile = await mkdtemp(path.join(process.env.RUNE_FIXTURE_ARTIFACTS ?? process.env.TEMP, 'memory-cleanup-'))
const project = path.join(profile, 'project')
const env = await privateEnvironment(profile)
const repository = path.join(env.CLI_CONFIG, 'memory')
await mkdir(project, {recursive:true})
await mkdir(path.join(repository, 'global'), {recursive:true})
await writeFile(path.join(env.CLI_CONFIG, 'config.yaml'), 'server:\n  memoryEnabled: true\n')
await writeFile(path.join(repository,'global','fixture.md'), [
  '---','id: fixture','title: Fixture note','type: fact',
  "createdAt: '2026-01-01T00:00:00.000Z'","updatedAt: '2026-01-01T00:00:00.000Z'",
  'sessionId: ses_fixture','---','The fixture is synthetic.',
].join('\n'))
const git = (...args) => execFileSync('git',args,{cwd:repository,env,windowsHide:true,stdio:'pipe'})
git('init','--initial-branch=main')
git('add','--','global/fixture.md')
git('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m','Seed fixture')

const counts = {nativeCreates:0,nativePrompts:0,forwardedCreates:0,lostCreations:0}
const sessions = []
const promptedSessions = []
const native = createServer(async (req,res) => {
  const url = new URL(req.url,'http://127.0.0.1')
  let raw = ''
  for await (const chunk of req) raw += chunk
  const json = value => res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value))
  if (url.pathname === '/api/event') {
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.write(`data: ${JSON.stringify({id:'event-fixture',type:'server.connected',created:Date.now(),data:{}})}\n\n`)
    return
  }
  if (url.pathname === '/api/location') return json({data:{directory:project}})
  if (url.pathname === '/api/session' && req.method === 'POST') {
    counts.nativeCreates++
    assert.deepEqual(JSON.parse(raw),{title:'Tidy up',location:{directory:project}})
    const session = {id:`ses_memory_cleanup_${counts.nativeCreates}`,title:'Tidy up',projectID:'fixture',location:{directory:project},time:{created:counts.nativeCreates,idle:1}}
    sessions.push(session)
    return json({data:session})
  }
  if (url.pathname === '/api/session') return json({data:sessions,cursor:{}})
  const session = sessions.find(session=>session.id===url.pathname.split('/')[3])
  if (session && url.pathname === `/api/session/${session.id}`) return json({data:session})
  if (session && url.pathname === `/api/session/${session.id}/environment`) return json({data:{}})
  if (session && url.pathname.endsWith('/prompt')) {
    counts.nativePrompts++
    promptedSessions.push(session.id)
    const input = JSON.parse(raw)
    assert.match(input.text,/^Review and tidy only the global scope/)
    return json({data:{id:input.id,sessionID:session.id}})
  }
  if (url.pathname === '/api/plugin') return json({location:{directory:project},data:[]})
  if (url.pathname === '/api/rpc/codenomad.missions/scheduleCarrierRead') return json({output:{owned:false}})
  res.writeHead(404).end()
})
await new Promise(resolve=>native.listen(0,'127.0.0.1',resolve))
const rust = spawn(serverBinary,[profile,path.join(profile,'identity.json'),'0','synthetic-only'],{
  cwd:profile,windowsHide:true,stdio:['pipe','pipe','pipe'],
  env:{...env,CNRS_SERVER_PASSWORD:'fixture-backend',CNRS_FIXTURE_URL:`http://127.0.0.1:${native.address().port}/`,
    CNRS_FIXTURE_PASSWORD:'fixture-native',CNRS_FIXTURE_STDIN_STOP:'1'},
})
let log = '', proxy, browser, page, creationPath
const traffic = []
rust.stdout.on('data',chunk=>log+=chunk)
rust.stderr.on('data',chunk=>log+=chunk)
const mime = {'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json'}
try {
  let origin
  for (const until = Date.now()+20_000; !origin;) {
    assert(Date.now()<until && rust.exitCode===null,log)
    origin = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
    if (!origin) await new Promise(resolve=>setTimeout(resolve,25))
  }
  const login = await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({username:'codenomad',password:'fixture-backend'})})
  assert.equal(login.status,200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  proxy = createServer(async(req,res)=>{
    const url = new URL(req.url,origin)
    if (files.has(url.pathname)) {
      const filename = url.pathname === '/' ? '/index.html' : url.pathname
      const bytes = await readFile(path.join(bundle,filename))
      return res.writeHead(200,{'content-type':mime[path.extname(filename)] ?? 'application/octet-stream'}).end(bytes)
    }
    const create = req.method === 'POST' && url.pathname.endsWith('/instance/api/session')
    if (create) {
      counts.forwardedCreates++
      creationPath = url.pathname
    }
    const headers = {...req.headers,host:url.host,cookie}
    const fixtureOrigin = `http://127.0.0.1:${proxy.address().port}`
    if (headers.origin === fixtureOrigin) headers.origin = origin
    if (headers.referer?.startsWith(`${fixtureOrigin}/`)) headers.referer = origin + headers.referer.slice(fixtureOrigin.length)
    const up = request(url,{method:req.method,headers},reply=>{
      if (!url.pathname.startsWith('/api/events')) traffic.push(`${req.method} ${url.pathname} ${reply.statusCode}`)
      if (loseCreation && counts.lostCreations===0 && create && reply.statusCode>=200 && reply.statusCode<300) {
        counts.lostCreations++
        res.writeHead(reply.statusCode,{'content-type':'application/json','content-length':'512'})
        res.write('{"data":')
        reply.resume()
        return reply.on('end',()=>setTimeout(()=>res.destroy(),50))
      }
      res.writeHead(reply.statusCode,reply.headers)
      reply.pipe(res)
    })
    up.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end()})
    res.on('close',()=>up.destroy())
    req.pipe(up)
  })
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve))
  browser = await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined,args:['--enable-unsafe-webgpu','--use-angle=swiftshader']})
  page = await browser.newPage({viewport:{width:900,height:780}})
  const button = name=>page.getByRole('button',{name,exact:true})
  const click = name=>button(name).click({force:true,timeout:15_000})
  await page.goto(`http://127.0.0.1:${proxy.address().port}/?locale=en`)
  await click('Connect')
  await button('Open').waitFor({state:'attached',timeout:10_000})
  const field = page.locator('textarea:focus')
  for (let i=0; i<16 && (!await field.count() || await field.getAttribute('aria-label')!=='Folder'); i++) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(20)
  }
  assert.equal(await field.getAttribute('aria-label',{timeout:3000}),'Folder')
  await field.fill(project)
  await page.keyboard.press('Enter')
  await page.getByText('No session selected',{exact:true}).waitFor({state:'attached'})
  await click('Settings')
  await page.getByRole('radio',{name:'About you',exact:true}).click({force:true})
  const confirm = async (before) => {
    await page.getByRole('button',{name:/^Entries 1\/60/}).waitFor({state:'attached'})
    await click('Tidy up')
    await page.getByText('Review and tidy “About you” in a new project session?',{exact:true}).waitFor({state:'attached'})
    assert.equal(counts.nativeCreates,before,'No new creation before consent')
    await button('Tidy up').last().click({force:true})
  }
  await confirm(0)
  if (loseCreation) {
    const alert = page.getByText("Cleanup could not be confirmed. Check the project's sessions before trying again.",{exact:true})
    await alert.waitFor({state:'attached'})
    // Activate the visible control if projected, or attempt keyboard activation.
    if (await button('Tidy up').count()) await click('Tidy up')
    else await page.keyboard.press('Enter')
    assert.equal(await page.getByText('Review and tidy “About you” in a new project session?',{exact:true}).count(),0)
    assert.deepEqual(counts,{nativeCreates:1,nativePrompts:0,forwardedCreates:1,lostCreations:1})
    await click('Close settings')
    const inventory = await fetch(`${origin}${creationPath}`,{headers:{cookie}})
    assert((await inventory.json()).data.some(row=>row.id===sessions[0].id),'the created session remains discoverable')
    await click('Settings')
    await alert.waitFor({state:'detached'})
    await confirm(1)
  }
  for (const until = Date.now()+10_000; counts.nativePrompts===0;) {
    assert(Date.now()<until,'No prompt passed the real Rust proxy')
    await new Promise(resolve=>setTimeout(resolve,25))
  }
  const created = loseCreation ? 2 : 1
  assert.deepEqual(counts,{nativeCreates:created,nativePrompts:1,forwardedCreates:created,lostCreations:Number(loseCreation)})
  assert.deepEqual(promptedSessions,[sessions[created-1].id],'Only the new, confirmed session receives the prompt')
  assert(log.includes('127.0.0.1'), 'the real backend launched')
  console.log(JSON.stringify({fixture:'real-rust-memory-cleanup',...counts}))
} catch (error) {
  console.error(JSON.stringify({profile,traffic,mirror:await page?.locator('[data-rune-a11y]').first().textContent({timeout:1000}).catch(()=>null)}))
  throw error
} finally {
  await browser?.close()
  if (proxy) {
    proxy.closeAllConnections()
    await new Promise(resolve=>proxy.close(resolve))
  }
  native.closeAllConnections()
  await new Promise(resolve=>native.close(resolve))
  await writeFile(path.join(profile,'server.log'),log)
  if (rust.exitCode===null && rust.signalCode===null) {
    const stopped = once(rust,'close')
    rust.stdin.end('shutdown\n')
    const timer = setTimeout(()=>rust.kill(),5000)
    try { await stopped } finally { clearTimeout(timer) }
  }
}
