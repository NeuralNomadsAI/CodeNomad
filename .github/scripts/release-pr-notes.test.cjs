const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")
const { releasePullRequestBody } = require("./release-pr-notes.cjs")

const sha = "83709373b982908a9976247eca4616f0df8f984b"
const pull = (number, fields) => ({ number, merged_at: "2026-10-24T13:57:43Z", base: { ref: "main" }, merge_commit_sha: sha, body: `notes ${number}`, ...fields })

test("the release notes come from the PR merged into main by the release commit", () => {
  const pulls = [
    pull(1, { merge_commit_sha: "0".repeat(40) }),
    pull(2, { merged_at: null }),
    pull(3, { base: { ref: "dev" } }),
    pull(1028, {}),
  ]
  assert.equal(releasePullRequestBody(pulls, sha), "notes 1028")
  assert.equal(releasePullRequestBody(pulls.slice(0, 3), sha), "", "no generated-notes-only fallback is mistaken for a PR")
  assert.equal(releasePullRequestBody([pull(4, { body: null })], sha), "")
  assert.throws(() => releasePullRequestBody({}, sha))
})

test("the command prints the body unchanged, including Unicode and line breaks", () => {
  const body = "# CodeNomad 1.0.0 — OpenCode V2\n\n- Café\n"
  const result = spawnSync(process.execPath, [path.join(__dirname, "release-pr-notes.cjs"), sha], {
    input: JSON.stringify([pull(1028, { body })]), encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, body)
})

test("the release workflow uses this lookup, not the default-branch-only commit association", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../workflows/reusable-release.yml"), "utf8")
  assert.match(workflow, /pulls\?state=closed&base=main[^\n]*\n[^\n]*node \.github\/scripts\/release-pr-notes\.cjs "\$\{GITHUB_SHA\}"/)
  assert.doesNotMatch(workflow, /commits\/\$\{GITHUB_SHA\}\/pulls/)
})
