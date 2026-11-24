// node --import tsx scripts/rune/parity/shell.mjs <absolute Rune test-support binary> [--right-panel-tabs]
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
import {requireTestSupport} from '../../../packages/rune-app/fixtures/fixture-binaries.mjs'
import {privateEnvironment} from '../../../packages/rune-app/fixtures/private-profile.mjs'
import {installPngReader} from '../png-pixels.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url)), binary = process.argv[2]
const tabsOnly = process.argv.includes('--right-panel-tabs')
assert(binary && path.isAbsolute(binary), 'Pass the absolute Rune test-support binary path')
assert.equal(process.platform, 'win32', 'Window shell qualification targets Windows')
requireTestSupport(binary)
const out = path.join(root, 'target/rune-parity', tabsOnly ? 'right-panel-tabs' : 'shell')
await mkdir(out, {recursive: true})
const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
const entry = '/tests/browser/fixtures/header-windows.tsx'
const server = await createServer({
  root: path.join(root, 'packages/ui'), configFile: false, cacheDir: cache.cacheDir, logLevel: 'error',
  plugins: [shutdown.plugin, solid(), {name: 'shell-parity', configureServer(s) {
    s.middlewares.use('/fixture', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(await s.transformIndexHtml('/fixture', `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`))
    })
  }}], resolve: {dedupe: ['solid-js']},
  optimizeDeps: {entries: [entry.slice(1)], exclude: ['lucide-solid']},
  server: {host: '127.0.0.1', port: 0, hmr: false, watch: null},
})
shutdown.own(server)
let browser
const report = []
// The header-only budget covers missing toolbar actions and independent rasterization.
// Semantic assertions below still require both fixed panel buttons and the same title.
const headerBudget = 0.10
try {
  await server.listen()
  browser = await chromium.launch({headless: true, executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined})
  async function scene(appearance, width, height, touch = false) {
    const page = await browser.newPage({viewport: {width, height}, ...(touch ? {isMobile:true,hasTouch:true} : {})})
    await page.route('**/api/**', route => route.fulfill({json: {}}))
    await page.emulateMedia({colorScheme: appearance, reducedMotion: 'reduce'})
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/fixture`)
    await page.waitForFunction(() => Boolean(window.fixture))
    // Match the unoverridden Source token inputs consumed by generate-theme.mjs.
    await page.evaluate(theme => {
      const root = document.documentElement
      for (const key of [...root.style].filter(key => key.startsWith('--'))) root.style.removeProperty(key)
      delete root.dataset.colorScheme
      root.setAttribute('data-theme', theme)
    }, appearance)
    await page.evaluate(() => document.fonts.ready)
    return page
  }
  for (const appearance of ['light', 'dark']) {
    if (tabsOnly) {
      for (const [device, width, height] of [['desktop',1400,900],['phone',390,844]]) {
        const mobile = device === 'phone', label = `${device}-${appearance}`
        const page = await scene(appearance, width, height, mobile)
        try {
          const toggle = page.getByRole('button',{name:'Right panel',exact:true})
          if (await toggle.getAttribute('aria-expanded') !== 'true') {
            if (mobile) await toggle.tap()
            else await toggle.click()
          }
          const names = ['Status','Files']
          const bar = page.locator(mobile ? '.session-floating-drawer .right-panel-tab-bar' : '.session-right-panel .right-panel-tab-bar')
          await bar.waitFor()
          if (mobile) await page.waitForFunction(() => {
            const paper = document.querySelector('.session-floating-drawer .MuiDrawer-paper')
            return paper && getComputedStyle(paper).transform === 'none'
          })
          const status = bar.getByRole('tab',{name:'Status',exact:true})
          if (await status.getAttribute('aria-selected') !== 'true') {
            if (mobile) await status.tap()
            else await status.click()
            await bar.getByRole('tab',{name:'Status',exact:true,selected:true}).waitFor()
          }
          const solid = []
          for (const name of names) {
            const tab = bar.getByRole('tab',{name,exact:true})
            await tab.waitFor()
            const box = await tab.boundingBox()
            assert(box && box.x >= 0 && box.x+box.width <= width, `${label}: Solid ${name} outside viewport`)
            solid.push({name, box, selected:await tab.getAttribute('aria-selected') === 'true'})
          }
          await page.screenshot({path:path.join(out,`solid-${label}.png`),animations:'disabled'})
          const env = {...await privateEnvironment(path.join(out,'profiles',label)),RUNE_LOCALE:'en'}
          const script = path.join(out,`${label}.json`)
          await writeFile(script,JSON.stringify({events:mobile ? [{t:0.5,type:'tap',key:'right-panel-toggle'}] : []}))
          const tree = path.join(out,`rune-${label}.json`), snap = path.join(out,`rune-${label}.png`)
          await promisify(execFile)(binary,['--gallery-shell','--size',`${width}x${height}`,'--theme',appearance,
            '--script',script,'--tree',tree,'--snap',snap,'--at','0.9'],{env,windowsHide:true,timeout:60000})
          const {elements} = JSON.parse(await readFile(tree,'utf8'))
          const rune = names.map((name,i) => {
            const tab = elements.find(node=>node.key === `right-panel-tab-${i}` && node.role === 'tab')
            assert(tab,`${label}: missing Rune tab ${name}`)
            assert(Math.abs(tab.rect[3]-solid[i].box.height)<=1,`${label}/${name}: Rune ${tab.rect[3]}, Solid ${solid[i].box.height}`)
            return {name, rect:tab.rect}
          })
          report.push({device,appearance,solid,rune})
        } finally { await page.close() }
      }
      continue
    }
    const page = await scene(appearance, 1400, 900)
    const frame = page.locator('.session-shell-frame')
    await frame.waitFor()
    const solidBox = await frame.boundingBox()
    const header = await page.locator('.session-toolbar').boundingBox()
    const solidClip = {x: solidBox.x, y: solidBox.y, width: solidBox.width, height: header.height}
    const solidPng = await page.screenshot({path: path.join(out, `solid-${appearance}.png`), clip: solidClip, animations: 'disabled'})
    await writeFile(path.join(out, `solid-${appearance}.aria.yml`), await frame.ariaSnapshot())
    const left = page.getByRole('button', {name: 'Left panel', exact: true})
    const right = page.getByRole('button', {name: 'Right panel', exact: true})
    const [leftBox, rightBox] = await Promise.all([left.boundingBox(), right.boundingBox()])
    await page.getByText('Fixture conversation', {exact: true}).first().waitFor()
    assert.equal(await left.getAttribute('aria-expanded'), 'true')
    await left.click()
    assert.equal(await left.getAttribute('aria-expanded'), 'false')
    const env = {...await privateEnvironment(path.join(out, 'profiles', appearance)), RUNE_LOCALE: 'en', CODENOMAD_PROFILE: 'trial-shell-parity'}
    const script = path.join(out, `${appearance}.json`)
    await writeFile(script, JSON.stringify({events: [{t: 0.5, type: 'tap', key: 'sessions-panel-toggle'}]}))
    async function capture(at, suffix) {
      const tree = path.join(out, `rune-${appearance}${suffix}.json`), snap = path.join(out, `rune-${appearance}${suffix}.png`)
      await promisify(execFile)(binary, ['--gallery-shell', '--size', '1400x900', '--theme', appearance, '--scale', '1',
        '--script', script, '--tree', tree, '--snap', snap, '--at', at], {env, windowsHide: true, timeout: 60_000})
      return {tree: JSON.parse(await readFile(tree, 'utf8')), snap}
    }
    const open = await capture('0.3', ''), closed = await capture('0.9', '-closed')
    const flatten = node => node ? [node, ...(node.children ?? []).flatMap(flatten)] : []
    for (const [capture, expanded] of [[open, true], [closed, false]]) {
      const nodes = flatten(capture.tree.accessibility)
      const node = nodes.find(node => node.key === 'sessions-panel-toggle')
      assert(node && node.role === 'button' && node.name === 'Left panel')
      assert(node.states.includes(expanded ? 'expanded' : 'collapsed'))
      assert(nodes.some(node => node.key === 'chat-title' && node.name === 'Fixture conversation'))
      const frame = capture.tree.elements.find(node => node.key === 'session-shell').rect
      for (const [key, box, name] of [['sessions-panel-toggle', leftBox, 'Left panel'], ['right-panel-toggle', rightBox, 'Right panel']]) {
        const toggle = nodes.find(item => item.key === key)
        assert(toggle && toggle.name === name && toggle.role === 'button')
        const [x, y, w, h] = toggle.bounds
        assert.equal(x + w / 2, box.x + box.width / 2)
        assert.equal(y + h / 2 - frame[1], box.y + box.height / 2 - solidBox.y)
      }
    }
    const frameY = open.tree.elements.find(node => node.key === 'session-shell').rect[1]
    await installPngReader(page)
    const compare = await page.evaluate(async ({images, frameY}) => {
      const [solid, rune] = await globalThis.__codenomadReadPngs(images)
      let different = 0
      if (solid.width !== rune.width || frameY + solid.height > rune.height) throw Error('Unmatched header crop')
      for (let i = 0; i < solid.pixels.length; i += 4) {
        const j = i + frameY * rune.width * 4
        if ([0, 1, 2, 3].some(k => solid.pixels[i + k] !== rune.pixels[j + k])) different++
      }
      return {width: solid.width, height: solid.height, different, ratio: different / (solid.width * solid.height)}
    }, {images: [solidPng, await readFile(open.snap)].map(png => `data:image/png;base64,${png.toString('base64')}`), frameY})
    report.push({appearance, solidClip, runeFrameTop: frameY, compare, headerBudget, expandedStates: [true, false]})
    await page.close()
  }
  await writeFile(path.join(out, 'evidence.json'), JSON.stringify(report, null, 2))
  if (!tabsOnly) {
    for (const entry of report) assert(entry.compare.ratio <= headerBudget, `${entry.appearance}: shell header pixel budget exceeded`)
    const rtlTree = path.join(out, 'rune-caption-rtl.json')
    const env = {...await privateEnvironment(path.join(out, 'profiles', 'rtl')), RUNE_LOCALE: 'he', CODENOMAD_PROFILE: 'trial-shell-parity'}
    await promisify(execFile)(binary, ['--gallery-shell', '--tree', rtlTree, '--size', '390x760', '--at', '0.4'],
      {env, windowsHide: true, timeout: 60_000})
    const {elements} = JSON.parse(await readFile(rtlTree, 'utf8'))
    const caption = elements.find(node => node.key === 'rune-caption').rect
    assert.equal(caption[0], 0)
    for (const menu of elements.filter(node => node.key?.startsWith('window.menu.'))) {
      assert(menu.rect[0] >= caption[2], `${menu.key} overlaps the left Windows caption controls`)
    }
  }
} finally {
  try { await browser?.close() } finally { await server.close() }
}
