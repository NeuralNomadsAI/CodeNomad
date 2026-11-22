import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import {shell, themeCss} from './web-shell.mjs'

test('HTML escapes catalogue values and preserves browser zoom', () => {
  const html = shell({title: '<title>', failed: '"<error>', loading: '<loading>', retry: '<retry>'}, 'rtl')
  assert(html.includes('dir="rtl"'))
  assert(html.includes('&lt;title&gt;') && html.includes('&quot;&lt;error&gt;'))
  assert(!html.includes('user-scalable=no') && !html.includes('maximum-scale=1'))
})
test('web boot theme uses both generated appearances and refuses CSS injection', async () => {
  const theme = JSON.parse(await readFile(new URL('../../crates/rune-theme-codenomad/assets/theme.json', import.meta.url), 'utf8'))
  const css = themeCss(theme)
  assert(css.includes(`--surface-canvas:${theme.strings.light['surface-canvas']}`))
  assert(css.includes(`--surface-canvas:${theme.strings.dark['surface-canvas']}`))
  assert(css.includes('(prefers-color-scheme:dark)'))
  const invalid = structuredClone(theme)
  invalid.strings.light['surface-canvas'] = 'red;}body{display:none'
  assert.throws(() => themeCss(invalid), /Unsafe CSS token/)
})
