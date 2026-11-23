import assert from 'node:assert/strict'
import test from 'node:test'
import {installTextContrast} from './text-contrast.mjs'

test('the dark field rejects high RGB deltas without readable contrast', async t => {
  t.after(() => { delete globalThis.__codenomadTextContrast })
  await installTextContrast({evaluate: fn => fn()})
  const contrast=globalThis.__codenomadTextContrast
  const darkInk=contrast('#1a1a1a','#373737')
  assert.equal(darkInk.ratio([55,55,55]).toFixed(2),'1.46')
  assert(!darkInk.matches([55,55,55]))
  assert(contrast('#1a1a1a','#eeeeee').matches([238,238,238]))
})
