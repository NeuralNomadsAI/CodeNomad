//! Owned Rust static server and browser smoke fixture; upstream service discovery is closed.
import assert from 'node:assert/strict'
import {fixtureChildPid,spawnFixtureChild as spawn} from '../native-fixture-guards.mjs'
import {fixtureAttestationEnv,stripFixtureServerSecrets} from '../native-fixture-http.mjs'
import {createHash} from 'node:crypto'
import {access, chmod, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {setTimeout as sleep} from 'node:timers/promises'
import {chromium} from 'playwright'
import {signInFixture} from '../../packages/rune-app/fixtures/fixture-host.mjs'
import {privateEnvironment} from '../../packages/rune-app/fixtures/private-profile.mjs'
import {assertWorktreeTestRoot} from './web-workspace-policy.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const binary = process.env.RUNE_SERVER_EXE
assert(binary && path.isAbsolute(binary), 'Set RUNE_SERVER_EXE to the absolute compiled Rust server binary')
await access(binary)
const ui = path.join(root, 'target/rune-web')
const manifest = JSON.parse(await readFile(path.join(ui, 'bundle-manifest.json'), 'utf8'))
assert.equal(manifest.generator, 'scripts/rune/bundle-web.mjs')
assert.equal(manifest.testSupport,true,'Build WASM with --features test-support and bundle with --test-support before this synthetic fixture')
const {testsReal} = await assertWorktreeTestRoot(root)
const profile = await mkdtemp(path.join(testsReal, 'trial-'))
const workspace = path.join(profile, 'workspace'), forbidden = path.join(profile, 'forbidden')
await mkdir(workspace); await mkdir(forbidden)
await writeFile(path.join(forbidden, 'private-marker.txt'), 'This synthetic directory stays outside workspace authority.\n')
const env = await privateEnvironment(profile)
const config = path.join(profile, 'config/config.yaml')
const blockedCli = path.join(profile, 'disabled-opencode-cli.exe')
await writeFile(config, JSON.stringify({server: {opencodeBinary: blockedCli}}, null, 2))
Object.assign(env, {CLI_CONFIG: config, CODENOMAD_PROFILE: 'trial-rune-web', CODENOMAD_UPDATE_CHANNEL: 'trial-rune-web',
  CODENOMAD_NATIVE_BROWSER_AUTOMATION: '0'})
assert(!Object.keys(env).some(key => /^CNRS_|^OPENCODE_/i.test(key)), 'Fixture must not inherit upstream discovery or credentials')
await assert.rejects(access(blockedCli), {code: 'ENOENT'})
const args = ['serve', '--host', '127.0.0.1', '--http', 'true', '--https', 'false', '--http-port', '0',
  '--password', 'testfixture', '--ui-no-update', '--ui-dir', ui, '--workspace-root', workspace, '--config', config]
const server = spawn(binary, args, {cwd: profile, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']})
let stdout = '', stdoutBytes = 0, stderrBytes = 0, origin, shutdownComplete = false, overflow = false, spawnError
const exited = new Promise(resolve => {server.once('error', error => {spawnError = error; resolve({code: null})}); server.once('close', (code, signal) => resolve({code, signal}))})
server.stdout.on('data', chunk => {
  stdoutBytes += chunk.length
  if (stdoutBytes > 1024 * 1024) {overflow = true; return}
  stdout += chunk.toString()
  let newline
  while ((newline = stdout.indexOf('\n')) >= 0) {
    const line = stdout.slice(0, newline).trim(); stdout = stdout.slice(newline + 1)
    if (line === 'CODENOMAD_SHUTDOWN_STATUS:complete') shutdownComplete = true
    const found = line.match(/^Local\s+Connection\s+URL\s*:\s*(http:\/\/127\.0\.0\.1:\d+)\/?$/)
    if (found) origin = found[1]
  }
})
server.stderr.on('data', chunk => {stderrBytes += chunk.length; if (stderrBytes > 1024 * 1024) overflow = true})
server.stdin.on('error', () => {})
const proof = {environment: 'real Rust static server; synthetic local Rune scene', binary, profile, workspace, forbidden,
  upstream: 'explicit absent private OpenCode executable', static: {}, smoke: false, shutdownComplete: false, exitCode: null}
let failure, http
try {
  for (const deadline = Date.now() + 25_000; !origin;) {
    assert(Date.now() < deadline && server.exitCode === null && !spawnError && !overflow, 'Isolated Rust server startup failed')
    await sleep(30)
  }
  const serverPid = await fixtureChildPid(server)
  assert(Number.isSafeInteger(serverPid) && serverPid > 0, 'Owned Rust server PID unavailable')
  http = await signInFixture(origin, 'testfixture', serverPid)
  const storage = path.join(profile, 'browser-storage.json')
  await http.storageState({path: storage})
  await chmod(storage, 0o600).catch(() => {})
  const index = await http.get('/')
  assert.equal(index.status(), 200)
  assert(index.headers()['content-type'].startsWith('text/html'))
  assert((await index.text()).includes('./boot.js'), 'Rust must serve the packaged Rune shell')
  const wasm = await http.get('/app_bg.wasm')
  assert.equal(wasm.status(), 200)
  assert.equal(wasm.headers()['content-type'].split(';')[0], 'application/wasm')
  const bytes = await wasm.body()
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.files.find(file => file.file === 'app_bg.wasm').sha256)
  proof.static = {html: true, wasmMime: wasm.headers()['content-type'], wasmBytes: bytes.length, wasmHashMatchesBundle: true}
  const pasteOnly = process.argv.includes('--paste-only')
  const smoke = spawn(process.execPath, [path.join(root, 'scripts/rune/web-smoke.mjs'), '--url', `${origin}/`,
    '--target-pid', String(serverPid), '--launcher-pid', String(process.pid), '--profile', profile,
    '--storage-state', storage, '--out', path.join(profile, 'browser'), '--executable', chromium.executablePath(),
    ...(pasteOnly ? ['--paste-only'] : [])], {cwd: root, windowsHide: true,
      env: {...stripFixtureServerSecrets(env), ...fixtureAttestationEnv(process.env, {includeServerRoots: true})}, stdio: ['ignore', 'pipe', 'pipe']})
  let diagnostic = ''
  for (const stream of [smoke.stdout, smoke.stderr]) stream.on('data', chunk => {if (diagnostic.length < 65536) diagnostic += chunk})
  const timer = setTimeout(() => smoke.kill(), 240_000)
  const code = await new Promise((resolve, reject) => {smoke.once('error', reject); smoke.once('close', resolve)})
  clearTimeout(timer)
  await writeFile(path.join(profile, 'browser-run.log'), diagnostic)
  assert.equal(code, 0, `Headless web smoke failed; inspect ${path.join(profile, 'browser-run.log')}`)
  proof.smoke = true
} catch (error) {failure = error}
finally {
  await http?.dispose()
  if (server.exitCode === null && !spawnError) {
    server.stdin.write('codenomad:shutdown\n')
    await Promise.race([exited, sleep(15_000, undefined, {ref: false})])
  }
  if (server.exitCode === null && !spawnError) {server.kill(); await Promise.race([exited, sleep(5000, undefined, {ref: false})])}
  proof.shutdownComplete = shutdownComplete
  proof.exitCode = server.exitCode
  proof.stdoutBytes = stdoutBytes; proof.stderrBytes = stderrBytes
  await writeFile(path.join(profile, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
  if (!shutdownComplete || server.exitCode !== 0) failure ??= Error('Owned Rust server did not confirm complete shutdown and exit 0')
}
console.log(JSON.stringify({profile, static: proof.static, smoke: proof.smoke, shutdownComplete, exitCode: server.exitCode}))
if (failure) throw failure
