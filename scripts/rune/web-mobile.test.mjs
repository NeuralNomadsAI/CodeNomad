import assert from 'node:assert/strict'
import test from 'node:test'
import {assertMirroredTextboxState} from './web-mobile.mjs'

test('assertMirroredTextboxState enforces unfocused [data-rune-a11y] textbox exposure and focused deduplication', () => {
  const name = 'Message'
  assert.doesNotThrow(() => assertMirroredTextboxState({
    activeTag: 'CANVAS',
    activeLabel: null,
    mirrored: [{tag: 'DIV', role: 'textbox', label: name, width: 320, height: 44}],
  }, {name, focused: false}))

  assert.throws(() => assertMirroredTextboxState({
    activeTag: 'CANVAS',
    activeLabel: null,
    mirrored: [],
  }, {name, focused: false}), /must be exposed once in \[data-rune-a11y\]/)

  assert.throws(() => assertMirroredTextboxState({
    activeTag: 'CANVAS',
    activeLabel: null,
    mirrored: [{tag: 'DIV', role: 'textbox', label: name, width: 0, height: 44}],
  }, {name, focused: false}), /non-empty bounds/)

  assert.throws(() => assertMirroredTextboxState({
    activeTag: 'TEXTAREA',
    activeLabel: name,
    mirrored: [{tag: 'DIV', role: 'textbox', label: name, width: 320, height: 44}],
  }, {name, focused: false}), /must not hold native DOM focus/)

  assert.doesNotThrow(() => assertMirroredTextboxState({
    activeTag: 'TEXTAREA',
    activeLabel: name,
    mirrored: [],
  }, {name, focused: true}))

  assert.throws(() => assertMirroredTextboxState({
    activeTag: 'TEXTAREA',
    activeLabel: name,
    mirrored: [{tag: 'DIV', role: 'textbox', label: name, width: 320, height: 44}],
  }, {name, focused: true}), /must be omitted from \[data-rune-a11y\]/)

  assert.throws(() => assertMirroredTextboxState({
    activeTag: 'BODY',
    activeLabel: null,
    mirrored: [],
  }, {name, focused: true}), /must hold native DOM focus/)
})
