import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import path from 'node:path'
import {chromium} from 'playwright'

const bundle = process.argv[2]
assert(bundle && path.isAbsolute(bundle), 'Pass the absolute wasm-bindgen output directory')
const assets = new Map([
  ['/probe.js', ['application/javascript', await readFile(path.join(bundle, 'probe.js'))]],
  ['/probe_bg.wasm', ['application/wasm', await readFile(path.join(bundle, 'probe_bg.wasm'))]],
])
const frame = (kind, value) => `data: ${JSON.stringify({type: `storage.${kind}Changed`, owner: 'ui', value})}\n\n`
const large = frame('config', {padding: 'x'.repeat(300 * 1024)})
assert(Buffer.byteLength(large) > 256 * 1024 && Buffer.byteLength(large) < 2 * 1024 * 1024)
let streams = 0
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  if (pathname === '/api/events') {
    streams++
    res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'})
    res.end(`: fixture\n\n${frame('config', {})}${large}${frame('state', {})}`)
  } else if (pathname === '/') {
    res.writeHead(200, {'Content-Type': 'text/html'}).end('<!doctype html><title>Preference event probe</title>')
  } else if (assets.has(pathname)) {
    const [type, bytes] = assets.get(pathname)
    res.writeHead(200, {'Content-Type': type}).end(bytes)
  } else {
    res.writeHead(404).end()
  }
})
await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({executablePath: process.env.CODENOMAD_BROWSER_PATH})
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.evaluate(async () => {
    const {default: init, observe} = await import('/probe.js')
    await init()
    await observe(location.origin)
  })
  assert.equal(streams, 1)
  console.log('Chromium EventSource: small and large config events reached Settings and Git; state reached Settings only.')
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
