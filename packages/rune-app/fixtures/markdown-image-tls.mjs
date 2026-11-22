// node --import tsx packages/rune-app/fixtures/markdown-image-tls.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:https'
import path from 'node:path'
import { resolveHttpsOptions } from '../../server/src/server/tls.ts'

const target = process.env.CARGO_TARGET_DIR
assert(target && path.isAbsolute(target), 'Pass the owned Cargo target directory')
const temporary = path.join(target, 'tmp')
await mkdir(temporary, { recursive: true })
const configDir = await mkdtemp(path.join(temporary, 'trial-markdown-image-tls-'))
let server
try {
  const tls = resolveHttpsOptions({ host: '127.0.0.1', enabled: true, configDir, logger: { info() {}, warn() {} } })
  const cases = JSON.parse(await readFile(new URL('../tests/fixtures/reader-content.json', import.meta.url), 'utf8'))
  const bytes = Buffer.from(cases.images.find(image => image.name === 'small.png').base64, 'base64')
  const requests = []
  server = createServer(tls.httpsOptions, (request, response) => {
    requests.push({ path: request.url, headers: request.headers })
    if (request.url !== '/image.png') return response.writeHead(404).end()
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length }).end(bytes)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const status = await new Promise((resolve, reject) => {
    const test = spawn('cargo', ['+1.99.1', 'test', '--locked', '--offline', '-p', 'codenomad-client', 'files::images::native_tls_reads_a_trusted_image_and_refuses_an_unknown_certificate', '--', '--ignored', '--exact'], {
      stdio: 'inherit', windowsHide: true,
      env: { ...process.env, RUNE_IMAGE_TLS_FIXTURE: `https://127.0.0.1:${server.address().port}/`, RUNE_IMAGE_TLS_CA: tls.caCertPath },
    })
    test.once('error', reject)
    test.once('close', resolve)
  })
  assert.equal(status, 0)
  assert.equal(requests.length, 1, 'The untrusted certificate never reaches HTTP')
  assert.equal(requests[0].path, '/image.png')
  for (const name of ['cookie', 'authorization', 'referer']) assert.equal(requests[0].headers[name], undefined)
} finally {
  if (server?.listening) await new Promise(resolve => server.close(resolve))
  await rm(configDir, { recursive: true, force: true })
}
