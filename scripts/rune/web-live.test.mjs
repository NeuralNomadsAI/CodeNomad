import assert from 'node:assert/strict'
import {test} from 'node:test'
import {admitLiveRoute, assertSse503Backoff, shouldServeSse503} from './web-live.mjs'
import {workspacePolicy} from './web-workspace-policy.mjs'

const origin = 'https://127.0.0.1:12345'
const project = 'D:/private/projects/synthetic'
const req = (url, {method = 'GET', cookie = 'private=fixture'} = {}) => ({
  url: () => url,
  method: () => method,
  postDataJSON: () => null,
  allHeaders: async () => (cookie ? {cookie} : {}),
})

test('admitLiveRoute records policy refusals in forbiddenRequests', async () => {
  const policy = workspacePolicy({origin, project})
  const forbiddenRequests = []
  assert.equal(await admitLiveRoute(req(`${origin}/api/auth/status`), {policy, origin, forbiddenRequests}), true)
  assert.equal(await admitLiveRoute(req(`${origin}/api/events?clientId=1`), {policy, origin, forbiddenRequests}), true)
  assert.deepEqual(forbiddenRequests, [])

  assert.equal(await admitLiveRoute(req(`${origin}/api/auth/status`, {cookie: ''}), {policy, origin, forbiddenRequests}), false)
  assert.equal(await admitLiveRoute(req('https://localhost:12345/api/auth/status'), {policy, origin, forbiddenRequests}), false)
  assert.equal(await admitLiveRoute(req(`${origin}/api/auth/status`, {method: 'POST'}), {policy, origin, forbiddenRequests}), false)
  assert.deepEqual(forbiddenRequests, [
    {origin, path: '/api/auth/status'},
    {origin: 'https://localhost:12345', path: '/api/auth/status'},
    {origin, path: '/api/auth/status'},
  ])
})

test('admitLiveRoute enforces GET, origin, and cookie without a policy and reports refusals', async () => {
  const forbiddenRequests = []
  const reported = []
  const onForbidden = err => reported.push(err.message)
  assert.equal(await admitLiveRoute(req(`${origin}/api/auth/status`), {origin, forbiddenRequests, onForbidden}), true)
  assert.equal(await admitLiveRoute(req(`${origin}/api/events`, {cookie: ''}), {origin, forbiddenRequests, onForbidden}), false)
  assert.equal(await admitLiveRoute(req('https://evil.test/api/events'), {origin, forbiddenRequests, onForbidden}), false)
  assert.equal(await admitLiveRoute(req(`${origin}/api/auth/status`, {method: 'POST'}), {origin, forbiddenRequests, onForbidden}), false)
  assert.deepEqual(forbiddenRequests, [
    {origin, path: '/api/events'},
    {origin: 'https://evil.test', path: '/api/events'},
    {origin, path: '/api/auth/status'},
  ])
  assert.deepEqual(reported, [
    `Forbidden live route request: GET ${origin}/api/events`,
    'Forbidden live route request: GET https://evil.test/api/events',
    `Forbidden live route request: POST ${origin}/api/auth/status`,
  ])
})

test('SSE 503 backoff handles single-slot (3 probes) and multiplexed two-slot (4-5 probes) episodes', () => {
  const probe = (receivedAt, fulfilledAt = receivedAt) => ({receivedAt, fulfilledAt})

  const single = [probe(0, 5), probe(1020, 1025), probe(3040, 3045)]
  assert.equal(shouldServeSse503(single.slice(0, 1)), true)
  assert.equal(shouldServeSse503(single.slice(0, 2)), true)
  assert.equal(shouldServeSse503(single), false)
  assert.deepEqual(assertSse503Backoff(single), {retryDelay1Ms: 1015, retryDelay2Ms: 2015, coalescedSlotProbes: 0})

  const muxFast = [probe(0, 5), probe(15, 20), probe(1030, 1035), probe(3050, 3055)]
  assert.equal(shouldServeSse503(muxFast.slice(0, 3)), true)
  assert.equal(shouldServeSse503(muxFast), false)
  assert.deepEqual(assertSse503Backoff(muxFast), {retryDelay1Ms: 1010, retryDelay2Ms: 2015, coalescedSlotProbes: 1})

  const muxSlowHandover = [probe(0, 5), probe(820, 825), probe(1840, 1845), probe(3860, 3865)]
  assert.equal(shouldServeSse503(muxSlowHandover.slice(0, 3)), true)
  assert.equal(shouldServeSse503(muxSlowHandover), false)
  assert.deepEqual(assertSse503Backoff(muxSlowHandover), {retryDelay1Ms: 1015, retryDelay2Ms: 2015, coalescedSlotProbes: 1})

  const muxAfterRetry1 = [probe(0, 5), probe(1015, 1020), probe(1520, 1525), probe(2535, 2540), probe(4560, 4565)]
  assert.equal(shouldServeSse503(muxAfterRetry1.slice(0, 3)), true)
  assert.equal(shouldServeSse503(muxAfterRetry1.slice(0, 4)), true)
  assert.equal(shouldServeSse503(muxAfterRetry1), false)
  assert.deepEqual(assertSse503Backoff(muxAfterRetry1), {retryDelay1Ms: 1010, retryDelay2Ms: 2020, coalescedSlotProbes: 2})

  assert.equal(shouldServeSse503([probe(0, 5), probe(10, 15), probe(20, 25), probe(30, 35)]), false)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(10, 15), probe(20, 25), probe(30, 35)]), /first bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(10, 15), probe(1020, 1025), probe(2030, 2035)]), /second bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(3005, 3010), probe(8010, 8015)]), /first bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(1015, 1020), probe(5020, 5025)]), /second bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(10, 15), probe(20, 25), probe(1035, 1040), probe(3050, 3055)]), /5-probe multiplexed handover/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(1015, 1020), probe(1520, 1525), probe(2535, 2540), probe(4560, 4565), probe(6570, 6575)]), /3 to 5/)
})
