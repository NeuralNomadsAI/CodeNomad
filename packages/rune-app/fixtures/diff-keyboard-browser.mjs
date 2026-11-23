// Qualify the actual Rune WASM transcript, without a backend or OpenCode.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'

const [bundle, output] = process.argv.slice(2)
assert(path.isAbsolute(bundle) && path.isAbsolute(output))
const manifest = JSON.parse(await readFile(path.join(bundle, 'bundle-manifest.json')))
assert.equal(manifest.testSupport, true)
const MIME = { '.js':'text/javascript', '.html':'text/html', '.wasm':'application/wasm', '.css':'text/css', '.ttf':'font/ttf' }
const names = new Set(manifest.files.map(file => `/${file.file}`))
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const asset = url.pathname === '/' ? '/index.html' : url.pathname
  if (!names.has(asset)) return res.writeHead(404).end()
  const bytes = await readFile(path.join(bundle, asset.slice(1)))
  res.writeHead(200, { 'Content-Type': MIME[path.extname(asset)] ?? 'application/octet-stream' }).end(bytes)
})
let browser
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH, headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 1080 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/?scene=transcript&locale=fr`)
  const surface = page.locator('[data-rune-a11y]')
  const collapse = surface.getByRole('button', { name: 'Collapse file', exact: true })
  const expand = surface.getByRole('button', { name: 'Expand file', exact: true })
  await collapse.waitFor({ state:'attached', timeout: 30000 })
  await collapse.focus()
  await page.keyboard.press('Enter')
  await expand.waitFor({ state:'attached' })
  assert.equal(await expand.getAttribute('aria-expanded'), 'false')
  await expand.focus()
  await page.keyboard.press('Space')
  await collapse.waitFor({ state:'attached' })
  assert.equal(await collapse.getAttribute('aria-expanded'), 'true')
  assert.deepEqual(errors, [])
  await page.screenshot({ path: path.join(output, 'diff-keyboard-fr.png') })
  console.log('Keyboard collapse and expansion confirmed in the Rune WASM transcript.')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
