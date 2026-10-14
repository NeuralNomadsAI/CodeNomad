const marker = '<!-- codenomad-pr-artifacts -->'

async function commentPRArtifacts({ github, context, core, allowedActors = '' }) {
  const { owner, repo } = context.repo
  const run = context.payload.workflow_run
  if (!run || run.event !== 'pull_request' || run.status !== 'completed' || run.conclusion !== 'success') return
  if (run.path !== '.github/workflows/pr-build.yml') return
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { owner, repo, run_id: run.id, per_page: 100 })
  const active = artifacts.filter(artifact => !artifact.expired)
  if (!active.length) { core.info('No active artifacts to announce.'); return }
  const associated = run.pull_requests?.length ? run.pull_requests : await github.paginate(
    github.rest.repos.listPullRequestsAssociatedWithCommit, { owner, repo, commit_sha: run.head_sha, per_page: 100 })
  const allowed = new Set(allowedActors.split(',').map(actor => actor.trim()).filter(Boolean))
  const runUrl = `https://github.com/${owner}/${repo}/actions/runs/${run.id}`
  // Artifact names are untrusted display text, never code or a URL to execute.
  const displayName = name => String(name).replace(/[\r\n]/g, ' ').replace(/[\\`*_[\]<>]/g, '\\$&')
  const body = [marker, 'PR builds are available as GitHub Actions artifacts:', '', runUrl, '',
    'Artifacts expire according to the retention shown on the run.', 'Artifacts:',
    ...active.map(artifact => `- ${displayName(artifact.name)}`)].join('\n')
  for (const number of new Set(associated.map(pr => pr.number))) {
    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number })
    // A completed old run must not advertise obsolete artifacts after a push.
    if (pr.head.sha !== run.head_sha || pr.draft) continue
    if (!['dev', 'DEV-v2'].includes(pr.base.ref) && !allowed.has(pr.user.login)) continue
    const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 })
    const existing = comments.find(comment => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(marker))
    if (existing) await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body })
    else await github.rest.issues.createComment({ owner, repo, issue_number: number, body })
    core.info(`Announced artifacts for completed run ${run.id} on PR #${number}.`)
  }
}

module.exports = { commentPRArtifacts }
