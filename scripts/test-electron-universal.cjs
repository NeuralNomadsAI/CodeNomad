const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const asar = require('@electron/asar')
const { mergeASARs } = require('@electron/universal/dist/cjs/asar-utils.js')

// Universal is a macOS consumer: its ASAR utility expects POSIX archive paths.
test('@electron/universal merges real ASARs with basename allowlists and rejects unlisted files', async () => {
  assert.notEqual(process.platform, 'win32', 'run this qualification on a POSIX host')
  const fixture = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), '.universal-globs-'))
  try {
    for (const arch of ['x64', 'arm64']) {
      const dir = path.join(fixture, arch, 'native')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'common.js'), 'common-content')
      fs.writeFileSync(path.join(dir, `${arch}.node`), arch + '-content')
      await asar.createPackage(path.join(fixture, arch), path.join(fixture, `${arch}.asar`))
    }
    const options = { x64AsarPath: path.join(fixture, 'x64.asar'), arm64AsarPath: path.join(fixture, 'arm64.asar'), outputAsarPath: path.join(fixture, 'universal.asar') }
    await assert.rejects(mergeASARs({ ...options, singleArchFiles: '*.txt' }), /not covered by allowList/)
    await mergeASARs({ ...options, singleArchFiles: '*.{node,dylib}' })
    for (const arch of ['x64', 'arm64']) assert.equal(asar.extractFile(options.outputAsarPath, `native/${arch}.node`).toString(), arch + '-content')
    assert.equal(asar.extractFile(options.outputAsarPath, 'native/common.js').toString(), 'common-content')
  } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
})
