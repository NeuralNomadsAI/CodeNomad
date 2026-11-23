// Runs only Rune's offscreen tooling; never launches its native event loop.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {requireTestSupport} from '../../packages/rune-app/fixtures/fixture-binaries.mjs'
import {chromium} from 'playwright'
import {assertRenderedTextContrast} from './text-contrast.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const {values} = parseArgs({options: {
  binary: {type: 'string'}, out: {type: 'string', default: 'target/rune-headless'},
}})
assert(values.binary && path.isAbsolute(values.binary), 'Pass --binary with the absolute compiled codenomad-rune path')
requireTestSupport(values.binary)
const out = path.resolve(root, values.out)
await mkdir(out, {recursive: true})
const env = {...process.env, CODENOMAD_PROFILE: 'trial-rune-headless'}
for (const key of Object.keys(env)) if (key.startsWith('RUNE_')) delete env[key]
const script = path.join(root, 'scripts/rune/headless-interaction.json')
const files = []
const canvasByTheme = new Map()
const palette = JSON.parse(await readFile(path.join(root, 'crates/rune-theme-codenomad/assets/theme.json'), 'utf8'))
const browser = await chromium.launch({headless: true})
const imagePage = await browser.newPage()
async function run(theme, at, name) {
  const tree = path.join(out, `${name}-${theme}.json`)
  const snap = path.join(out, `${name}-${theme}.png`)
  const args = ['--scene', 'synthetic', '--script', script, '--theme', theme,
    '--at', at, '--tree', tree, '--snap', snap, '--size', '960x760', '--scale', '1']
  const log = await new Promise((resolve, reject) => {
    const child = spawn(values.binary, args, {cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']})
    let output = ''
    const timer = setTimeout(() => {child.kill(); reject(Error('Rune headless timed out'))}, 120_000)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      output += chunk
      if (output.length > 4 * 1024 * 1024) child.kill()
    })
    child.once('error', error => {clearTimeout(timer); reject(error)})
    child.once('close', code => {
      clearTimeout(timer)
      code === 0 ? resolve(output) : reject(Error(`Rune exited ${code}: ${output.slice(-4000)}`))
    })
  })
  await writeFile(path.join(out, `${name}-${theme}.log`), log)
  const data = JSON.parse(await readFile(tree, 'utf8'))
  assert.equal(data.dark_system, theme === 'dark', 'Rune must receive the requested appearance')
  assert(Array.isArray(data.elements) && data.elements.length > 0 && data.elements.length < 500,
    'Synthetic scene must keep the mounted element tree bounded')
  const historyRect = data.elements.find(element => element.key === 'history')?.rect
  assert(historyRect?.length === 4, 'History viewport must expose its actual clipping rectangle')
  const finalRect = data.elements.find(element => element.key === 'body-synthetic-9999')?.rect
  // Virtual rows may remain mounted in the overscan region. Visibility requires intersection
  // with the clipping history viewport as well as the window viewport, in presented coordinates.
  const intersects = (a, b) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0]
    && a[1] < b[1] + b[3] && a[1] + a[3] > b[1]
  const finalMessageVisible = Boolean(finalRect && intersects(finalRect, historyRect)
    && intersects(finalRect, [0, 0, ...data.viewport]))
  assert.equal(finalMessageVisible, name === 'edited', 'Wheel must leave the last message; Latest must restore it')
  if (name === 'edited') {
    const canvas = data.elements.find(element => element.key === 'application-shell')
    assert.equal(canvas?.fill, palette[theme]['surface-canvas'], 'App canvas must use the resolved token')
    canvasByTheme.set(theme, canvas.fill)
  }
  assert(data.accessibility, 'Rune must emit its actual accessibility tree')
  const nodes = []
  function walk(node) {if (!node || typeof node !== 'object') return; nodes.push(node); for (const child of node.children ?? []) walk(child)}
  walk(data.accessibility)
  const byKey = key => nodes.find(node => node.key === key)
  const scroll = byKey('history')?.scroll
  assert(scroll?.length === 3 && scroll.every(Number.isFinite), 'History must expose its actual accessibility scroll offset and maximum')
  if (name === 'reading') assert(scroll[1] < scroll[2] - 1, 'Wheel must move above the bottom of history')
  else assert(Math.abs(scroll[1] - scroll[2]) < 1, 'Latest must restore the actual bottom scroll offset')
  const findEditor = node => node?.role === 'multiline-text-input' ? node
    : node?.children?.map(findEditor).find(Boolean)
  const composer = findEditor(byKey('session-composer'))
  assert(composer, 'Composer missing from accessibility tree')
  assert.match(composer.role, /text/i, 'Composer must expose a text input role')
  assert(composer.name, 'Composer needs an accessible name')
  assert.equal(composer.value, 'Rune headless\nDeuxième ligne 🦀', 'Simulated paste must reach the real composer')
  for (const key of ['send', 'latest']) {
    assert.equal(byKey(key)?.role, 'button', `${key} must expose a button role`)
    assert(byKey(key)?.name, `${key} needs an accessible name`)
  }
  assert(!byKey('older'), 'Synthetic history has no older page')
  if (name === 'edited') assert(composer.states?.includes('focused'), 'Simulated focus must reach composer')
  const png = await readFile(snap)
  assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Rune snapshot must be PNG')
  let textContrast
  if (name === 'edited') {
    const element = key => data.elements.find(element => element.key === key)
    textContrast = await assertRenderedTextContrast(imagePage, png, [
      ...(element('app-title') ? [{name: 'titlebar', rect: element('app-title').rect, surface: 'surface-shade-strong', text: 'text-secondary'}] : []),
      {name: 'transcript', rect: finalRect, surface: 'surface-canvas'},
      {name: 'composer', rect: composer.bounds, surface: 'surface-field'},
    ], palette[theme])
  }
  files.push({theme, at, tree: path.basename(tree), snapshot: path.basename(snap), accessibilityNodes: nodes.length,
    historyViewport: historyRect, historyScroll: scroll, lastMessageRect: finalRect, lastMessageVisible: finalMessageVisible, textContrast})
}
try { for (const theme of ['light', 'dark']) {
  await run(theme, 'mark:reading', 'reading'); await run(theme, 'mark:end', 'edited')
} } finally { await browser.close() }
assert.notEqual(canvasByTheme.get('light'), canvasByTheme.get('dark'), 'App canvas must consume both appearance palettes')
await writeFile(path.join(out, 'qualification.json'), JSON.stringify({
  platform: process.platform, architecture: process.arch, binary: values.binary, files,
  verified: ['Rune accessibility roles/names/states', 'simulated multiline paste and focus',
    'bounded mounted scene, wheel navigation and return to latest', 'offscreen light/dark canvas palettes'],
  pending: ['Solid/Rune per-component pixel qualification', 'Rune/TUI measured latency adapter'],
}, null, 2) + '\n')
console.log(`Rune headless evidence: ${out}`)
