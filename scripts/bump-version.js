#!/usr/bin/env node

const { spawnSync } = require("child_process")

const versionArgs = process.argv.slice(2)

if (versionArgs.length === 0) {
  console.error("[bumpVersion] missing version argument (example: npm run bumpVersion -- patch)")
  process.exit(1)
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"

function runStep(args, label) {
  const result = spawnSync(npmCommand, args, {
    stdio: "inherit",
  })

  if (result.error) {
    console.error(`[bumpVersion] failed during ${label}: ${result.error.message}`)
    process.exit(1)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

runStep(
  [
    "version",
    ...versionArgs,
    "--workspaces",
    "--include-workspace-root",
    "--no-git-tag-version",
  ],
  "npm version"
)

runStep(["run", "sync:version", "--workspace", "@codenomad/tauri-app"], "tauri version sync")
