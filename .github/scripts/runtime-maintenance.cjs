const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function version(value) {
  if (typeof value !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value)) throw new Error('Expected an exact stable version')
  return value.split('.').map(Number)
}
function compare(a, b) {
  const left = version(a), right = version(b)
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}
function assessRuntime(pin, releases, npmLatest) {
  const major = version(pin)[0]
  version(npmLatest)
  if (!Array.isArray(releases)) throw new Error('Invalid Node release index')
  const current = releases.find(release => release.version === `v${pin}`)
  if (!current?.lts) throw new Error('The pinned Node release is not a known LTS release')
  version(current.npm)
  const candidates = releases.filter(release => typeof release.version === 'string'
    && new RegExp(`^v${major}\\.\\d{1,4}\\.\\d{1,4}$`).test(release.version) && release.lts)
    .sort((a, b) => compare(b.version.slice(1), a.version.slice(1)))
  const target = candidates[0].version.slice(1)
  return { pin, target, npmBundled: current.npm, npmLatest,
    nodeUpdate: compare(target, pin) > 0, npmUpdate: compare(npmLatest, current.npm) > 0 }
}

// Audit the published CLI and its bundled dependencies, never the application's
// lockfile. This temporary installation only creates a lockfile; scripts stay off.
function auditNpm(npmVersion, npmCli = process.env.npm_execpath, run = spawnSync) {
  version(npmVersion)
  if (!npmCli) throw new Error('Run this check through npm run check:runtime')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codenomad-npm-audit-'))
  try {
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ private: true, dependencies: { npm: npmVersion } }))
    for (const file of ['user.npmrc', 'global.npmrc']) fs.writeFileSync(path.join(directory, file), '')
    const options = { cwd: directory, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NPM_CONFIG_USERCONFIG: path.join(directory, 'user.npmrc'),
        NPM_CONFIG_GLOBALCONFIG: path.join(directory, 'global.npmrc'), NPM_CONFIG_CACHE: path.join(directory, 'cache') } }
    const install = run(process.execPath, [npmCli, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund',
      '--omit=dev', '--registry=https://registry.npmjs.org'], options)
    if (install.error || install.status !== 0) throw new Error('Could not prepare the isolated npm audit lockfile')
    const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'))
    if (lock.packages?.['node_modules/npm']?.version !== npmVersion) throw new Error('Audit lockfile does not match bundled npm')
    if (!Object.entries(lock.packages).some(([name, entry]) => name.startsWith('node_modules/npm/node_modules/') && entry.inBundle)) {
      throw new Error('Cannot confirm audit coverage of npm bundled dependencies')
    }
    const result = run(process.execPath, [npmCli, 'audit', '--omit=dev', '--json', '--registry=https://registry.npmjs.org'], options)
    if (result.error || ![0, 1].includes(result.status)) throw new Error('npm audit could not complete')
    const report = JSON.parse(result.stdout)
    const counts = report.metadata?.vulnerabilities
    if (report.error || !counts || !['info', 'low', 'moderate', 'high', 'critical', 'total']
      .every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)) throw new Error('npm audit returned no valid vulnerability assessment')
    if (['info', 'low', 'moderate', 'high', 'critical'].reduce((sum, key) => sum + counts[key], 0) !== counts.total) {
      throw new Error('npm audit returned inconsistent vulnerability counts')
    }
    return report
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

async function proposeNodeUpdate({ github, context, core, pin, target }) {
  // Revalidate even though these values normally come from the preceding check.
  if (version(pin)[0] !== version(target)[0] || compare(target, pin) <= 0) throw new Error('Only newer releases of the pinned Node major may be proposed')
  const { owner, repo } = context.repo
  const base = context.payload.repository.default_branch
  const { data: reference } = await github.rest.git.getRef({ owner, repo, ref: `heads/${base}` })
  const { data: file } = await github.rest.repos.getContent({ owner, repo, path: '.node-version', ref: reference.object.sha })
  if (file.type !== 'file' || file.encoding !== 'base64') throw new Error('Unexpected Node pin response')
  if (Buffer.from(file.content, 'base64').toString('utf8').trim() !== pin) {
    core.warning('The Node pin changed during the check; no proposal was written.')
    return
  }
  const branch = `maintenance/node-${target}`
  const previous = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'all', base, head: `${owner}:${branch}`, per_page: 100 })
  if (previous.length) { core.info('This Node release already has a proposal; leaving its review decision unchanged.'); return }
  // Never force-push or rewrite a pre-existing branch. An interrupted proposal
  // leaves a visible API failure for manual reconciliation rather than replay.
  await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: reference.object.sha })
  await github.rest.repos.createOrUpdateFileContents({ owner, repo, branch, path: '.node-version', sha: file.sha,
    message: `chore(runtime): propose Node ${target} LTS`, content: Buffer.from(`${target}\n`).toString('base64') })
  await github.rest.pulls.create({ owner, repo, base, head: branch, draft: false,
    title: `chore(runtime): update Node LTS to ${target}`,
    body: `Updates the exact Node pin from ${pin} to ${target} within the same LTS major.\n\n`
      + `[Node release notes](https://nodejs.org/en/blog/release/v${target}). `
      + `[Maintenance report](${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}).\n\n`
      + 'This updates the Node archive used by CI and both desktop hosts; npm remains the version supplied by that archive. '
      + 'It does not separately replace npm or merge itself.\n\n'
      + 'Review and merge manually after PR validation. '
      + 'GITHUB_TOKEN-created pull requests do not automatically trigger another workflow; '
      + 'a maintainer can close and reopen this PR to trigger validation. '
      + 'Validate installer/upgrade behavior, rebuild and publish CodeNomad before users receive the updated runtime.' })
}

async function main() {
  const root = path.resolve(__dirname, '../..')
  const pin = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim()
  const json = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`Metadata request failed (${response.status})`)
    return response.json()
  }
  const [releases, npm] = await Promise.all([json('https://nodejs.org/dist/index.json'), json('https://registry.npmjs.org/npm/latest')])
  const report = assessRuntime(pin, releases, npm.version)
  const audit = auditNpm(report.npmBundled)
  const vulnerabilities = audit.metadata.vulnerabilities
  if (process.env.RUNNER_TEMP) fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'bundled-npm-audit.json'), JSON.stringify(audit, null, 2))
  const warnings = []
  if (report.nodeUpdate) warnings.push(`Node ${pin}: newer LTS release ${report.target} is available within the same major.`)
  if (report.npmUpdate) warnings.push(`Bundled npm ${report.npmBundled}: npm ${report.npmLatest} is available. Manual review only; no npm update is performed.`)
  if (vulnerabilities.total) warnings.push(`The npm ${report.npmBundled} CLI/dependency audit reports ${vulnerabilities.total} affected package entries (${vulnerabilities.high} high, ${vulnerabilities.critical} critical). Manual assessment is required.`)
  for (const message of warnings) console.log(process.env.GITHUB_ACTIONS === 'true' ? `::warning::${message}` : `Warning: ${message}`)
  const summary = `## Bundled runtime maintenance\n\nNode pin: **${pin}**; latest LTS in this major: **${report.target}**.\n\n`
    + `npm supplied by the pinned Node archive: **${report.npmBundled}**; latest published npm: **${report.npmLatest}**.\n\n`
    + `Published npm CLI and bundled dependency audit: **${vulnerabilities.total}** affected package entries (not a count of distinct CVEs).\n\n`
    + warnings.map(message => `- ${message}`).join('\n')
    + '\n\nAn available update is not proof of a vulnerability. Audit findings require applicability review. '
    + 'npm is never independently updated by this workflow, including for a security warning. '
    + 'No installed application is modified; approved Node changes require a new application build/release.\n'
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `pin=${pin}\ntarget=${report.target}\nnode-update=${report.nodeUpdate}\n`)
}

module.exports = { assessRuntime, auditNpm, proposeNodeUpdate }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
