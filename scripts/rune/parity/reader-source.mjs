// Capture the real Solid reader at the measured Rune reader rectangle.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { borrowFixture } from '../../../packages/ui/tests/browser/fixture-borrow.ts'
import { startRunDaemon } from '../../../packages/ui/tests/browser/fixture-daemon/run.ts'
import { fixtureEventStream } from '../../../packages/ui/tests/browser/fixture-event-stream.ts'
import { installPngReader } from '../png-pixels.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const native = path.resolve(root, 'target/rune-reader-scenes')
const out = path.resolve(root, 'target/rune-parity/workspace-reader')
const entry = path.resolve(root, 'scripts/rune/parity/reader-source.fixture.tsx').replaceAll('\\', '/')
await mkdir(out, { recursive: true })
const owner = await startRunDaemon({ uiRoot: path.join(root, 'packages/ui'), warmup: false, logPrefix: 'rune-reader-source-' })
let browser, fixture, stream
try {
  fixture = await borrowFixture({ name: 'reader-source', routes: [{ path: '/reader', html: `<html><body><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>` }] }, { endpoint: owner })
  stream = await fixtureEventStream(fixture.url)
  const origin = new URL(fixture.url).origin
  browser = await chromium.launch({ headless: true, executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  const reports = []
  const scenes = { source: ['reader.rs', '.monaco-editor .view-lines'], 'markup-md': ['markup.md', '.workspace-markdown h1'], 'small-png': ['small.png', '.workspace-image img'], 'nul-bin': ['nul.bin', '.workspace-file-view > .text-secondary'], 'unsupported-mmd': ['unsupported.mmd', '.mermaid-error'] }
  for (const theme of ['light', 'dark']) for (const [scene, [name, ready]] of Object.entries(scenes)) {
    const prefix = `en-${theme}-${scene}`
    const tree = JSON.parse(await readFile(path.join(native, `${prefix}.json`), 'utf8'))
    const reader = tree.elements.find(n => n.key?.startsWith('file-reader-'))
    assert(reader?.rect.every(Number.isInteger), 'Expected a pixel-aligned reader')
    const [x, y, width, height] = reader.rect
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme })
    const errors = [], storage = new Map()
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin !== origin) return route.abort()
      const mermaid = /^\/@mermaid-js\/tiny\/(LICENSE|dist\/mermaid\.tiny\.js)$/.exec(url.pathname)
      if (mermaid && url.searchParams.has('raw')) {
        const source = await readFile(path.join(root, 'node_modules/@mermaid-js/tiny', mermaid[1]), 'utf8')
        return route.fulfill({ contentType: 'text/javascript', body: `export default ${JSON.stringify(source)};` })
      }
      if (url.pathname.startsWith('/monaco/vs/')) return route.fulfill({ path: path.join(root, 'node_modules/monaco-editor/min/vs', url.pathname.slice('/monaco/vs/'.length)) })
      if (url.pathname === '/monaco.worker.js') return route.fulfill({ path: path.join(root, 'packages/ui/src/renderer/public/monaco.worker.js') })
      if (!url.pathname.startsWith('/api/')) return route.continue()
      if (url.pathname === '/api/events') return route.continue({ url: stream.url })
      if (url.pathname.startsWith('/api/storage/')) {
        if (request.method() === 'PATCH') storage.set(url.pathname, { ...storage.get(url.pathname), ...request.postDataJSON() })
        return route.fulfill({ json: storage.get(url.pathname) ?? {} })
      }
      if (url.pathname === '/api/workspaces' || url.pathname === '/api/panel-extensions') return route.fulfill({ json: [] })
      if (url.pathname === '/api/auth/status') return route.fulfill({ json: { authenticated: true, required: false } })
      return route.fulfill({ json: {} })
    })
    await page.addInitScript(() => Object.assign(window, {
      __CODENOMAD_RUNTIME_HOST__: 'electron', __CODENOMAD_WINDOW_CONTEXT__: 'local',
      electronAPI: { claimClientStateAccess: async () => true, loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: null }), saveClientState: async () => true },
    }))
    await page.goto(`${fixture.url}?${new URLSearchParams({ theme, name })}`, { waitUntil: 'domcontentloaded' })
    const view = page.locator('.workspace-file-view')
    await page.locator(ready).waitFor()
    if (scene === 'source') await page.waitForFunction(() => window.monaco?.editor.getModels().some(model => model.getValue().includes('été 日本語')))
    if (scene === 'small-png') await page.waitForFunction(() => document.querySelector('.workspace-image img')?.naturalWidth === 8)
    await page.evaluate(() => document.fonts.ready)
    assert.deepEqual(await view.boundingBox(), { x: 0, y: 0, width, height })
    const solid = await view.screenshot({ path: path.join(out, `${theme}-${scene}-solid.png`), animations: 'disabled' })
    const reference = await view.ariaSnapshot()
    const palette = await page.locator('html').getAttribute('data-color-scheme')
    const geometry = await view.evaluate(el => Object.fromEntries(['header', '.workspace-markdown h1', '.workspace-markdown img', '.workspace-image img', '.view-lines'].map(selector => [selector, el.querySelector(selector)?.getBoundingClientRect().toJSON()])))
    const links = scene === 'markup-md' ? await checkLinks(page) : undefined
    const chrome = tree.elements.find(n => n.key === 'file-close')
    assert.equal(chrome.rect[0] + chrome.rect[2] - x, width - 8, 'Dismiss stays trailing')
    if (scene === 'source') {
      const text = tree.elements.find(n => n.key === 'file-source-text')
      const { x: sx, y: sy } = geometry['.view-lines']
      assert(Math.abs(text.rect[0] - x - sx) <= 2 && Math.abs(text.rect[1] - y - sy) <= 2, 'Source text origin')
    }
    if (scene === 'markup-md') {
      const heading = tree.elements.find(n => n.role === 'heading' && n.text === 'Reader')
      const { x: hx, y: hy } = geometry['.workspace-markdown h1']
      assert(Math.abs(heading.rect[0] - x - hx) <= 1 && Math.abs(heading.rect[1] - y - hy) <= 1, 'Rendered heading origin')
      const image = tree.elements.find(n => n.role === 'image' && n.label === 'blocked')
      geometry.markdownImageOffset = image.rect[1] - y - geometry['.workspace-markdown img'].y
    }
    assert.deepEqual(errors, [])
    await page.close()
    const decode = await browser.newPage()
    try {
      await installPngReader(decode)
      const rune = await readFile(path.join(native, `${prefix}.png`))
      const [ref, actual] = await decode.evaluate(pngs => globalThis.__codenomadReadPngs(pngs), [solid, rune].map(b => `data:image/png;base64,${b.toString('base64')}`))
      let totalError = 0
      const samples = []
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
        const src = (row * width + col) * 4, dst = ((row + y) * actual.width + col + x) * 4
        for (let c = 0; c < 3; c++) totalError += Math.abs(ref.pixels[src + c] - actual.pixels[dst + c])
        if (col === Math.floor(width / 4) && [4, height - 42].includes(row)) samples.push([ref.pixels.slice(src, src + 3), actual.pixels.slice(dst, dst + 3)])
      }
      assert(samples.length === 2 && samples.every(([solid, rune]) => solid.every((c, i) => Math.abs(c - rune[i]) <= 1)), `${theme} ${scene}: surface palette ${JSON.stringify(samples)}`)
      // A frame-wide smoke budget; discrete geometry and interaction have their own checks.
      const rgbMeanError = totalError / (width * height * 3)
      assert(rgbMeanError <= 1.5, `${theme} ${scene}: mean RGB error ${rgbMeanError} > 1.5`)
      if (scene === 'source') {
        const gutterInkRight = (image, dx, dy, firstRow) => {
          const background = (dy + firstRow) * image.width + dx
          const ink = []
          for (let row = firstRow; row < firstRow + 16; row++) for (let col = 10; col < 52; col++) {
            const offset = ((row + dy) * image.width + dx + col) * 4
            if ([0, 1, 2].some(c => Math.abs(image.pixels[offset + c] - image.pixels[background * 4 + c]) > 45)) ink.push(col)
          }
          assert(ink.length > 0, 'Expected a visible first line number')
          return Math.max(...ink)
        }
        const row = Math.ceil(geometry['.view-lines'].y)
        assert(Math.abs(gutterInkRight(ref, 0, 0, row) - gutterInkRight(actual, x, y, row)) <= 2, 'Line number column')
      }
      reports.push({ theme, scene, palette, pixels: [width, height], rgbMeanError, samples, reference, geometry, links, nativeAccessibility: tree.accessibility })
    } finally {
      await decode.close()
    }
  }
  await writeFile(path.join(out, 'comparison.json'), JSON.stringify(reports, null, 2) + '\n')
  console.log(reports.map(({ theme, scene, palette, rgbMeanError }) => ({ theme, scene, palette, rgbMeanError })))
} finally {
  await browser?.close()
  await stream?.close()
  await fixture?.close()
  await owner.stop()
}

async function checkLinks(page) {
  // Use the same window click bridge as the local Tauri app, with an inert IPC receiver.
  await page.evaluate(async () => {
    window.readerOpens = []
    window.__TAURI_INTERNALS__ = { invoke: async (command, { url }) => {
      if (command !== 'open_external_url') throw Error(`Unexpected opener command: ${command}`)
      window.readerOpens.push(url)
    } }
    const { installExternalLinkClicks } = await import('/src/lib/native/external-link-clicks.ts')
    window.__CODENOMAD_RUNTIME_HOST__ = 'tauri'
    installExternalLinkClicks(window)
  })
  const anchor = page.locator('.workspace-markdown a')
  const expected = []
  for (const href of ['./notes.md', '#reader']) {
    await anchor.evaluate((link, href) => { link.setAttribute('href', href); link.focus() }, href)
    await page.keyboard.press('Space')
    assert.deepEqual(await page.evaluate(() => window.readerOpens), expected)
    await page.keyboard.press('Enter')
    expected.push(new URL(href, page.url()).href)
    await page.waitForFunction(count => window.readerOpens.length >= count, expected.length)
    assert.deepEqual(await page.evaluate(() => window.readerOpens), expected)
  }
  return expected
}
