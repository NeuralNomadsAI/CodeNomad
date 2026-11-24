import assert from 'node:assert/strict'
import {test} from 'node:test'
import {runInNewContext} from 'node:vm'
import {recordTouches} from './web-touch-trace.mjs'

test('recordTouches captures touch and touch-pointer DOM timings and drains before report writes', async () => {
  let binding, now = 100, releaseDelivery
  const listeners = new Map(), touches = [], deliveries = []
  const sandbox = {
    performance: {now: () => now, timeOrigin: 10},
    location: {pathname: '/'},
    addEventListener: (type, fn) => listeners.set(type, fn),
  }
  const page = {evaluate: fn => runInNewContext(`(${fn})()`, sandbox)}
  const context = {
    exposeBinding(_name, record) {
      binding = value => new Promise(resolve => {
        const deliver = () => {
          record({}, value)
          resolve()
        }
        if (releaseDelivery) deliver()
        else deliveries.push(deliver)
      })
      sandbox.__fixtureRecordTouch = binding
    },
    addInitScript(init) {
      runInNewContext(`(${init})()`, sandbox)
    },
    pages: () => [page],
  }
  const flush = await recordTouches(context, touches)

  const touch = (type, id, stamp) => listeners.get(type)({
    type, timeStamp: stamp, isTrusted: true, target: {tagName: 'CANVAS'},
    changedTouches: [{identifier: id, clientX: 195, clientY: 146}],
  })
  const pointer = (type, id, stamp, pointerType = 'touch') => listeners.get(type)({
    type, pointerId: id, pointerType, isPrimary: true, timeStamp: stamp, isTrusted: true,
    target: {tagName: 'CANVAS'}, clientX: 195, clientY: 146,
  })

  touch('touchstart', 4, 90)
  pointer('pointerdown', 4, 90, 'touch')
  pointer('pointerdown', 9, 90, 'mouse')
  now = 897.2
  touch('touchend', 4, 90)
  pointer('pointerup', 4, 90, 'touch')
  pointer('pointerup', 9, 90, 'mouse')

  let drained = false
  const barrier = flush().then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false)
  assert.equal(touches.length, 0)
  releaseDelivery = true
  while (deliveries.length) deliveries.shift()()
  await barrier
  assert.equal(drained, true)

  assert.equal(touches.length, 2)
  assert.equal(touches[0].kind, 'touch')
  assert.equal(touches[0].domMs, 797.2)
  assert.equal(touches[0].eventMs, 0)
  assert.equal(touches[1].kind, 'pointer')
  assert.equal(touches[1].pointerType, 'touch')
  assert.equal(touches[1].isPrimary, true)
  assert.equal(touches[1].domMs, 797.2)
  assert.equal(touches[1].eventMs, 0)

  now = 1000
  pointer('pointerdown', 5, 990)
  now = 1010
  pointer('pointermove', 5, 1000)
  now = 1015
  pointer('pointercancel', 5, 1005)
  await flush()
  assert.equal(touches[2].kind, 'pointer')
  assert.equal(touches[2].moves, 1)
  assert.equal(touches[2].firstMove.receivedAt, 1010)
  assert.equal(touches[2].end.type, 'pointercancel')
})
