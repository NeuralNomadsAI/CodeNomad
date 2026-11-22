// Run with --bundle pointing to an isolated wasm-bindgen build of the image probe.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'

const { values: { bundle, executable } } = parseArgs({
  options: { bundle: { type: 'string' }, executable: { type: 'string' } },
})
assert(bundle && path.isAbsolute(bundle))
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const files = new Map([
  ['/', ['text/html', '<script type="module" src="/boot.js"></script>']],
  ['/boot.js', ['text/javascript', 'import init,{read_image} from "./app.js"; await init(); globalThis.readImage = read_image']],
  ['/app.js', ['text/javascript', await readFile(path.join(bundle, 'app.js'))]],
  ['/app_bg.wasm', ['application/wasm', await readFile(path.join(bundle, 'app_bg.wasm'))]],
])
const requests = []
const document = createServer((request, response) => {
  const asset = files.get(new URL(request.url, 'http://127.0.0.1').pathname)
  if (!asset) return response.writeHead(404).end()
  response.writeHead(200, { 'Content-Type': asset[0], 'Set-Cookie': 'codenomad=private; Path=/' }).end(asset[1])
})
const pictures = createServer((request, response) => {
  requests.push({ path: request.url, headers: request.headers })
  const body = request.url === '/packed.png' ? Buffer.from([0x1f, 0x8b]) : png
  if (request.url !== '/without-cors.png') response.setHeader('Access-Control-Allow-Origin', '*')
  response.writeHead(200, { 'Content-Type': 'image/png' }).end(body)
})
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
})
let browser
try {
  const origin = await listen(document)
  const imageOrigin = await listen(pictures)
  browser = await chromium.launch({ headless: true, executablePath: executable })
  const page = await browser.newPage()
  await page.goto(`${origin}/?private=path`)
  await page.waitForFunction(() => globalThis.readImage)
  assert.match(await page.evaluate(() => globalThis.document.cookie), /codenomad=private/)
  const result = await page.evaluate(async ({ origin, imageOrigin }) => {
    const load = (name, limit) => globalThis.readImage(origin, `${imageOrigin}/${name}`, limit)
    return {
      png: [...await load('valid.png', 1024)],
      packed: await load('packed.png', 1024).then(() => null, String),
      oversized: await load('oversized.png', 4).then(() => null, String),
      cors: await load('without-cors.png', 1024).then(() => null, String),
    }
  }, { origin, imageOrigin })
  assert.deepEqual(result.png, [...png])
  assert.match(result.packed, /compressed Markdown/)
  assert.match(result.oversized, /oversized|unavailable Markdown/)
  assert.match(result.cors, /unavailable Markdown/)
  assert.deepEqual(requests.map(request => request.path), ['/valid.png', '/packed.png', '/oversized.png', '/without-cors.png'])
  for (const request of requests) {
    for (const header of ['cookie', 'authorization', 'referer']) assert.equal(request.headers[header], undefined)
  }
  console.log('Browser image fetch preserved CORS, privacy and size bounds')
} finally {
  await browser?.close()
  for (const server of [document, pictures]) {
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  }
}
