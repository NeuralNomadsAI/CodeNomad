const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

test('WebKit qualification runs authorized drafts on Intel, ARM64 and Linux without secrets', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../workflows/pr-build.yml'), 'utf8').replace(/\r\n/g, '\n')
  const job = workflow.split('  tests-tauri-webkit:\n')[1].split('\n  # Exercise the window persistence')[0]
  assert.match(job, /needs: authorize/)
  assert.match(job, /if: \$\{\{ needs\.authorize\.outputs\.allowed == 'true' \}\}/)
  assert.doesNotMatch(job, /pull_request\.draft|secrets\.|secrets:|actions: write/)
  for (const runner of ['macos-15-intel', 'macos-26', 'ubuntu-24.04']) assert.ok(job.includes(`os: ${runner}`))
  for (const command of ['cargo check --locked', 'cargo clippy --locked', 'cargo test --locked', 'tauri build --no-bundle', 'tauri bundle --bundles app ', 'tauri bundle --bundles appimage']) assert.ok(job.includes(command), command)
  assert.match(job, /Print :LSMinimumSystemVersion/)
  assert.match(job, /test "\$minimum" = '14\.0'/)
  assert.ok(job.includes('lipo "${apps[0]}/Contents/MacOS/$executable" -verify_arch "$EXPECTED_ARCH"'))
  assert.match(job, /path: .*\/appimage\/\*\.AppImage/)
  assert.match(job, /persist-credentials: false/)
})
