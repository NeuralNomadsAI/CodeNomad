// Resolve migrated workspace artifacts before a fixture changes its child cwd.
import assert from 'node:assert/strict'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {mkdirSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {fixtureSystemEnvironment} from './private-profile.mjs'
import {isLocalAbsolutePath,resolveLocalExecutable} from '../../../scripts/native-fixture-http.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const suffix = process.platform === 'win32' ? '.exe' : ''
function explicit(value, fallback) {
  if (value !== undefined) assert(isLocalAbsolutePath(value), 'Fixture binary override must be an absolute local path')
  return value ?? fallback
}
export const clientBinary = explicit(process.env.RUNE_CLIENT_EXE,
  path.join(path.resolve(root, process.env.CARGO_TARGET_DIR ?? 'target'), 'debug', `codenomad-rune${suffix}`))
export const serverBinary = explicit(process.env.RUNE_SERVER_EXE,
  path.join(root, 'packages/server-rs/target/debug', `codenomad-rs${suffix}`))
export function requireTestSupport(binary=clientBinary,{probe,env=fixtureSystemEnvironment(),cwd=root,output=path.join(root,'target')}={}) {
  const resolved=resolveLocalExecutable(binary,'Rune client binary')
  mkdirSync(output,{recursive:true})
  const result=spawnSync(resolved,['--test-support-info',...(probe?[probe]:[]),'--tree',path.join(output,`rune-feature-check-${randomUUID()}.json`),'--at','0'],{cwd,env,windowsHide:true,encoding:'utf8',timeout:15_000,maxBuffer:65536})
  assert.equal(result.status,0,'Build codenomad-rune with --features test-support before running qualification fixtures')
  assert.deepEqual(JSON.parse(result.stdout.trim()),{testSupport:true,nativeProbes:true,...(probe?{probe}:{})},'Expected the native qualification artifact and requested probe')
}
