// Reviewer probes, including real Chromium; kept separate from the browser-free server unit suite.
// node --import tsx --test scripts/fixtures/p2-pairing-security-review.test.mts
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import http from 'node:http'
import Fastify from 'fastify'
import { chromium } from 'playwright'
import { RemoteServerBrowseManager } from '../../packages/server/src/codenomad-servers/browse-manager'
import { CodeNomadServerCredentials } from '../../packages/server/src/codenomad-servers/credentials'
import { startFakeCodeNomad } from '../../packages/server/src/codenomad-servers/test-support/fake-codenomad'
import { registerRemoteServerBrowseRoutes } from '../../packages/server/src/server/routes/remote-server-browse'
import { getBrowserFramePolicy } from '../../packages/ui/src/components/browser-frame-security'
import { startRemoteSurface, FAKE_TUNNEL_HOST } from '../../packages/server/src/remote-control/test-support/surface'

test('ten unauthenticated guesses cannot deny a valid server code, permit replay or lock out browser pairing', async t => {
  const f = await startRemoteSurface(t)
  const send = (code: string, browser = false) => new Promise<number>((resolve, reject) => {
    const body = JSON.stringify(browser ? { code } : { code, hostName: 'proof' })
    const request = http.request(`http://${f.target()}${browser ? '/api/remote-control/pair' : '/api/remote-control/server-pair'}`, {
      method: 'POST', headers: { host: FAKE_TUNNEL_HOST, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        ...(browser ? { origin: `https://${FAKE_TUNNEL_HOST}` } : { 'x-codenomad-server-pairing': '1' }) },
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)) })
    request.on('error', reject)
    request.end(body)
  })
  for (let i = 0; i < 10; i++) assert.equal(await send('x'.repeat(32)), 401)
  const valid = new URL(f.manager.createPairing().url).hash.slice(1)
  assert.equal(await send(valid), 200, 'invalid guesses cannot block the holder of a valid code')
  assert.equal(f.manager.devices().length, 1)
  assert.notEqual(await send(valid), 200, 'server replay cannot issue another device')
  assert.equal(await send(valid, true), 401, 'server redemption also consumes the browser code')
  assert.equal(f.manager.devices().length, 1)
  for (let i = 0; i < 10; i++) assert.equal(await send('x'.repeat(32), true), 401)
  const browserCode = new URL(f.manager.createPairing().url).hash.slice(1)
  assert.equal(await send(browserCode, true), 200, 'browser pairing has no lockout from server failures')
  assert.equal(f.manager.devices().length, 2)
})

test('real browser: foreign, opaque extension and DNS-rebinding origins fail; trusted same-origin SideCar retains documented application authority', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-browser-guard-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const remote = await startFakeCodeNomad()
  t.after(() => remote.close())
  const manager = new RemoteServerBrowseManager({ getOwner: () => ({ remoteServers: [{ id: 'saved', baseUrl: remote.origin }] }), configYamlPathForAuthority: () => path.join(dir, 'config.yaml') })
  t.after(() => manager.close())
  await manager.connect('saved', { username: 'codenomad', password: 'remote-password' })
  const app = Fastify()
  let origin = ''
  registerRemoteServerBrowseRoutes(app, { manager, getSelfOrigins: () => new Set([origin]) })
  app.get('/', (_, reply) => reply.type('text/html').send('<!doctype html><title>Host</title>'))
  app.get('/sidecars/proof/', (_, reply) => reply.type('text/html').send(`<!doctype html><script>
    fetch('/api/remote-servers/saved/browse', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(async r => parent.postMessage({status:r.status, body:await r.json()}, '*'))
      .catch(() => parent.postMessage({blocked:true}, '*'))
  </script>`))
  origin = await app.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => app.close())
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(origin)
  const before = remote.state.requests.length
  const opaque = await page.evaluate(() => new Promise<any>(resolve => {
    window.addEventListener('message', event => resolve(event.data), { once: true })
    const frame = document.createElement('iframe')
    frame.sandbox.add('allow-scripts')
    frame.src = '/sidecars/proof/'
    document.body.append(frame)
  }))
  assert.equal(opaque.blocked, true)
  assert.equal(remote.state.requests.length, before)
  // A rebinding hostname still presents the attacker's Origin, not the saved self origin.
  for (const source of ['http://rebind.attacker.invalid', 'https://remote-page.invalid', 'null']) {
    const response = await app.inject({ method: 'POST', url: '/api/remote-servers/saved/browse', headers: { origin: source }, payload: {} })
    assert.equal(response.statusCode, 403)
  }
  assert.equal(remote.state.requests.length, before)
  const policy = getBrowserFramePolicy({ host: 'web', windowContext: 'local' }, { trustedSameOrigin: true })
  const trusted = await page.evaluate(sandbox => new Promise<any>(resolve => {
    window.addEventListener('message', event => resolve(event.data), { once: true })
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', sandbox)
    frame.src = '/sidecars/proof/'
    document.body.append(frame)
  }), policy.sandbox)
  assert.equal(trusted.status, 200)
  assert.equal(trusted.body.listing.metadata.currentPath, '/srv/projects')
  assert(remote.state.requests.length > before)
  assert(!JSON.stringify(trusted).includes('remote-password'))
})

test('corrupt credential file fails closed without exposing stored data', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-corrupt-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'remote-server-credentials.json')
  for (const value of ['{broken', 'null', '{"servers":{"saved":{"origin":"http://example.test","secret":{"kind":"device","cookie":null}}}}']) {
    fs.writeFileSync(file, value)
    const credentials = new CodeNomadServerCredentials(file)
    assert.equal(credentials.read('saved', 'http://example.test'), undefined)
    credentials.set('replacement', 'https://example.test', { kind: 'device', cookie: 'dummy-review-value' })
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).servers), ['replacement'])
  }
})
