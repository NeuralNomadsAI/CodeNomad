const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { assessRuntime, auditNpm, proposeNodeUpdate } = require('./runtime-maintenance.cjs')

const release = (version, npm = '11.19.0', lts = 'Krypton') => ({ version: `v${version}`, npm, lts })
const releases = [release('24.20.0'), release('26.12.0', '12.2.0', 'Next'), release('24.9.0'), release('24.21.0')]
const counts = { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 }

test('proposes only a newer stable release of the pinned LTS major', () => {
  assert.deepEqual(assessRuntime('24.20.0', releases, '12.2.0'), {
    pin: '24.20.0', target: '24.21.0', npmBundled: '11.19.0', npmLatest: '12.2.0', nodeUpdate: true, npmUpdate: true,
  })
  const stable = assessRuntime('24.21.0', [...releases, release('24.22.0', '12.0.0', false)], '11.19.0')
  assert.equal(stable.nodeUpdate, false)
  assert.equal(stable.npmUpdate, false)
  assert.equal(stable.target, '24.21.0')
})

test('invalid/missing metadata fails instead of claiming the runtime is current', () => {
  for (const pin of ['24', '24.20.0\n::warning::test', '24.20.0-rc.1']) assert.throws(() => assessRuntime(pin, releases, '12.2.0'))
  assert.throws(() => assessRuntime('24.20.0', null, '12.2.0'))
  assert.throws(() => assessRuntime('24.20.0', [], '12.2.0'))
  assert.throws(() => assessRuntime('24.20.0', [release('24.20.0', 'latest')], '12.2.0'))
  assert.throws(() => assessRuntime('24.20.0', releases, 'latest'))
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

test('audits the existing npm CLI in isolation, never a latest replacement or the application lockfile', () => {
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

function proposalFixture({ currentPin = '24.20.0', previous = [], branchError } = {}) {
  const calls = [], warnings = []
  const record = (kind, data) => { calls.push({ kind, data }); return { data: {} } }
  const github = { rest: {
    git: {
      getRef: async () => ({ data: { object: { sha: 'base-snapshot' } } }),
      createRef: async data => { if (branchError) throw branchError; return record('branch', data) },
    },
    repos: {
      getContent: async data => { assert.equal(data.ref, 'base-snapshot'); return { data: {
        type: 'file', encoding: 'base64', content: Buffer.from(`${currentPin}\n`).toString('base64'), sha: 'pin-sha',
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
  assert.match(pr.body, /does not separately replace npm/)
  assert.match(pr.body, /https:\/\/github.com\/example\/project\/actions\/runs\/42/)
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

test('maintenance is scheduled/default-branch-only; no automatic merge or npm packaging override', () => {
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
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'scripts/prepare-node-runtime.cjs'), 'utf8'), /NPM_VERSION|npm@latest/)
})
