// Compare the real Windows Rune view and the real Solid transcript with one native fixture.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {chromium} from 'playwright'
import {createServer} from 'vite'
import solid from 'vite-plugin-solid'
import {createFixtureCache} from '../../../packages/ui/tests/browser/fixture-cache.ts'
import {createFixtureShutdown} from '../../../packages/ui/tests/browser/fixture-shutdown.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const [binary, out] = process.argv.slice(2)
assert(binary && path.isAbsolute(binary) && out && path.isAbsolute(out), 'Pass an absolute binary and output directory')
await mkdir(out, {recursive: true})
const cache = await createFixtureCache()
const shutdown = createFixtureShutdown(cache)
const entry = '/tests/browser/fixtures/reveal-truncated-text.tsx'
const env = {...process.env, CODENOMAD_PROFILE: 'trial-transcript-parity'}
for (const name of Object.keys(env)) if (name.startsWith('RUNE_')) delete env[name]
env.RUNE_LOCALE = 'en'
let server, browser
try {
  server = await createServer({
    root: path.join(root, 'packages/ui'), configFile: false, cacheDir: cache.cacheDir,
    plugins: [shutdown.plugin, solid(), {name: 'transcript-parity', configureServer(s) {
      s.middlewares.use('/transcript', async (_request, reply) => {
        reply.setHeader('content-type', 'text/html')
        reply.end(await s.transformIndexHtml('/transcript', `<html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`))
      })
    }}],
    resolve: {dedupe: ['solid-js']}, optimizeDeps: {exclude: ['lucide-solid']},
    server: {host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: {allow: [root]}},
    logLevel: 'error',
  })
  shutdown.own(server)
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}/transcript?session=transcript`
  browser = await chromium.launch({headless: true, executablePath: process.env.CODENOMAD_BROWSER_PATH})
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({viewport: {width: 1000, height: 1200}, colorScheme: theme, locale: 'en-US'})
    await page.route('**/*', route => {
      const request = route.request()
      const target = new URL(request.url())
      if (target.origin !== new URL(url).origin) return route.abort()
      if (target.pathname.endsWith('/permission-receipts')) return route.fulfill({json: {receipts: []}})
      return target.pathname.startsWith('/api/') ? route.fulfill({json: {}}) : route.continue()
    })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url, {timeout: 120_000})
    await page.getByRole('heading', {name: 'Results'}).waitFor({timeout: 120_000})
    const tool = id => page.locator(`.tool-call[data-part-id="${id}"]`)
    await tool('search').waitFor()
    assert.match(await tool('search').innerText(), /return/)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({path: path.join(out, `solid-${theme}.png`), animations: 'disabled'})
    await writeFile(path.join(out, `solid-${theme}.aria.yml`), await page.locator('.message-stream').ariaSnapshot())
    await tool('read').locator('.tool-call-header-toggle').click()
    await tool('read').getByText('return 7;', {exact: true}).waitFor()
    assert.deepEqual(errors, [])
    await page.close()

    const tree = path.join(out, `rune-${theme}.json`)
    await promisify(execFile)(binary, ['--scene', 'transcript', '--at', '1', '--theme', theme, '--size', '1000x1200',
      '--scale', '1', '--tree', tree, '--snap', path.join(out, `rune-${theme}.png`)], {cwd: root, env, windowsHide: true, timeout: 90_000})
    const data = JSON.parse(await readFile(tree, 'utf8'))
    assert.equal(data.dark_system, theme === 'dark')
    const accessibility = JSON.stringify(data.accessibility)
    for (const label of ['Results', 'Grep return', 'demo.rs']) assert(accessibility.includes(label))
  }
} finally {
  try { await browser?.close() } finally {
    if (server) await server.close()
    else await cache.dispose()
  }
}
