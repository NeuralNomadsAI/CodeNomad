import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import path from 'node:path'
import {promisify} from 'node:util'
import {chromium} from 'playwright'

const [binary, bundle] = process.argv.slice(2)
assert(path.isAbsolute(binary) && path.isAbsolute(bundle), 'Pass native binary and wasm-bindgen output paths')
const assets = new Map([
  ['/probe.js', ['application/javascript', await readFile(path.join(bundle, 'probe.js'))]],
  ['/probe_bg.wasm', ['application/wasm', await readFile(path.join(bundle, 'probe_bg.wasm'))]],
])
const native = (type, data) => `data: ${JSON.stringify({
  type: 'instance.event', instanceId: 'workspace',
  event: {type, data: {sessionID: 'parent', assistantMessageID: 'msg', id: 'execute', ...data}},
})}\n\n`
const event = (kind, data) => native(`session.tool.${kind}`, data)
const progress = status => event('progress', {metadata: {toolCalls: Array.from({length: 4}, (_, i) => ({
  tool: 'write', status: i === 3 ? status : 'completed',
  input: {filePath: `fixture-${i}.txt`, content: 'x'.repeat(70 * 1024)},
}))}})
const first = progress('running')
assert(Buffer.byteLength(first) > 256 * 1024)
const huge = `data: {"type":"ignored","padding":"${'x'.repeat((32 << 20) + 8192)}"}\r\n\r\n`

async function exercise(run) {
  let streams = 0, reads = 0, ready = false
  let stream, timer, childActive = false
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    if (pathname === '/api/events') {
      streams++
      stream = res
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'})
      res.write(': fixture\n\n')
    } else if (pathname.endsWith('/session-history/window')) {
      void (async () => {
        let body = ''
        for await (const chunk of req) body += chunk
        const {sessionID} = JSON.parse(body)
        assert.notEqual(sessionID, 'foreign', 'must reject an unrelated child before reading its messages')
        if (sessionID === 'parent') reads++
        const messages = sessionID === 'child'
          ? (childActive ? [{id: 'child-step', type: 'assistant', time: {}, content: [
            {type: 'tool', id: 'read', name: 'read', state: {status: 'running', input: {filePath: 'child.txt'}}},
          ]}] : [])
          : [
            {id: 'msg', type: 'assistant', time: {}, content: [
              {type: 'tool', id: 'execute', name: 'execute', state: {status: 'running', input: {}, metadata: {}}},
            ]},
            ...(ready ? [{id: 'reread-proof', type: 'user', text: 'Authoritative recovery'}] : []),
          ]
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({status: 'window', latest: true, messages}))
      })().catch(err => res.writeHead(500).end(String(err)))
    } else if (pathname.endsWith('/session/parent')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({time: {busy: 1}}))
      if (!timer) timer = setTimeout(() => {
        if (!stream || stream.destroyed) return
        stream.write(first)
        ready = true
        stream.write(huge)
        stream.write(progress('completed'))
      }, 250)
    } else if (pathname === '/fixture/child' && stream) {
      childActive = true
      stream.write(event('called', {sessionID: 'child', assistantMessageID: 'child-step', id: 'read'}))
      stream.write(native('session.step.ended', {tokens: {input: 15, output: 4}, cost: 0.005}))
      stream.write(native('session.usage.updated', {tokens: {input: 40, output: 12}, cost: 0.02}))
      res.writeHead(204).end()
    } else if (/\/session\/(child|foreign)$/.test(pathname)) {
      const id = path.basename(pathname)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({data: {id, parentID: id === 'child' ? 'parent' : 'other', location: {directory: '/trial'}}}))
    } else if (pathname === '/') {
      res.writeHead(200, {'Content-Type': 'text/html'}).end('<!doctype html><title>Tool progress SSE probe</title>')
    } else if (assets.has(pathname)) {
      const [type, bytes] = assets.get(pathname)
      res.writeHead(200, {'Content-Type': type}).end(bytes)
    } else res.writeHead(404).end()
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}/`)
    assert.equal(streams, 1)
    assert(reads >= 2)
  } finally {
    clearTimeout(timer)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

await exercise(async url => { await promisify(execFile)(binary, [url], {windowsHide: true, timeout: 30_000}) })
console.log('Native SSE: four 70 KiB writes projected, oversized frame skipped, reread and scoped child refresh on one connection.')
const browser = await chromium.launch({executablePath: process.env.CODENOMAD_BROWSER_PATH})
try {
  await exercise(async url => {
    const page = await browser.newPage()
    await page.goto(url)
    await page.evaluate(async () => {
      const {default: init, observe} = await import('/probe.js')
      await init()
      await observe(location.origin)
    })
  })
  console.log('Chromium WASM EventSource: same progress, recovery, connection and usage checks.')
} finally {
  await browser.close()
}
