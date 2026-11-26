import assert from 'node:assert/strict'
import {test} from 'node:test'
import {admitLiveRoute} from './web-live.mjs'
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
