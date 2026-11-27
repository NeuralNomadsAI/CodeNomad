// Package the compiled application library into the Android APK without Cargo compiling anything.
import assert from 'node:assert/strict'
import {execFileSync, execSync} from 'node:child_process'
import {copyFile, mkdir, readdir, rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import path from 'node:path'
import {runeSource} from './source.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const {values} = parseArgs({options: {lib: {type: 'string'}, abi: {type: 'string'}, out: {type: 'string', default: 'target/rune-android'}}})
const target = process.env.CARGO_TARGET_DIR
assert(target && path.isAbsolute(target), 'Set CARGO_TARGET_DIR to the absolute existing Cargo cache')
const within = (base, file) => {const relative = path.relative(base, file); return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)}
assert(values.lib && path.isAbsolute(values.lib) && within(target, values.lib), 'Pass --lib with the compiled application library inside CARGO_TARGET_DIR')
assert(['arm64-v8a', 'x86_64'].includes(values.abi), 'Pass --abi arm64-v8a or x86_64, matching the library target')
const out = path.resolve(root, values.out)
assert(within(path.join(root, 'target'), out), 'Bundle output must stay inside this checkout target directory')

const libraries = path.join(out, 'jniLibs')
await rm(libraries, {recursive: true, force: true})
await mkdir(path.join(libraries, values.abi), {recursive: true})
// RuneActivity loads the library its manifest names: `main`.
await copyFile(values.lib, path.join(libraries, values.abi, 'libmain.so'))

const project = path.join(root, 'packages/rune-app/android')
const gradle = process.env.RUNE_GRADLE ?? 'gradle'
// One build per call: no Gradle or Kotlin daemon stays behind holding the output directory.
const args = ['--quiet', '--no-daemon', '-Pkotlin.compiler.execution.strategy=in-process', '--project-dir', project, '--project-cache-dir', path.join(out, 'gradle-cache'),
  `-PruneKotlin=${path.join(runeSource(root), 'android/src/main/kotlin')}`, `-PappLibraries=${libraries}`, `-Poutput=${path.join(out, 'build')}`, 'assembleDebug']
// Gradle's Windows launcher is a batch file, which Node starts only through a shell. A bare
// name stays unquoted: quoted, the batch file resolves its own directory from the current one.
const quote = text => `"${text}"`
if (process.platform === 'win32') execSync([gradle.includes(' ') ? quote(gradle) : gradle, ...args.map(quote)].join(' '), {cwd: root, stdio: 'inherit', windowsHide: true})
else execFileSync(gradle, args, {cwd: root, stdio: 'inherit'})
const apks = path.join(out, 'build/outputs/apk/debug')
const apk = (await readdir(apks)).find(name => name.endsWith('.apk'))
assert(apk, 'Gradle produced no APK')
console.log(path.join(apks, apk))
