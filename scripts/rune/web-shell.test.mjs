import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import {pairShell, shell, themeCss} from './web-shell.mjs'

test('HTML escapes catalogue values, enables viewport-fit=cover, and preserves browser zoom', () => {
  const html = shell({title: '<title>', failed: '"<error>', loading: '<loading>', retry: '<retry>'}, 'rtl')
  assert(html.includes('dir="rtl"'))
  assert(html.includes('&lt;title&gt;') && html.includes('&quot;&lt;error&gt;'))
  assert(html.includes('content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"'))
  assert(!html.includes('user-scalable=no') && !html.includes('maximum-scale=1'))

  const pairHtml = pairShell({title: '<pair>', heading: '<head>', guidance: '"guide"'}, '', '')
  assert(pairHtml.includes('&lt;pair&gt;') && pairHtml.includes('&lt;head&gt;') && pairHtml.includes('&quot;guide&quot;'))
  assert(pairHtml.includes('content="width=device-width,initial-scale=1,viewport-fit=cover"'))
  assert(!pairHtml.includes('user-scalable=no') && !pairHtml.includes('maximum-scale=1'))
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
