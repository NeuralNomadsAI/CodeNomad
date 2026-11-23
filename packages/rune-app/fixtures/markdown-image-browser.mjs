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
const cases = JSON.parse(await readFile(new URL('../tests/fixtures/reader-content.json', import.meta.url), 'utf8'))
const png = Buffer.from(cases.images.find(image => image.name === 'small.png').base64, 'base64')
const bmp = Buffer.alloc(62)
bmp.write('BM')
bmp.writeUInt32LE(bmp.length, 2)
bmp.writeUInt32LE(54, 10)
bmp.writeUInt32LE(40, 14)
bmp.writeInt32LE(1, 18)
bmp.writeInt32LE(-2, 22)
bmp.writeUInt16LE(1, 26)
bmp.writeUInt16LE(24, 28)
const measurement = Buffer.from(bmp)
measurement.writeInt32LE(-8193, 22)
let jpeg
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
  const body = request.url === '/packed.png' ? Buffer.from([0x1f, 0x8b])
    : request.url === '/dimensions.bmp' ? measurement
    : request.url === '/top-down.bmp' ? bmp : request.url === '/filled.jpg' ? jpeg : png
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
  await page.addInitScript(() => {
    delete AbortSignal.any
    delete AbortSignal.timeout
  })
  await page.goto(`${origin}/?private=path`)
  await page.waitForFunction(() => globalThis.readImage)
  assert.match(await page.evaluate(() => globalThis.document.cookie), /codenomad=private/)
  const baseline = Buffer.from(await page.evaluate(async () => {
    const canvas = globalThis.document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    canvas.getContext('2d').fillRect(0, 0, 1, 1)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'))
    return [...new Uint8Array(await blob.arrayBuffer())]
  }))
  const sof = baseline.indexOf(Buffer.from([0xff, 0xc0]))
  assert(sof > 0)
  jpeg = Buffer.concat([baseline.subarray(0, sof), Buffer.from([0xff]), baseline.subarray(sof)])
  const result = await page.evaluate(async ({ origin, imageOrigin }) => {
    const load = (name, limit) => globalThis.readImage(origin, `${imageOrigin}/${name}`, limit)
    const decode = async name => {
      const bytes = await load(name, 4096)
      const bitmap = await createImageBitmap(new Blob([bytes]))
      try { return [bitmap.width, bitmap.height] } finally { bitmap.close() }
    }
    return {
      png: [...await load('valid.png', 1024)],
      packed: await load('packed.png', 1024).then(() => null, String),
      oversized: await load('oversized.png', 4).then(() => null, String),
      dimensions: await load('dimensions.bmp', 1024).then(() => null, String),
      bmp: await decode('top-down.bmp'),
      jpeg: await decode('filled.jpg'),
      cors: await load('without-cors.png', 1024).then(() => null, String),
    }
  }, { origin, imageOrigin })
  assert.deepEqual(result.png, [...png])
  assert.match(result.packed, /compressed Markdown/)
  assert.match(result.oversized, /oversized|unavailable Markdown/)
  assert.match(result.dimensions, /unavailable Markdown/)
  assert.deepEqual(result.bmp, [1, 2])
  assert.deepEqual(result.jpeg, [2, 2])
  assert.match(result.cors, /unavailable Markdown/)
  assert.deepEqual(requests.map(request => request.path), ['/valid.png', '/packed.png', '/oversized.png', '/dimensions.bmp', '/top-down.bmp', '/filled.jpg', '/without-cors.png'])
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
