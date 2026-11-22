// Both inputs must be captures of the actual component fixture, at identical geometry.
import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {installPngReader} from './png-pixels.mjs'

const {values} = parseArgs({options: {
  solid: {type: 'string'}, rune: {type: 'string'}, component: {type: 'string'},
  theme: {type: 'string'}, 'max-diff-ratio': {type: 'string'}, report: {type: 'string'},
}})
assert(values.component && ['light', 'dark'].includes(values.theme), 'Pass --component and --theme light|dark')
assert(values.solid && values.rune && values.report, 'Pass --solid, --rune and --report paths')
const maxDiffRatio = Number(values['max-diff-ratio'])
assert(values['max-diff-ratio'] !== undefined && Number.isFinite(maxDiffRatio) && maxDiffRatio >= 0 && maxDiffRatio <= 1,
  'Pass an explicitly reviewed --max-diff-ratio between 0 and 1')
const images = await Promise.all([values.solid, values.rune].map(async file => `data:image/png;base64,${(await readFile(file)).toString('base64')}`))
const browser = await chromium.launch({headless: true})
let result
try {
  const page = await browser.newPage()
  await installPngReader(page)
  result = await page.evaluate(async sources => {
    const images = await globalThis.__codenomadReadPngs(sources)
    const [a,b] = images
    if (a.width !== b.width || a.height !== b.height) throw Error('Fixture capture dimensions differ')
    const pixels = images.map(image => image.pixels)
    let different = 0
    for (let i = 0; i < pixels[0].length; i += 4) {
      if ([0, 1, 2, 3].some(channel => pixels[0][i + channel] !== pixels[1][i + channel])) different++
    }
    return {width: a.width, height: a.height, different, total: a.width * a.height, diffRatio: different / (a.width * a.height)}
  }, images)
} finally {await browser.close()}
const pass = result.diffRatio <= maxDiffRatio
await writeFile(values.report, JSON.stringify({component: values.component, theme: values.theme, solid: values.solid,
  rune: values.rune, method: 'exact RGBA pixel mismatch ratio', ...result, maxDiffRatio, pass}, null, 2) + '\n')
assert(pass, `${values.component} ${values.theme}: ${result.diffRatio} exceeds ${maxDiffRatio}`)
console.log(`${values.component} ${values.theme}: ${result.diffRatio} <= ${maxDiffRatio}`)
