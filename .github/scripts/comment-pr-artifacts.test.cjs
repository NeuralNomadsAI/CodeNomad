const assert = require('node:assert/strict')
const { test } = require('node:test')
const { commentPRArtifacts } = require('./comment-pr-artifacts.cjs')

function fixture() {
  const run = { id: 123, head_sha: 'reviewed', event: 'pull_request', status: 'completed', conclusion: 'success',
    path: '.github/workflows/pr-build.yml', pull_requests: [{ number: 825 }] }
  const pr = { head: { sha: 'reviewed' }, base: { ref: 'dev' }, user: { login: 'contributor' }, draft: false }
  const calls = [], writes = [], artifacts = [{ name: 'build-windows', expired: false }], comments = []
  const methods = { artifacts: {}, associated: {}, comments: {} }
  const github = {
    rest: { actions: { listWorkflowRunArtifacts: methods.artifacts }, repos: { listPullRequestsAssociatedWithCommit: methods.associated },
      pulls: { get: async () => ({ data: pr }) }, issues: {
        listComments: methods.comments, createComment: async input => writes.push(input), updateComment: async input => writes.push(input),
      } },
    paginate: async (method, input) => {
      calls.push(input)
      if (method === methods.artifacts) return artifacts
      if (method === methods.associated) return [{ number: 825 }]
      if (method === methods.comments) return comments
      throw new Error('Unexpected API')
    },
  }
  const execute = (allowedActors = '') => commentPRArtifacts({ github, context: { repo: { owner: 'owner', repo: 'repo' }, payload: { workflow_run: run } },
    core: { info() {} }, allowedActors })
  return { run, pr, calls, writes, artifacts, comments, execute, github }
}

test('completed run posts artifacts without searching or waiting for another workflow', async () => {
  const f = fixture(); await f.execute()
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].issue_number, 825)
  assert.match(f.writes[0].body, /actions\/runs\/123/)
  assert.equal(f.calls[0].run_id, 123)
})
test('failed, canceled, incomplete and unrelated runs perform no artifact or comment calls', async () => {
  for (const patch of [{ conclusion: 'failure' }, { conclusion: 'cancelled' }, { status: 'in_progress' },
    { event: 'push' }, { path: '.github/workflows/other.yml' }]) {
    const f = fixture(); Object.assign(f.run, patch); await f.execute()
    assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, [])
  }
})
test('missing PR association uses GitHub commit association and still verifies the current head', async () => {
  const f = fixture(); f.run.pull_requests = []; await f.execute()
  assert(f.calls.some(call => call.commit_sha === 'reviewed'))
  assert.equal(f.writes.length, 1)
})
test('obsolete heads, drafts and unauthorized targets do not get artifact announcements', async () => {
  for (const change of [pr => { pr.head.sha = 'new-head' }, pr => { pr.draft = true }, pr => { pr.base.ref = 'main' }]) {
    const f = fixture(); change(f.pr); await f.execute(); assert.deepEqual(f.writes, [])
  }
})
test('expired or absent artifacts are skipped rather than falsely advertised', async () => {
  const f = fixture(); f.artifacts[0].expired = true; await f.execute(); assert.deepEqual(f.writes, [])
})
test('explicitly allowed authors retain access for non-dev PR targets', async () => {
  const f = fixture(); f.pr.base.ref = 'main'; await f.execute('maintainer, contributor')
  assert.equal(f.writes.length, 1)
})
test('a rerun updates only the bot-owned artifact comment', async () => {
  const f = fixture()
  f.comments.push({ id: 1, user: { login: 'contributor' }, body: '<!-- codenomad-pr-artifacts -->' },
    { id: 2, user: { login: 'github-actions[bot]' }, body: '<!-- codenomad-pr-artifacts -->\nold' })
  await f.execute(); assert.equal(f.writes[0].comment_id, 2)
})
test('artifact names are escaped display text, not executable markdown content', async () => {
  const f = fixture(); f.artifacts[0].name = '[bad](url)\n<script>`code`'; await f.execute()
  assert(!f.writes[0].body.includes('<script>'))
  assert(f.writes[0].body.includes('\\[bad\\]'))
})
test('GitHub API errors remain real helper failures', async () => {
  const f = fixture(); f.github.paginate = async () => { throw new Error('API unavailable') }
  // An unavailable client must not be converted into a successful announcement.
  await assert.rejects(f.execute, /API unavailable/)
})
