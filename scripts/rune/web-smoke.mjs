// Attach only to an explicitly supplied isolated loopback server. Never starts a server.
import assert from 'node:assert/strict'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {assertRenderedTextContrast} from './text-contrast.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const {values} = parseArgs({options: {url: {type: 'string'}, out: {type: 'string', default: 'target/rune-web-smoke'},
  executable: {type: 'string'}, locale: {type: 'string', default: 'fr'}, 'storage-state': {type: 'string'}}})
const url = new URL(values.url)
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use an isolated loopback server URL')
assert(!url.username && !url.password && ['http:', 'https:'].includes(url.protocol), 'Server URL must omit credentials')
url.searchParams.set('scene', 'synthetic')
url.searchParams.set('locale', values.locale)
const catalogueIndex = JSON.parse(await readFile(path.join(root, 'crates/rune-theme-codenomad/assets/catalogues.json'), 'utf8'))
assert(catalogueIndex.locales.includes(values.locale), 'Select a supported locale from the generated catalogue')
const messages = JSON.parse(await readFile(path.join(root, `crates/rune-theme-codenomad/assets/catalogues/${values.locale}.json`), 'utf8'))
const out = path.resolve(root, values.out)
const relativeOut = path.relative(path.join(root, 'target'), out)
assert(relativeOut && relativeOut !== '..' && !relativeOut.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeOut), 'Smoke output must stay inside this checkout target directory')
await mkdir(out, {recursive: true})
const browser = await chromium.launch({headless: true, ...(values.executable ? {executablePath: values.executable} : {}),
  args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader']})
const records = []
const imagePage = await browser.newPage()
const palette = JSON.parse(await readFile(path.join(root, 'crates/rune-theme-codenomad/assets/theme.json'), 'utf8'))
try {
  for (const [name, width, height, touch] of [['desktop', 960, 760, false], ['tablet', 768, 1024, true], ['phone', 390, 844, true]]) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch, colorScheme,
        ...(values['storage-state'] ? {storageState: values['storage-state']} : {})})
      const page = await context.newPage()
      const errors = [], forbiddenRequests = []
      page.on('pageerror', error => errors.push({name: error.name, message: error.message}))
      // This scene has no backend. Refuse accidental API access or external resources.
      await context.route('**/*', async route => {
        const requested = new URL(route.request().url())
        if (!['http:', 'https:'].includes(requested.protocol)) return route.continue()
        if (requested.origin !== url.origin || /^\/(api|workspaces)\//.test(requested.pathname)) {
          forbiddenRequests.push({origin: requested.origin, path: requested.pathname})
          return route.abort('blockedbyclient')
        }
        await route.continue()
      })
      const started = performance.now()
      try {
        await page.goto(url.href, {waitUntil: 'domcontentloaded', timeout: 60_000})
        await page.waitForFunction(() => ['ready', 'failed'].includes(globalThis.__codenomadRuneBoot?.state), undefined, {timeout: 60_000})
        assert.equal(await page.evaluate(() => globalThis.__codenomadRuneBoot.state), 'ready', 'Shared WASM app must initialize')
        await page.waitForFunction(() => document.querySelector('[data-rune-a11y] button'), undefined, {timeout: 30_000})
        const firstAccessibleMs = performance.now() - started
        assert.equal(await page.locator('html').getAttribute('lang'), values.locale)
        assert.equal(await page.locator('html').getAttribute('dir'), values.locale === 'he' ? 'rtl' : 'ltr')
        // Keyboard input is scoped to this headless page and goes through Rune's DOM bridge.
        let focused = false
        for (let tab = 0; tab < 12; tab++) {
          await page.keyboard.press('Tab')
          await page.waitForTimeout(30)
          focused = await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA')
          if (focused) break
        }
        assert(focused, 'Rune composer must be reachable through keyboard focus')
        const text = 'Rune web\nDeuxième ligne 🦀'
        await page.locator('textarea:focus').fill(text)
        await page.waitForFunction(expected => document.activeElement?.value === expected, text)
        assert.equal(await page.locator('textarea:focus').getAttribute('aria-label'), messages['rune.prompt'])
        const canvas = await page.locator('canvas').first().boundingBox()
        assert(canvas && canvas.width > 0 && canvas.height > 0, 'Rune must draw an actual canvas')
        assert(canvas.width <= width + 1 && canvas.height <= height + 1, 'Canvas must follow the supplied viewport')
        const snapshot = await page.locator('body').ariaSnapshot()
        assert(snapshot.includes(messages['rune.latest']), 'Latest control must appear in the real accessibility mirror')
        await writeFile(path.join(out, `${name}-${colorScheme}.aria.yml`), snapshot)
        await page.waitForLoadState('networkidle', {timeout: 30_000})
        const png = await page.screenshot({path: path.join(out, `${name}-${colorScheme}.png`)})
        const textRegions = await page.evaluate(title => {
          const nodes = [...document.querySelectorAll('[data-rune-a11y] p, [data-rune-a11y] h1, [data-rune-a11y] h2')]
          const crop = (name, predicate) => {
            const node = nodes.find(node => predicate(node.textContent ?? ''))
            if (!node) throw Error(`Missing drawn accessibility text region: ${name}`)
            const box = node.getBoundingClientRect()
            return {name, rect: [box.x, box.y, box.width, box.height], surface: 'surface-canvas'}
          }
          return [crop('header', text => text.startsWith(title)), crop('transcript', text => text.includes('fn main()'))]
        }, messages['window.title.main'])
        const composerBox = await page.getByRole('group', {name: messages['rune.prompt'], exact: true}).boundingBox()
        const sendBox = await page.getByRole('button', {name: messages['promptInput.overlay.send'], exact: true}).boundingBox()
        assert(composerBox && sendBox, 'Composer group and action expose their drawn bounds')
        const {['space-md']: md, ['space-sm']: sm} = palette.numbers[colorScheme]
        textRegions.push({name: 'composer', surface: 'surface-field', inset: sm,
          rect: [composerBox.x + md, composerBox.y + md, composerBox.width - md * 2, sendBox.y - sm - composerBox.y - md]})
        const textContrast = await assertRenderedTextContrast(imagePage, png, textRegions, palette[colorScheme])
        const measured = await page.evaluate(() => ({boot: globalThis.__codenomadRuneBoot,
          viewport: {width: innerWidth, height: innerHeight, touch: matchMedia('(pointer:coarse)').matches},
          canvases: [...document.querySelectorAll('canvas')].map(canvas => ({width: canvas.width, height: canvas.height})),
          resources: performance.getEntriesByType('resource').filter(entry => /\.(wasm|ttf|js)(?:$|\?)/.test(entry.name))
            .map(entry => ({path: new URL(entry.name).pathname, durationMs: entry.duration, transferBytes: entry.transferSize, encodedBodyBytes: entry.encodedBodySize})),
        }))
        assert.equal(forbiddenRequests.length, 0, 'Synthetic web smoke must stay offline from API and external origins')
        assert.equal(errors.length, 0, 'Web app must initialize and handle multiline input without JS exceptions')
        records.push({name, colorScheme, width, height, emulatedTouch: touch, firstAccessibleMs, canvasBounds: canvas, textContrast, ...measured, pass: true})
      } catch (error) {
        await page.screenshot({path: path.join(out, `${name}-${colorScheme}-failure.png`)}).catch(() => {})
        await writeFile(path.join(out, `${name}-${colorScheme}-failure.json`), JSON.stringify({error: error.message, errors, forbiddenRequests}, null, 2))
        throw error
      } finally {await context.close()}
    }
  }
} finally {
  await browser.close()
  await writeFile(path.join(out, 'smoke-report.json'), JSON.stringify({platform: process.platform, browser: 'Chromium headless',
    scene: 'synthetic', records, pending: ['real phone keyboard/IME/autocorrect/dictation', 'screen reader on physical device', 'phone power and sustained performance', 'Rust-server connected session flow']}, null, 2) + '\n')
}
console.log(`Rune web smoke evidence: ${out}`)
