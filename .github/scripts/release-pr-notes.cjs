// Prints the description of the pull request whose merge produced a release commit.
// Usage: gh api "repos/<repo>/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=50" \
//   | node .github/scripts/release-pr-notes.cjs <merge commit sha>
// The PR is matched by merge_commit_sha: commits/<sha>/pulls returned no PR for a fresh
// release merge commit, which exists only on main while the default branch is dev.

function releasePullRequestBody(pulls, sha, base = "main") {
  if (!Array.isArray(pulls)) throw new Error("Expected a pull request list")
  const pull = pulls.find((entry) => entry?.merged_at && entry.base?.ref === base && entry.merge_commit_sha === sha)
  return typeof pull?.body === "string" ? pull.body : ""
}

if (require.main === module) {
  const sha = process.argv[2]
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("Pass the full merge commit SHA")
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => process.stdout.write(releasePullRequestBody(JSON.parse(input), sha)))
}

module.exports = { releasePullRequestBody }
