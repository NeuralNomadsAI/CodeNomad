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
function assessNode(pin, releases) {
  const major = version(pin)[0]
  if (!Array.isArray(releases)) throw new Error('Invalid Node release index')
  const current = releases.find(release => release.version === `v${pin}`)
  if (!current?.lts) throw new Error('The pinned Node release is not a known LTS release')
  const candidates = releases.filter(release => typeof release.version === 'string'
    && new RegExp(`^v${major}\\.\\d{1,4}\\.\\d{1,4}$`).test(release.version) && release.lts)
    .sort((a, b) => compare(b.version.slice(1), a.version.slice(1)))
  const target = candidates[0].version.slice(1)
  return { pin, target, nodeUpdate: compare(target, pin) > 0 }
}

/** Electron's integrated Node for the exact Electron version CodeNomad pins. */
function electronNode(electronVersion, releases) {
  version(electronVersion)
  if (!Array.isArray(releases)) throw new Error('Invalid Electron release index')
  const node = releases.find(release => release.version === electronVersion)?.node
  version(node)
  return node
}

/** The runtimes the bundled npm runs under: CI and Tauri (`.node-version`) and Electron. */
function npmRuntimes(nodePin, electronVersion, electronNodeVersion) {
  for (const value of [nodePin, electronVersion, electronNodeVersion]) version(value)
  return [{ name: `Node ${nodePin} (.node-version: CI and Tauri)`, node: nodePin },
    { name: `Electron ${electronVersion}'s Node ${electronNodeVersion}`, node: electronNodeVersion }]
}

/** A newer npm is proposed, majors included, only when its engines accept every runtime. */
function assessNpm(pin, latest, runtimes, semver) {
  version(pin)
  version(latest?.version)
  const update = compare(latest.version, pin) > 0
  const engine = latest.engines?.node
  if (update && (typeof engine !== 'string' || !engine.trim() || semver.validRange(engine) === null)) {
    throw new Error('The latest npm declares no valid engines.node range')
  }
  const rejected = update ? runtimes.filter(runtime => !semver.satisfies(runtime.node, engine)).map(runtime => runtime.name) : []
  return { pin, target: latest.version, engine, update, major: version(latest.version)[0] > version(pin)[0],
    compatible: update && !rejected.length, rejected }
}

/** npm's own semver: the check runs before any dependency installation. */
function npmSemver(npmCli = process.env.npm_execpath, execPath = process.execPath) {
  const roots = [...(npmCli ? [path.dirname(path.dirname(npmCli))] : []),
    path.join(path.dirname(execPath), 'node_modules', 'npm'), path.join(path.dirname(execPath), '..', 'lib', 'node_modules', 'npm')]
  const root = roots.find(candidate => fs.existsSync(path.join(candidate, 'node_modules', 'semver', 'package.json')))
  if (!root) throw new Error('Could not locate npm\'s semver to evaluate engines.node')
  return require(path.join(root, 'node_modules', 'semver'))
}

function auditCounts(value) {
  const counts = typeof value === 'string' ? JSON.parse(value) : value
  const keys = ['info', 'low', 'moderate', 'high', 'critical', 'total']
  if (!counts || !keys.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)) throw new Error('Invalid audit counts')
  return Object.fromEntries(keys.map(key => [key, counts[key]]))
}

const describeAudit = counts => `${counts.total} affected package entries (${counts.critical} critical, ${counts.high} high, `
  + `${counts.moderate} moderate, ${counts.low} low)`

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

async function readBaseFile(github, owner, repo, sha, file) {
  const { data } = await github.rest.repos.getContent({ owner, repo, path: file, ref: sha })
  if (data.type !== 'file' || data.encoding !== 'base64') throw new Error(`Unexpected ${file} response`)
  return { sha: data.sha, text: Buffer.from(data.content, 'base64').toString('utf8') }
}

const VALIDATION_NOTE = 'Review and merge manually after PR validation. '
  + 'GitHub holds the PR Build Validation runs of a pull request opened with GITHUB_TOKEN for approval: '
  + 'a maintainer with write access selects **Approve workflows to run** on this PR '
  + '(or closes and reopens it with their own account) to start validation. '
  + 'Validate installer/upgrade behavior, rebuild and publish CodeNomad before users receive the updated runtime.'

/** Writes one pin file on a new version-specific branch and opens a regular PR. `basis`
 * lists other files of the same base snapshot the proposal's checks relied on. */
async function proposePin({ github, context, core, file, pin, target, branch, message, title, body, basis = {} }) {
  const { owner, repo } = context.repo
  const base = context.payload.repository.default_branch
  const { data: reference } = await github.rest.git.getRef({ owner, repo, ref: `heads/${base}` })
  const current = await readBaseFile(github, owner, repo, reference.object.sha, file)
  if (current.text.trim() !== pin) {
    core.warning(`${file} changed during the check; no proposal was written.`)
    return
  }
  for (const [path, expected] of Object.entries(basis)) {
    if (expected((await readBaseFile(github, owner, repo, reference.object.sha, path)).text)) continue
    core.warning(`${path} changed during the check; no proposal was written.`)
    return
  }
  const previous = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'all', base, head: `${owner}:${branch}`, per_page: 100 })
  if (previous.length) { core.info('This release already has a proposal; leaving its review decision unchanged.'); return }
  // Never force-push, rewrite or delete a pre-existing branch: a branch without
  // a pull request (an earlier run stopped after creating it) fails the job
  // every run until a maintainer opens its PR or deletes it.
  const reconcile = `open its pull request manually or delete the branch; maintenance never overwrites it`
  const orphan = await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })
    .then(() => true, error => { if (error.status === 404) return false; throw error })
  if (orphan) throw new Error(`Branch ${branch} exists without a pull request: ${reconcile}.`)
  await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: reference.object.sha })
  try {
    await github.rest.repos.createOrUpdateFileContents({ owner, repo, branch, path: file, sha: current.sha,
      message, content: Buffer.from(`${target}\n`).toString('base64') })
    await github.rest.pulls.create({ owner, repo, base, head: branch, draft: false, title, body })
  } catch (error) {
    throw new Error(`Branch ${branch} was created but its proposal did not complete (${error.message}): ${reconcile}.`)
  }
}

// engines.node is the npm publisher's declaration, never evidence of CodeNomad's behaviour.
const DECLARED_ONLY = 'This declaration is not a behavioural validation: only the proposal\'s PR build and the '
  + 'maintainer\'s checklist show whether CodeNomad works with this npm.'

/** Daily findings about the bundled npm; a proposal is opened only when `proposable`. */
function npmFindings({ npmPin, npm, candidateError }) {
  if (!npm.update) return { proposable: false, messages: [] }
  if (!npm.compatible) return { proposable: false, messages: [`Bundled npm ${npmPin}: npm ${npm.target} is available, but its engines.node `
    + `(${npm.engine}) excludes ${npm.rejected.join(' and ')}. No proposal is opened until that runtime is updated.`] }
  // Only the candidate's audit is optional: the pinned audit and every metadata request still fail the job.
  if (candidateError) return { proposable: false, messages: [`Bundled npm ${npmPin}: npm ${npm.target} is available, but its audit `
    + `could not complete (${candidateError}). No npm proposal is opened this run; the Node check and the pinned npm audit are unaffected.`] }
  return { proposable: true, messages: [`Bundled npm ${npmPin}: npm ${npm.target} is available`
    + `${npm.major ? ' as a major update (maintainer qualification needed)' : ''}; its engines.node includes every runtime. `
    + `${DECLARED_ONLY} A proposal is opened for review.`] }
}

const report = context => `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`

async function proposeNodeUpdate({ github, context, core, pin, target }) {
  // Revalidate even though these values normally come from the preceding check.
  if (version(pin)[0] !== version(target)[0] || compare(target, pin) <= 0) throw new Error('Only newer releases of the pinned Node major may be proposed')
  await proposePin({ github, context, core, file: '.node-version', pin, target, branch: `maintenance/node-${target}`,
    message: `chore(runtime): propose Node ${target} LTS`,
    title: `chore(runtime): update Node LTS to ${target}`,
    body: `Updates the exact Node pin from ${pin} to ${target} within the same LTS major.\n\n`
      + `[Node release notes](https://nodejs.org/en/blog/release/v${target}). [Maintenance report](${report(context)}).\n\n`
      + 'This updates the Node archive used by CI and Tauri; both desktop hosts keep the npm pinned in `.npm-version`, '
      + 'whose `engines.node` the desktop preparation checks against this Node. It does not change npm or merge itself.\n\n'
      + VALIDATION_NOTE })
}

/** Proposes `.npm-version` only; the check job established that the target's
 * engines accept `.node-version` and the pinned Electron's Node. */
async function proposeNpmUpdate({ github, context, core, pin, target, engine, nodePin, electron, electronNode: electronNodeVersion, audit, pinnedAudit }) {
  if (compare(target, pin) <= 0) throw new Error('Only a newer npm release may be proposed')
  for (const value of [nodePin, electron, electronNodeVersion]) version(value)
  if (typeof engine !== 'string' || !/^[\w.\s|<>=^~*-]{1,200}$/.test(engine)) throw new Error('Invalid npm engines.node range')
  const counts = auditCounts(audit), pinnedCounts = auditCounts(pinnedAudit)
  const major = version(target)[0] > version(pin)[0]
  const crossed = `${version(pin)[0]}.x → ${version(target)[0]}.x`
  await proposePin({ github, context, core, file: '.npm-version', pin, target, branch: `maintenance/npm-${target}`,
    message: `chore(runtime): propose npm ${target}`,
    title: `chore(runtime): update bundled npm to ${target}${major ? ` (major ${crossed}: maintainer qualification needed)` : ''}`,
    basis: { '.node-version': text => text.trim() === nodePin,
      'packages/electron-app/package.json': text => JSON.parse(text).devDependencies?.electron === electron },
    body: `Proposes the bundled npm pin (\`.npm-version\`) of both desktop hosts from ${pin} to ${target}`
      + `${major ? ` (major update ${crossed})` : ''}.\n\n`
      + (major ? '**Major npm update: maintainer qualification needed before merging.** npm publishes fixes on its current '
        + 'major line, so the maintenance check proposes majors too, but never adopts one: its breaking changes need the '
        + 'maintainer\'s qualification with the checklist below.\n\n' : '')
      + `npm ${target} declares \`engines.node\` \`${engine}\`, which includes Node ${nodePin} (\`.node-version\`: CI and Tauri) `
      + `and Node ${electronNodeVersion} integrated in Electron ${electron}. ${DECLARED_ONLY}\n\n`
      + `Audit of the published npm CLI and its bundled dependencies: npm ${target}: ${describeAudit(counts)}; `
      + `pinned npm ${pin}: ${describeAudit(pinnedCounts)}. The JSON reports are kept for seven days in the `
      + `[maintenance report](${report(context)}).\n\n`
      + `[npm ${target} release notes](https://github.com/npm/cli/releases/tag/v${target}). `
      + '[npm changelog](https://github.com/npm/cli/blob/latest/CHANGELOG.md).\n\n'
      + 'Before merging, check:\n'
      + `- the release notes of every npm version after ${pin} up to ${target}, especially breaking changes to `
      + '`install`/`uninstall --global --prefix`, flag parsing, configuration, and the dependency lifecycle-script '
      + 'policy (`allow-scripts`): OpenCode\'s postinstall must still run during installation and native upgrade;\n'
      + '- the PR build\'s desktop packaging tests, packaged-resources smoke (npm engines against each host\'s Node) and the '
      + 'first-installation fixtures with Tauri\'s Node and with Electron\'s npm-only resources, which install OpenCode with this npm;\n'
      + '- the native OpenCode install, upgrade and legacy-replacement fixtures run locally against both packaged hosts with this npm '
      + '(`scripts/test-opencode-*-native.mjs`): the PR build runs only first installation with the bundled npm;\n'
      + '- the audit findings above for applicability.\n\n'
      + 'This changes only `.npm-version`; Node and Electron are unchanged. It does not merge itself.\n\n'
      + VALIDATION_NOTE })
}

async function main() {
  const root = path.resolve(__dirname, '../..')
  const read = file => fs.readFileSync(path.join(root, file), 'utf8')
  const pin = read('.node-version').trim()
  const npmPin = read('.npm-version').trim()
  const electron = JSON.parse(read('packages/electron-app/package.json')).devDependencies?.electron
  const json = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`Metadata request failed (${response.status})`)
    return response.json()
  }
  const [releases, latestNpm, electronReleases] = await Promise.all([json('https://nodejs.org/dist/index.json'),
    json('https://registry.npmjs.org/npm/latest'), json('https://releases.electronjs.org/releases.json')])
  const node = assessNode(pin, releases)
  const electronNodeVersion = electronNode(electron, electronReleases)
  const npm = assessNpm(npmPin, latestNpm, npmRuntimes(pin, electron, electronNodeVersion), npmSemver())
  const pinnedAudit = auditNpm(npmPin)
  let candidateAudit, candidateError
  if (npm.compatible) {
    try { candidateAudit = auditNpm(npm.target) } catch (error) { candidateError = error.message }
  }
  const pinnedCounts = auditCounts(pinnedAudit.metadata.vulnerabilities)
  const candidateCounts = candidateAudit && auditCounts(candidateAudit.metadata.vulnerabilities)
  const findings = npmFindings({ npmPin, npm, candidateError })
  if (process.env.RUNNER_TEMP) fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'bundled-npm-audit.json'), JSON.stringify({
    pinned: { version: npmPin, report: pinnedAudit }, ...(candidateAudit ? { candidate: { version: npm.target, report: candidateAudit } } : {}) }, null, 2))
  const warnings = []
  if (node.nodeUpdate) warnings.push(`Node ${pin}: newer LTS release ${node.target} is available within the same major.`)
  warnings.push(...findings.messages)
  if (pinnedCounts.total) warnings.push(`The pinned npm ${npmPin} CLI/dependency audit reports ${describeAudit(pinnedCounts)}. Manual assessment is required.`)
  for (const message of warnings) console.log(process.env.GITHUB_ACTIONS === 'true' ? `::warning::${message}` : `Warning: ${message}`)
  const summary = `## Bundled runtime maintenance\n\nNode pin: **${pin}**; latest LTS in this major: **${node.target}**.\n\n`
    + `Bundled npm pin: **${npmPin}**; latest published npm: **${npm.target}**`
    + (npm.update ? ` (engines.node \`${npm.engine}\`)` : '') + `; Electron ${electron} integrates Node **${electronNodeVersion}**.\n\n`
    + `Published npm CLI and bundled dependency audit (affected package entries, not distinct CVEs): npm ${npmPin}: **${describeAudit(pinnedCounts)}**`
    + (candidateCounts ? `; npm ${npm.target}: **${describeAudit(candidateCounts)}**` : '') + '.\n\n'
    + warnings.map(message => `- ${message}`).join('\n')
    + '\n\nAn available update is not proof of a vulnerability. Audit findings require applicability review. '
    + 'Proposals change one pin each and are merged manually. '
    + 'No installed application is modified; approved runtime changes require a new application build/release.\n'
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `pin=${pin}\ntarget=${node.target}\nnode-update=${node.nodeUpdate}\n`
    + `npm-pin=${npmPin}\nnpm-target=${npm.target}\nnpm-update=${findings.proposable}\nnpm-engine=${npm.engine ?? ''}\n`
    + `electron=${electron}\nelectron-node=${electronNodeVersion}\n`
    + `npm-audit=${JSON.stringify(candidateCounts ?? null)}\nnpm-pinned-audit=${JSON.stringify(pinnedCounts)}\n`)
}

module.exports = { assessNode, assessNpm, auditNpm, electronNode, npmFindings, npmRuntimes, npmSemver, proposeNodeUpdate, proposeNpmUpdate }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
