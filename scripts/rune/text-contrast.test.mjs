import assert from 'node:assert/strict'
import test from 'node:test'
import {installTextContrast} from './text-contrast.mjs'

test('the dark field rejects high RGB deltas without readable contrast', async t => {
  t.after(() => { delete globalThis.__codenomadTextContrast })
  await installTextContrast({evaluate: fn => fn()})
  const {ratio,matches}=globalThis.__codenomadTextContrast('#1a1a1a','#eeeeee')
  assert.equal(ratio([55,55,55]).toFixed(2),'1.46')
  assert(!matches([55,55,55]))
  assert(matches([238,238,238]))
})
