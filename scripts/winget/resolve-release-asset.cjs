#!/usr/bin/env node

const crypto = require("node:crypto")
const fs = require("node:fs")
const { Readable } = require("node:stream")

function printHelp() {
  console.log(`Usage: node scripts/winget/resolve-release-asset.cjs [options]

Options:
  --repo <owner/repo>                 GitHub repository that owns the release
  --release-id <id>                   Numeric GitHub release id
  --tag <tag>                         Release tag (used for version derivation)
  --asset-name-template <template>    Expected asset template, use {version} placeholder
  --asset-regex <regex>               Override exact-match template with a regex
  --timeout-seconds <seconds>         Total polling timeout (default: 900)
  --poll-interval-seconds <seconds>   Poll interval (default: 15)
  --token <token>                     Optional GitHub token for release API calls
  --github-output <path>              Write GitHub Actions outputs to this file
  --json                              Print JSON result to stdout
  --help                              Show this message
`)
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help") {
      args.help = true
      continue
    }
    if (arg === "--json") {
      args.json = true
      continue
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`)
    }
    const key = arg.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`)
    }
    args[key] = value
    index += 1
  }
  return args
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function normalizeVersionFromTag(tag) {
  if (!tag) {
    throw new Error("A release tag is required to derive the package version")
  }
  return tag.startsWith("v") ? tag.slice(1) : tag
}

function buildMatcher({ version, assetNameTemplate, assetRegex }) {
  if (assetRegex) {
    return {
      description: assetRegex,
      regex: new RegExp(assetRegex),
    }
  }

  const template = assetNameTemplate || "CodeNomad-Tauri-windows-x64-{version}.zip"
  if (!template.includes("{version}")) {
    throw new Error("asset-name-template must include the {version} placeholder")
  }

  const expectedName = template.replaceAll("{version}", version)

  return {
    description: expectedName,
    regex: new RegExp(`^${escapeRegex(expectedName)}$`),
  }
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "CodeNomad-winget-release-automation",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub API request failed (${response.status}): ${body}`)
  }

  return response.json()
}

async function downloadAndHash(url) {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Asset download failed (${response.status})`)
  }

  const hash = crypto.createHash("sha256")
  const stream = Readable.fromWeb(response.body)

  for await (const chunk of stream) {
    hash.update(chunk)
  }

  return hash.digest("hex").toUpperCase()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const repo = args.repo
  const releaseId = args["release-id"]
  const tag = args.tag
  const timeoutSeconds = Number(args["timeout-seconds"] || 900)
  const pollIntervalSeconds = Number(args["poll-interval-seconds"] || 15)

  if (!repo || !releaseId || !tag) {
    throw new Error("--repo, --release-id, and --tag are required")
  }

  const version = normalizeVersionFromTag(tag)
  const matcher = buildMatcher({
    version,
    assetNameTemplate: args["asset-name-template"],
    assetRegex: args["asset-regex"],
  })

  const deadline = Date.now() + timeoutSeconds * 1000
  const releaseUrl = `https://api.github.com/repos/${repo}/releases/${releaseId}`
  const token = args.token || process.env.GITHUB_TOKEN || ""

  let release
  let asset

  while (Date.now() <= deadline) {
    release = await githubJson(releaseUrl, token)
    const matches = (release.assets || []).filter(
      (candidate) => matcher.regex.test(candidate.name) && candidate.state === "uploaded" && candidate.size > 0,
    )

    if (matches.length === 1) {
      asset = matches[0]
      break
    }

    if (matches.length > 1) {
      throw new Error(`Matched multiple assets for ${matcher.description}: ${matches.map((item) => item.name).join(", ")}`)
    }

    const visibleAssets = (release.assets || []).map((item) => item.name).join(", ") || "no assets"
    console.error(`Waiting for release asset ${matcher.description} on ${repo}@${tag}; currently saw ${visibleAssets}`)
    await sleep(pollIntervalSeconds * 1000)
  }

  if (!asset || !release) {
    throw new Error(`Timed out after ${timeoutSeconds}s waiting for release asset ${matcher.description}`)
  }

  const sha256 = await downloadAndHash(asset.browser_download_url)
  const result = {
    asset_name: asset.name,
    asset_regex: matcher.regex.source,
    asset_sha256: sha256,
    asset_url: asset.browser_download_url,
    release_url: release.html_url,
    tag_name: release.tag_name,
    version,
  }

  if (args["github-output"]) {
    const lines = Object.entries(result).map(([key, value]) => `${key}=${value}`)
    await fs.promises.appendFile(args["github-output"], `${lines.join("\n")}\n`, "utf8")
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.error(`Resolved ${result.asset_name} (${result.asset_sha256})`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
