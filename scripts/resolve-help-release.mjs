import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { readDownloads, validateRelease } from "./build-help.mjs"

// Resolves the newest stable release that carries every docs/help/downloads.json asset, for the
// help-pages workflow only. Local and pull-request builds never call it (see dev-docs/USER_HELP.md).
const repo = "https://github.com/NeuralNomadsAI/CodeNomad"
const FIRST_PAGE = "https://api.github.com/repos/NeuralNomadsAI/CodeNomad/releases?per_page=100"
// GitHub paginates this listing through the numeric path of NeuralNomadsAI/CodeNomad (id 1087925615).
const PAGE_PATH = /^\/(?:repos\/NeuralNomadsAI\/CodeNomad|repositories\/1087925615)\/releases$/
const STABLE_TAG = /^v\d+\.\d+\.\d+$/
const UTC_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const validDate = (value) => typeof value === "string" && UTC_DATE.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
// Workflow command data must not end the command or start a new line.
const commandData = (value) => String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
// Early non-prerelease builds such as v0.2.8-dev carry no stable version; only vMAJOR.MINOR.PATCH qualifies.
const isCandidate = (release) => !release.draft && !release.prerelease && STABLE_TAG.test(release.tag_name)

function checkRelease(release, index) {
  const fail = (message) => { throw new Error(`GitHub releases: entry ${index} ${message}`) }
  if (!plainObject(release)) fail("is not an object")
  if (typeof release.tag_name !== "string" || !release.tag_name) fail("has no tag_name")
  if (typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean") fail(`(${release.tag_name}) needs boolean draft and prerelease`)
  if (!Array.isArray(release.assets)) fail(`(${release.tag_name}) has no asset list`)
  for (const asset of release.assets) {
    if (!plainObject(asset) || typeof asset.name !== "string" || typeof asset.state !== "string" || typeof asset.browser_download_url !== "string" || !Number.isSafeInteger(asset.size) || asset.size < 0) {
      fail(`(${release.tag_name}) has a malformed asset`)
    }
  }
  if (isCandidate(release) && !validDate(release.published_at)) fail(`(${release.tag_name}) has an invalid published_at`)
}

const newestFirst = (left, right) => Date.parse(right.published_at) - Date.parse(left.published_at)

/**
 * Picks the newest published vMAJOR.MINOR.PATCH release (drafts, prereleases and other tags ignored) in which every
 * downloads.json entry matches exactly one uploaded, non-empty asset. Newer stable releases still
 * missing assets are returned in `skipped`; throws on malformed data or when none is complete.
 */
export function selectRelease(releases, downloads) {
  if (!Array.isArray(releases)) throw new Error("GitHub releases: expected a list")
  if (!Array.isArray(downloads) || !downloads.length) throw new Error("downloads.json: expected a non-empty list")
  releases.forEach(checkRelease)
  const stable = releases.filter(isCandidate)
  const tags = stable.map((release) => release.tag_name)
  const duplicate = tags.find((tag, index) => tags.indexOf(tag) !== index)
  if (duplicate) throw new Error(`GitHub releases: ${duplicate} is listed twice`)
  const skipped = []
  for (const release of stable.sort(newestFirst)) {
    const version = release.tag_name.slice(1)
    const assets = {}
    const missing = []
    for (const entry of downloads) {
      const name = entry.template.replace("{version}", version)
      const named = release.assets.filter((asset) => asset.name === name)
      if (named.length > 1) throw new Error(`GitHub releases: ${release.tag_name} lists ${name} ${named.length} times`)
      const asset = named.find((candidate) => candidate.state === "uploaded" && candidate.size > 0)
      if (!asset) {
        missing.push(name)
        continue
      }
      const url = `${repo}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`
      if (asset.browser_download_url !== url) throw new Error(`GitHub releases: ${release.tag_name} serves ${name} from an unexpected URL`)
      assets[entry.id] = { url, size: asset.size }
    }
    if (missing.length) {
      skipped.push({ tag: release.tag_name, missing })
      continue
    }
    const selected = { tag: release.tag_name, version, publishedAt: release.published_at, assets }
    validateRelease(selected, downloads)
    return { release: selected, skipped }
  }
  throw new Error(`GitHub releases: no stable release has every downloads.json asset${skipped.length ? ` (incomplete: ${skipped.map((item) => item.tag).join(", ")})` : ""}`)
}

/** Returns the `rel="next"` page of a GitHub Link header, accepted only for this repository's release listing. */
export function nextPage(header) {
  const link = [...(header ?? "").matchAll(/<([^>]*)>\s*;\s*rel="([^"]*)"/g)].find((match) => match[2].split(/\s+/).includes("next"))
  if (!link) return null
  let url
  try { url = new URL(link[1]) } catch { throw new Error("GitHub releases: malformed pagination link") }
  const query = [...url.searchParams.entries()]
  if (url.protocol !== "https:" || url.host !== "api.github.com" || url.username || url.password || url.hash || !PAGE_PATH.test(url.pathname)
    || query.length !== 2 || query.some(([key, value]) => !["per_page", "page"].includes(key) || !/^\d+$/.test(value)) || new Set(query.map(([key]) => key)).size !== 2) {
    throw new Error("GitHub releases: unexpected pagination link")
  }
  return url.href
}

/** Lists every release page by page, each request bounded by `timeoutMs`; fails past `maxPages`. */
export async function fetchReleases({ fetch, token, maxPages = 10, timeoutMs = 20_000 }) {
  const releases = []
  let url = FIRST_PAGE
  for (let page = 1; url; page++) {
    if (page > maxPages) throw new Error(`GitHub releases: more than ${maxPages} pages`)
    let body
    let link
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "CodeNomad-help-pages", "X-GitHub-Api-Version": "2022-11-28" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      link = response.headers.get("link")
      body = await response.json()
    } catch (error) {
      throw new Error(`GitHub releases: page ${page} request failed: ${error instanceof Error ? error.message : error}`)
    }
    if (!Array.isArray(body)) throw new Error(`GitHub releases: page ${page} is not a list`)
    releases.push(...body)
    url = nextPage(link)
  }
  return releases
}

/** CLI: `node scripts/resolve-help-release.mjs <output.json>` inside GitHub Actions with GH_TOKEN. */
export async function run({ argv = process.argv.slice(2), env = process.env, fetch = globalThis.fetch, log = console.log } = {}) {
  if (env.GITHUB_ACTIONS !== "true") throw new Error("resolve-help-release runs only in GitHub Actions; local builds omit --release or pass scripts/fixtures/help-release.json")
  if (argv.length !== 1 || argv[0].startsWith("-")) throw new Error("usage: node scripts/resolve-help-release.mjs <output.json>")
  if (!env.GH_TOKEN) throw new Error("GH_TOKEN is required")
  const output = resolve(argv[0])
  const downloads = await readDownloads()
  const { release, skipped } = selectRelease(await fetchReleases({ fetch, token: env.GH_TOKEN }), downloads)
  for (const { tag, missing } of skipped) {
    log(`::notice title=Help release::${commandData(`Download links use ${release.tag}: newer stable release ${tag} is missing ${missing.join(", ")}`)}`)
  }
  await writeFile(output, `${JSON.stringify(release, null, 2)}\n`)
  validateRelease(JSON.parse(await readFile(output, "utf8")), downloads)
  log(`Resolved help downloads from ${release.tag}, published ${release.publishedAt}`)
  return release
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await run()
  } catch (error) {
    console.log(`::error title=Help release::${commandData(error instanceof Error ? error.message : error)}`)
    process.exitCode = 1
  }
}
