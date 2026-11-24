import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'

const [bundle, output] = process.argv.slice(2)
assert(path.isAbsolute(bundle) && path.isAbsolute(output))
const manifest = JSON.parse(await readFile(path.join(bundle, 'bundle-manifest.json')))
assert.equal(manifest.testSupport, true)
const mime = { '.js':'text/javascript', '.html':'text/html', '.wasm':'application/wasm', '.css':'text/css', '.ttf':'font/ttf' }
const assets = new Set(manifest.files.map(({file}) => `/${file}`))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHx9moL0CAFNzQ+EMxFw9AAAAAElFTkSuQmCC', 'base64')
const observed = []
let deferred = 0
const images = createServer((req, res) => {
  observed.push({url:req.url, cookie:req.headers.cookie, referer:req.headers.referer})
  if (!['/cors.png', '/no-cors.png'].includes(req.url)) return res.writeHead(404).end()
  if (req.url === '/cors.png') res.setHeader('Access-Control-Allow-Origin', '*')
  res.writeHead(200, {'Content-Type':'image/png'}).end(png)
})
const web = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === `/api/workspaces/owned/session-media/session/result/0/4/${'a'.repeat(64)}`) {
    if (req.headers.cookie !== 'image_fixture=owned') return res.writeHead(401).end()
    deferred++
    return res.writeHead(200, {'Content-Type':'image/png'}).end(png)
  }
  const asset = url.pathname === '/' ? '/index.html' : url.pathname
  if (!assets.has(asset)) return res.writeHead(404).end()
  res.writeHead(200, {'Content-Type':mime[path.extname(asset)] ?? 'application/octet-stream'})
    .end(await readFile(path.join(bundle, asset.slice(1))))
})
const listen = server => new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
let browser
try {
  await Promise.all([listen(web), listen(images)])
  browser = await chromium.launch({executablePath:process.env.CODENOMAD_BROWSER_PATH, headless:true})
  const page = await browser.newPage({viewport:{width:1100,height:1000}})
  await page.context().addCookies([{name:'image_fixture', value:'owned', url:`http://127.0.0.1:${web.address().port}`}])
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${web.address().port}/?scene=transcript-images&locale=en&imagePort=${images.address().port}`)
  const mirror = page.locator('[data-rune-a11y]')
  for (const name of ['Attached PNG', 'Animated AVIF', 'Cross-origin PNG', 'Deferred PNG']) {
    const image = mirror.getByRole('img',{name,exact:true})
    await image.waitFor({state:'attached',timeout:30000})
    assert((await image.boundingBox())?.height > 0, name)
  }
  await mirror.getByText('Open image in browser',{exact:true}).waitFor({state:'attached'})
  assert.equal(await mirror.getByRole('img',{name:'PNG without CORS',exact:true}).count(),0)
  assert.equal(await mirror.getByRole('img',{name:'HTML rejected',exact:true}).count(),0)
  for (const url of ['/cors.png','/no-cors.png']) {
    assert(observed.some(request => request.url === url))
  }
  assert(observed.every(({cookie,referer}) => !cookie && !referer))
  assert.equal(deferred, 1)
  const enlarge = mirror.getByRole('button',{name:'Enlarge image',exact:true})
  await enlarge.focus()
  await page.keyboard.press('Enter')
  const dialog = mirror.getByRole('dialog',{name:'Attached PNG',exact:true})
  await dialog.waitFor({state:'attached'})
  await page.locator('canvas[role="application"]').focus()
  await page.keyboard.press('Escape')
  await dialog.waitFor({state:'detached'})
  assert.deepEqual(errors,[])
  await page.screenshot({path:path.join(output,'transcript-images.png')})
  console.log('WASM: attachment preview, animated AVIF, bounded remote image and no-CORS fallback verified.')
} finally {
  await browser?.close()
  await Promise.all([web,images].map(server => new Promise(resolve => server.close(resolve))))
}
