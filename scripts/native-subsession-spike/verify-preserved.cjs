const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const evidence = 'C:/Users/Admin/AppData/Local/Temp/opencode/missions-native-rollback-V0FPSs'
const saved = JSON.parse(fs.readFileSync(path.join(evidence, 'RESULT.json'), 'utf8'))
const before = JSON.parse(fs.readFileSync(path.join(evidence, 'source-before.json'), 'utf8'))
const git = args => execFileSync('git', args, { cwd: saved.source, encoding: 'utf8' }).trim()
const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort()
assert.deepEqual(files, before.map(item => item.path), 'Original file inventory changed')
for (const item of before) {
  const file = path.join(saved.source, item.path)
  if (item.missing) assert.equal(fs.existsSync(file), false, item.path)
  else assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), item.sha256, item.path)
}
assert.equal(git(['rev-parse', 'HEAD']), saved.head, 'Original HEAD changed')
assert.equal(git(['write-tree']), saved.stagedTree, 'Original staged tree changed')
console.log(JSON.stringify({ preserved: true, files: files.length, head: saved.head, stagedTree: saved.stagedTree, evidence }))
