const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { assessNode, assessNpm, auditNpm, electronNode, npmRuntimes, npmSemver, proposeNodeUpdate, proposeNpmUpdate } = require('./runtime-maintenance.cjs')

const release = (version, npm = '11.19.0', lts = 'Krypton') => ({ version: `v${version}`, npm, lts })
const releases = [release('24.20.0'), release('26.12.0', '12.2.0', 'Next'), release('24.9.0'), release('24.21.0')]
const counts = { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 }
// The semver the check itself uses: npm's own, found beside the running Node.
const semver = npmSemver(undefined)
const electronReleases = [{ version: '39.0.0', node: '22.20.0' }, { version: '42.0.0', node: '24.15.0' }]
const npm12 = { version: '12.2.2', engines: { node: '^22.22.2 || ^24.15.0 || >=26.0.0' } }

test('proposes only a newer stable release of the pinned LTS major', () => {
  assert.deepEqual(assessNode('24.20.0', releases), { pin: '24.20.0', target: '24.21.0', nodeUpdate: true })
  const stable = assessNode('24.21.0', [...releases, release('24.22.0', '12.0.0', false)])
  assert.equal(stable.nodeUpdate, false)
  assert.equal(stable.target, '24.21.0')
})

test('invalid/missing metadata fails instead of claiming the runtime is current', () => {
  for (const pin of ['24', '24.20.0\n::warning::test', '24.20.0-rc.1']) assert.throws(() => assessNode(pin, releases))
  assert.throws(() => assessNode('24.20.0', null))
  assert.throws(() => assessNode('24.20.0', []))
  const runtimes = npmRuntimes('24.22.2', '42.0.0', '24.15.0')
  for (const latest of [{ version: 'latest' }, null, { version: '12.2.2' }, { version: '12.2.2', engines: { node: '' } }, { version: '12.2.2', engines: { node: 'not a range' } }]) {
    assert.throws(() => assessNpm('11.19.1', latest, runtimes, semver))
  }
  assert.throws(() => assessNpm('11.19.1\n', npm12, runtimes, semver))
  assert.throws(() => electronNode('39.0.0', [{ version: '39.0.0' }]))
  assert.throws(() => electronNode('39.0.0', [{ version: '40.0.0', node: '24.11.1' }]))
  assert.throws(() => electronNode('^39.0.0', electronReleases))
  assert.throws(() => npmRuntimes('24.22.2', undefined, '22.20.0'))
})

test('a newer npm, majors included, is proposed only when every runtime satisfies its engines', () => {
  assert.equal(electronNode('39.0.0', electronReleases), '22.20.0')
  // Every runtime accepted: a major update is proposed and labelled as such.
  assert.deepEqual(assessNpm('11.19.1', npm12, npmRuntimes('24.22.2', '42.0.0', '24.15.0'), semver), {
    pin: '11.19.1', target: '12.2.2', engine: npm12.engines.node, update: true, major: true, compatible: true, rejected: [],
  })
  // Electron 39's Node 22.20.0 is below ^22.22.2: no proposal, and the blocking runtime is named.
  const blocked = assessNpm('11.19.1', npm12, npmRuntimes('24.22.2', '39.0.0', '22.20.0'), semver)
  assert.equal(blocked.compatible, false)
  assert.deepEqual(blocked.rejected, ["Electron 39.0.0's Node 22.20.0"])
  assert.deepEqual(assessNpm('11.19.1', npm12, npmRuntimes('24.14.0', '42.0.0', '24.15.0'), semver).rejected, ['Node 24.14.0 (.node-version: CI and Tauri)'])
  const minor = assessNpm('11.19.1', { version: '11.20.0', engines: { node: '^20.17.0 || >=22.9.0' } }, npmRuntimes('24.22.2', '39.0.0', '22.20.0'), semver)
  assert.equal(minor.compatible, true)
  assert.equal(minor.major, false)
  for (const latest of [{ version: '11.19.1' }, { version: '11.18.0' }]) {
    const current = assessNpm('11.19.1', latest, npmRuntimes('24.22.2', '39.0.0', '22.20.0'), semver)
    assert.equal(current.update, false)
    assert.equal(current.compatible, false)
  }
})

function auditFixture(auditResult, { installResult, lockVersion = '11.19.0', bundled = true } = {}) {
  let directory
  const calls = []
  const run = (command, args, options) => {
    directory = options.cwd
    calls.push({ command, args, options })
    assert.equal(command, process.execPath)
    assert.equal(args[0], 'fixture/npm-cli.js')
    if (args[1] === 'install') {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
      assert.deepEqual(manifest, { private: true, dependencies: { npm: '11.19.0' } })
      assert.ok(args.includes('--package-lock-only'))
      assert.ok(args.includes('--ignore-scripts'))
      assert.ok(args.includes('--no-audit'))
      assert.ok(!args.includes('-g'))
      assert.equal(fs.readFileSync(options.env.NPM_CONFIG_USERCONFIG, 'utf8'), '')
      fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({ packages: {
        'node_modules/npm': { version: lockVersion },
        ...(bundled ? { 'node_modules/npm/node_modules/fixture': { version: '1.0.0', inBundle: true } } : {}),
      } }))
      return installResult ?? { status: 0 }
    }
    assert.equal(args[1], 'audit')
    assert.ok(args.includes('--json') && args.includes('--omit=dev'))
    return auditResult
  }
  return { run, calls, directory: () => directory }
}

test('audits a published npm CLI in isolation, never the application lockfile', () => {
  const fixture = auditFixture({ status: 1, stdout: JSON.stringify({ metadata: { vulnerabilities: counts } }) })
  assert.deepEqual(auditNpm('11.19.0', 'fixture/npm-cli.js', fixture.run).metadata.vulnerabilities, counts)
  assert.equal(fixture.calls.length, 2)
  assert.equal(fs.existsSync(fixture.directory()), false)
})

test('failed audit, mismatched lockfile and malformed output cannot produce a clean assessment', () => {
  for (const fixture of [
    auditFixture({ status: 2, stdout: '' }),
    auditFixture({ status: 1, stdout: JSON.stringify({ error: { code: 'ENOTFOUND' } }) }),
    auditFixture({ status: 0, stdout: '{}' }),
    auditFixture({ status: 0, stdout: 'not JSON' }),
    auditFixture({ status: 0, stdout: JSON.stringify({ metadata: { vulnerabilities: { ...counts, total: -1 } } }) }),
    auditFixture({ status: 0, stdout: JSON.stringify({ metadata: { vulnerabilities: { ...counts, total: 0 } } }) }),
    auditFixture({ status: null, error: new Error('timeout') }),
    auditFixture({}, { installResult: { status: 1 } }),
    auditFixture({}, { lockVersion: '12.2.0' }),
    auditFixture({}, { bundled: false }),
  ]) {
    assert.throws(() => auditNpm('11.19.0', 'fixture/npm-cli.js', fixture.run))
    assert.equal(fs.existsSync(fixture.directory()), false)
  }
})

function proposalFixture({ currentPin = '24.20.0', previous = [], branchError, files = {} } = {}) {
  const calls = [], warnings = []
  const record = (kind, data) => { calls.push({ kind, data }); return { data: {} } }
  const contents = { '.node-version': `${currentPin}\n`, ...files }
  const github = { rest: {
    git: {
      getRef: async () => ({ data: { object: { sha: 'base-snapshot' } } }),
      createRef: async data => { if (branchError) throw branchError; return record('branch', data) },
    },
    repos: {
      getContent: async data => { assert.equal(data.ref, 'base-snapshot'); assert.ok(data.path in contents, data.path); return { data: {
        type: 'file', encoding: 'base64', content: Buffer.from(contents[data.path]).toString('base64'), sha: 'pin-sha',
      } } },
      createOrUpdateFileContents: async data => record('file', data),
    },
    pulls: { list() {}, create: async data => record('pr', data) },
  }, paginate: async (_method, params) => { assert.equal(params.state, 'all'); return previous } }
  return { github, calls, warnings, context: { serverUrl: 'https://github.com', runId: 42,
    repo: { owner: 'example', repo: 'project' }, payload: { repository: { default_branch: 'dev' } } },
    core: { info() {}, warning: message => warnings.push(message) }, pin: '24.20.0', target: '24.21.0' }
}

test('a Node proposal changes only the pin, opens normally and never merges or changes npm', async () => {
  const fixture = proposalFixture()
  await proposeNodeUpdate(fixture)
  assert.deepEqual(fixture.calls.map(call => call.kind), ['branch', 'file', 'pr'])
  const [branch, file, pr] = fixture.calls.map(call => call.data)
  assert.equal(branch.sha, 'base-snapshot')
  assert.equal(branch.ref, 'refs/heads/maintenance/node-24.21.0')
  assert.equal(file.path, '.node-version')
  assert.equal(file.sha, 'pin-sha')
  assert.equal(Buffer.from(file.content, 'base64').toString('utf8'), '24.21.0\n')
  assert.equal(pr.base, 'dev')
  assert.equal(pr.draft, false)
  assert.match(pr.body, /Review and merge manually after PR validation/)
  assert.match(pr.body, /close and reopen this PR to trigger validation/)
  assert.match(pr.body, /It does not change npm or merge itself/)
  assert.match(pr.body, /https:\/\/github.com\/example\/project\/actions\/runs\/42/)
})

const cleanAudit = JSON.stringify({ info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 })
const pinnedAudit = JSON.stringify({ info: 0, low: 1, moderate: 0, high: 2, critical: 0, total: 3 })
function npmProposalFixture({ npmPin = '11.19.1', nodePin = '24.22.2', electron = '42.0.0', ...options } = {}) {
  const fixture = proposalFixture({ ...options, currentPin: nodePin, files: {
    '.npm-version': `${npmPin}\n`, 'packages/electron-app/package.json': JSON.stringify({ devDependencies: { electron } }),
  } })
  return { ...fixture, pin: '11.19.1', target: '12.2.2', engine: npm12.engines.node, nodePin: '24.22.2',
    electron: '42.0.0', electronNode: '24.15.0', audit: cleanAudit, pinnedAudit }
}

test('an npm proposal changes only .npm-version, labels a major and lists what the maintainer checks', async () => {
  const fixture = npmProposalFixture()
  await proposeNpmUpdate(fixture)
  assert.deepEqual(fixture.calls.map(call => call.kind), ['branch', 'file', 'pr'])
  const [branch, file, pr] = fixture.calls.map(call => call.data)
  assert.equal(branch.ref, 'refs/heads/maintenance/npm-12.2.2')
  assert.equal(branch.sha, 'base-snapshot')
  assert.equal(file.path, '.npm-version')
  assert.equal(Buffer.from(file.content, 'base64').toString('utf8'), '12.2.2\n')
  assert.equal(pr.draft, false)
  assert.equal(pr.base, 'dev')
  assert.equal(pr.title, 'chore(runtime): update bundled npm to 12.2.2 (major: 11.x → 12.x)')
  assert.match(pr.body, /\*\*This is a major npm update\.\*\*/)
  assert.match(pr.body, /accepts Node 24\.22\.2 \(`\.node-version`: CI and Tauri\) and Node 24\.15\.0 integrated in Electron 42\.0\.0/)
  assert.match(pr.body, /npm 12\.2\.2: 0 affected package entries .*pinned npm 11\.19\.1: 3 affected package entries \(0 critical, 2 high/)
  assert.match(pr.body, /https:\/\/github\.com\/npm\/cli\/releases\/tag\/v12\.2\.2/)
  assert.match(pr.body, /Before merging, check:\n- the release notes of every npm version after 11\.19\.1 up to 12\.2\.2/)
  assert.match(pr.body, /OpenCode's postinstall must still run/)
  assert.match(pr.body, /Review and merge manually after PR validation/)
  assert.match(pr.body, /close and reopen this PR to trigger validation/)
  assert.match(pr.body, /This changes only `\.npm-version`/)

  const minor = npmProposalFixture()
  await proposeNpmUpdate({ ...minor, target: '11.20.0' })
  assert.equal(minor.calls.at(-1).data.title, 'chore(runtime): update bundled npm to 11.20.0')
  assert.doesNotMatch(minor.calls.at(-1).data.body, /major npm update/)
})

test('an npm proposal leaves existing proposals alone and refuses a basis that changed or invalid inputs', async () => {
  for (const options of [{ previous: [{ state: 'closed' }] }, { npmPin: '11.20.0' }, { nodePin: '24.23.0' }, { electron: '43.0.0' }]) {
    const fixture = npmProposalFixture(options)
    await proposeNpmUpdate(fixture)
    assert.deepEqual(fixture.calls, [], JSON.stringify(options))
  }
  for (const invalid of [{ target: '11.19.1' }, { target: '11.18.0' }, { target: '12.2.2\nx' }, { engine: '`>=1`' }, { engine: undefined },
    { audit: 'null' }, { audit: '{"total":-1}' }, { pinnedAudit: 'not JSON' }, { electronNode: '' }]) {
    const fixture = npmProposalFixture()
    await assert.rejects(proposeNpmUpdate({ ...fixture, ...invalid }))
    assert.deepEqual(fixture.calls, [])
  }
})

test('existing/closed proposals and a concurrently changed pin are not overwritten', async () => {
  for (const options of [{ previous: [{ state: 'open' }] }, { previous: [{ state: 'closed' }] }, { currentPin: '24.22.0' }]) {
    const fixture = proposalFixture(options)
    await proposeNodeUpdate(fixture)
    assert.deepEqual(fixture.calls, [])
  }
})

test('no major jump, downgrade or replay of an uncertain/pre-existing branch mutation', async () => {
  for (const target of ['26.1.0', '24.19.0', '24.20.0', '24.21.0\nother']) {
    const fixture = proposalFixture()
    await assert.rejects(proposeNodeUpdate({ ...fixture, target }))
    assert.deepEqual(fixture.calls, [])
  }
  const fixture = proposalFixture({ branchError: new Error('branch already exists or reply lost') })
  await assert.rejects(proposeNodeUpdate(fixture), /branch already exists or reply lost/)
  assert.deepEqual(fixture.calls, [])
})

test('maintenance is scheduled/default-branch-only; no automatic merge, and packaging never resolves latest npm', () => {
  const root = path.resolve(__dirname, '../..')
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/runtime-maintenance.yml'), 'utf8')
  assert.match(workflow, /schedule:/)
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /if: github.ref == format\('refs\/heads\/\{0\}', github.event.repository.default_branch\)/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /run: npm run check:runtime/)
  const checkJob = workflow.split('  check:')[1].split('  propose:')[0]
  assert.doesNotMatch(checkJob, /contents: write|pull-requests: write/)
  assert.match(workflow, /needs: check/)
  assert.doesNotMatch(workflow, /pull_request_target:|pull_request:|--global|--force|auto-merge|issues: write/)
  assert.match(workflow, /if: needs\.check\.outputs\.npm-update == 'true'/)
  for (const file of ['scripts/prepare-node-runtime.cjs', 'scripts/bundled-npm.cjs']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /npm\/latest|npm@latest|dist-tags/)
  }
})
