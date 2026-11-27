import assert from 'node:assert/strict'
import {test} from 'node:test'
import {admitLiveRoute, assertSse503Backoff} from './web-live.mjs'
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

test('assertSse503Backoff enforces exactly 3 probes with bounded 1 s and 2 s retries', () => {
  const probe = (receivedAt, fulfilledAt = receivedAt) => ({receivedAt, fulfilledAt})

  assert.deepEqual(
    assertSse503Backoff([probe(0, 5), probe(1020, 1025), probe(3040, 3045)]),
    {retryDelay1Ms: 1015, retryDelay2Ms: 2015},
  )

  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(1020, 1025)]), /Expected exactly 3/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(15, 20), probe(1030, 1035), probe(3050, 3055)]), /Expected exactly 3/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(500, 505), probe(2600, 2605)]), /first bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(2005, 2010), probe(6010, 6015)]), /first bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(1015, 1020), probe(2020, 2025)]), /second bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(1015, 1020), probe(5020, 5025)]), /second bounded retry delay/)
  assert.throws(() => assertSse503Backoff([probe(0, 5), probe(1900, 1905), probe(3700, 3705)]), /second bounded retry delay/)
})
