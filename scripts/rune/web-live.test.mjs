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

test('SSE 503 backoff requires independent handover proof for 4-5 probes and rejects unproved extra retries', () => {
  const probe = (receivedAt, fulfilledAt = receivedAt) => ({receivedAt, fulfilledAt})
  const handover = (sseOpenedAt, ...subscriberSyncTimes) => ({sseOpenedAt, subscriberSyncTimes})

  const single = [probe(0, 5), probe(1020, 1025), probe(3040, 3045)]
  assert.equal(shouldServeSse503(single.slice(0, 1)), true)
  assert.equal(shouldServeSse503(single.slice(0, 2)), true)
  assert.equal(shouldServeSse503(single), false)
  assert.deepEqual(assertSse503Backoff(single), {retryDelay1Ms: 1015, retryDelay2Ms: 2015, coalescedSlotProbes: 0})

  const muxFast = [probe(0, 5), probe(15, 20), probe(1030, 1035), probe(3050, 3055)]
  const fastHandover = handover(0, 3)
  assert.equal(shouldServeSse503(muxFast.slice(0, 3), fastHandover), true)
  assert.equal(shouldServeSse503(muxFast, fastHandover), false)
  assert.deepEqual(assertSse503Backoff(muxFast, fastHandover), {retryDelay1Ms: 1010, retryDelay2Ms: 2015, coalescedSlotProbes: 1})

  const muxSlowHandover = [probe(0, 5), probe(820, 825), probe(1840, 1845), probe(3860, 3865)]
  const slowHandover = handover(0, 810)
  assert.equal(shouldServeSse503(muxSlowHandover.slice(0, 3), slowHandover), true)
  assert.equal(shouldServeSse503(muxSlowHandover, slowHandover), false)
  assert.deepEqual(assertSse503Backoff(muxSlowHandover, slowHandover), {retryDelay1Ms: 1015, retryDelay2Ms: 2015, coalescedSlotProbes: 1})

  const muxAfterRetry1 = [probe(0, 5), probe(1015, 1020), probe(1520, 1525), probe(2535, 2540), probe(4560, 4565)]
  const lateHandover = handover(0, 1523)
  assert.equal(shouldServeSse503(muxAfterRetry1.slice(0, 3), lateHandover), true)
  assert.equal(shouldServeSse503(muxAfterRetry1.slice(0, 4), lateHandover), true)
  assert.equal(shouldServeSse503(muxAfterRetry1, lateHandover), false)
  assert.deepEqual(assertSse503Backoff(muxAfterRetry1, lateHandover), {retryDelay1Ms: 1010, retryDelay2Ms: 2020, coalescedSlotProbes: 2})

  // Unproved extra retries (1 s, 1 s, 2 s) and stale sync signals must be rejected even when SSE opened.
  const threeRetries = [probe(0, 5), probe(1010, 1015), probe(2020, 2025), probe(4030, 4035)]
  assert.equal(shouldServeSse503(threeRetries.slice(0, 3), fastHandover), false)
  assert.throws(() => assertSse503Backoff(threeRetries, fastHandover), /4-probe SSE 503 recovery requires independent proof/)
  assert.throws(() => assertSse503Backoff(muxFast), /4-probe SSE 503 recovery requires independent proof/)
  assert.throws(() => assertSse503Backoff(muxFast, handover(10, 3)), /4-probe SSE 503 recovery requires independent proof/)
  assert.throws(() => assertSse503Backoff(muxAfterRetry1, fastHandover), /5-probe SSE 503 recovery requires independent proof/)
  assert.equal(shouldServeSse503(muxAfterRetry1.slice(0, 3), handover(0, 100)), false)
  assert.throws(() => assertSse503Backoff(muxAfterRetry1, handover(0, 100)), /5-probe SSE 503 recovery requires independent proof/)
  assert.throws(() => assertSse503Backoff(muxAfterRetry1, handover(0, 1700)), /5-probe SSE 503 recovery requires independent proof/)

  assert.equal(shouldServeSse503([probe(0, 5), probe(10, 15), probe(20, 25), probe(30, 35)], fastHandover), false)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(10, 15), probe(20, 25), probe(30, 35)], fastHandover), /first bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(10, 15), probe(1020, 1025), probe(2030, 2035)], fastHandover), /second bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(3005, 3010), probe(8010, 8015)]), /first bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(1015, 1020), probe(5020, 5025)]), /second bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(10, 15), probe(20, 25), probe(1035, 1040), probe(3050, 3055)], lateHandover), /5-probe multiplexed handover/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(1015, 1020), probe(1520, 1525), probe(2535, 2540), probe(4560, 4565), probe(6570, 6575)], lateHandover), /3 to 5/)
})
