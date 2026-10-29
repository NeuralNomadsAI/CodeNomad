import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"

import { forgeWebUrl, literalSearchTerms } from "./providers"
import { parseRemoteUrl, readForgeRemote } from "./remote"
import { parseIncludedResponse, readBoundedText, teaTransport, type ProcessRunner } from "./transport"
import { ForgeWorkItems } from "./work-items"

const roots: string[] = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

function checkout(remotes: Record<string, string>): string {
  const directory = mkdtempSync(path.join(tmpdir(), "codenomad-forge-"))
  roots.push(directory)
  execFileSync("git", ["init", "-q", directory])
  for (const [name, url] of Object.entries(remotes)) execFileSync("git", ["-C", directory, "remote", "add", name, url])
  return directory
}

async function until(check: () => boolean, label = "condition reached") {
  for (let attempt = 0; attempt < 500 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(check(), label)
}

const included = (status: number, headers: Record<string, string>, body: unknown) =>
  `HTTP/2.0 ${status} X\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n${JSON.stringify(body)}`

type Call = { command: string; args: string[] }
function cli(respond: (call: Call) => { stdout?: string; stderr?: string; code?: number | string }) {
  const calls: Call[] = []
  const run: ProcessRunner = async (command, args) => {
    calls.push({ command, args })
    const result = respond({ command, args })
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 }
  }
  return { run, calls }
}

function web(respond: (url: string) => { status: number; headers?: Record<string, string>; body?: unknown }) {
  const urls: string[] = []
  const fetcher = (async (input: string | URL) => {
    urls.push(String(input))
    const result = respond(String(input))
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), { status: result.status, headers: result.headers })
  }) as typeof fetch
  return { fetcher, urls }
}

const gitHubIssue = (number: number, extra: Record<string, unknown> = {}) => ({ number, title: `Item ${number}`, state: "open",
  html_url: `https://github.com/o/r/issues/${number}`, updated_at: "2026-10-29T00:00:00Z", user: { login: "dev" }, labels: [{ name: "bug" }], ...extra })

describe("forge remotes", () => {
  it("parses HTTPS, SSH and scp-like remotes, and nothing else", () => {
    assert.deepEqual(parseRemoteUrl("https://github.com/NeuralNomadsAI/CodeNomad.git"), { host: "github.com", path: "NeuralNomadsAI/CodeNomad" })
    assert.deepEqual(parseRemoteUrl("git@GitLab.com:group/sub/project.git"), { host: "gitlab.com", path: "group/sub/project" })
    assert.deepEqual(parseRemoteUrl("ssh://git@codeberg.org:2222/forgejo/forgejo"), { host: "codeberg.org", path: "forgejo/forgejo" })
    assert.deepEqual(parseRemoteUrl("https://user:secret@git.example.com/team/app/"), { host: "git.example.com", path: "team/app" })
    for (const url of ["C:/repos/app", "C:\\repos\\app", "/srv/git/app.git", "file:///srv/app", "https://github.com/only-owner", "git@host:../escape/x", "",
      "git@localhost#ignored:team/app", "git@host?x:team/app", "git@host\\evil:team/app", "https://host/team/app%3Fq", "https://ho_st/team/app"]) {
      assert.equal(parseRemoteUrl(url), undefined, url)
    }
  })

  it("keeps an HTTPS forge's port, which an SSH transport port is not", () => {
    assert.deepEqual(parseRemoteUrl("https://git.example.com:8443/team/app.git"), { host: "git.example.com:8443", path: "team/app" })
    assert.deepEqual(parseRemoteUrl("ssh://git@git.example.com:2222/team/app.git"), { host: "git.example.com", path: "team/app" })
    assert.equal(forgeWebUrl("gitea", "git.example.com:8443", "team/app", "issue", 1), "https://git.example.com:8443/team/app/issues/1")
  })

  it("prefers the upstream of a fork, then origin, then any forge remote", async () => {
    assert.deepEqual(await readForgeRemote(checkout({ origin: "https://github.com/me/app.git", upstream: "https://github.com/team/app.git" })),
      { host: "github.com", path: "team/app" })
    assert.deepEqual(await readForgeRemote(checkout({ backup: "/srv/app.git", origin: "git@gitlab.com:team/app.git" })), { host: "gitlab.com", path: "team/app" })
    assert.deepEqual(await readForgeRemote(checkout({ mirror: "https://codeberg.org/team/app" })), { host: "codeberg.org", path: "team/app" })
    assert.equal(await readForgeRemote(checkout({})), undefined)
  })

  it("builds each forge's web page for an item", () => {
    assert.equal(forgeWebUrl("github", "github.com", "o/r", "pullRequest", 7), "https://github.com/o/r/pull/7")
    assert.equal(forgeWebUrl("gitlab", "gitlab.com", "g/s/p", "pullRequest", 7), "https://gitlab.com/g/s/p/-/merge_requests/7")
    assert.equal(forgeWebUrl("gitea", "codeberg.org", "o/r", "issue", 7), "https://codeberg.org/o/r/issues/7")
  })
})

describe("forge transports", () => {
  it("parses the status, headers and body that gh and glab print with -i", () => {
    const response = parseIncludedResponse(included(200, { "X-Total": "3", Link: "<x>; rel=next" }, [{ a: 1 }]))
    assert.deepEqual([response?.status, response?.headers.get("x-total"), response?.body], [200, "3", '[{"a":1}]'])
    assert.equal(parseIncludedResponse("gh: not found"), undefined)
  })

  it("reads tea's status from stderr, since tea exits 0 on HTTP errors", async () => {
    const { run, calls } = cli(() => ({ stdout: '{"message":"not found"}', stderr: "HTTP/1.1 404 Not Found\nX-Total-Count: 0\n" }))
    const response = await teaTransport("work", run).request("repos/o/r/issues/9", new AbortController().signal)
    assert.deepEqual([response.status, response.headers.get("x-total-count")], [404, "0"])
    assert.deepEqual(calls[0]!.args, ["api", "--login", "work", "-i", "/repos/o/r/issues/9"])
  })
})

describe("forge work items", () => {
  it("lists one bounded kind with its open total through the signed-in gh, quietly", async () => {
    const directory = checkout({ origin: "https://github.com/o/r.git" })
    const { run, calls } = cli(() => ({ stdout: included(200, {}, { total_count: 45, items: Array.from({ length: 25 }, (_, index) => gitHubIssue(index + 1)) }) }))
    const result = await new ForgeWorkItems({ run }).list(directory, { kind: "issue", query: "crash on start", page: 2 })
    assert.equal(result.status, "ok")
    if (result.status !== "ok") return
    assert.deepEqual(result.repository, { provider: "github", host: "github.com", path: "o/r", webUrl: "https://github.com/o/r", access: "cli" })
    assert.deepEqual([result.items.length, result.total, result.hasMore, result.page], [20, 45, true, 2])
    assert.deepEqual(result.items[0], { kind: "issue", number: 1, title: "Item 1", state: "open", draft: false, author: "dev", labels: ["bug"],
      updatedAt: "2026-10-29T00:00:00Z", url: "https://github.com/o/r/issues/1" })
    assert.deepEqual(calls[0]!.args, ["api", "--hostname", "github.com", "-i",
      "search/issues?q=repo%3Ao%2Fr%20is%3Aissue%20is%3Aopen%20%22crash%22%20%22on%22%20%22start%22&sort=updated&order=desc&per_page=20&page=2"])
  })

  it("falls back to anonymous access when gh is missing or signed out, and reports private repositories as needing sign-in", async () => {
    const directory = checkout({ origin: "git@github.com:o/r.git" })
    for (const code of ["ENOENT", 4]) {
      const { run } = cli(() => ({ code, stderr: "gh auth login" }))
      const { fetcher, urls } = web(() => ({ status: 200, body: { total_count: 1, items: [gitHubIssue(3, { pull_request: { merged_at: null } })] } }))
      const result = await new ForgeWorkItems({ run, fetcher }).list(directory, { kind: "pullRequest", query: "", page: 1 })
      assert.equal(result.status === "ok" && result.repository.access, "anonymous")
      assert.equal(result.status === "ok" && result.items[0]?.kind, "pullRequest")
      assert.match(urls[0]!, /^https:\/\/api\.github\.com\/search\/issues\?q=repo%3Ao%2Fr%20is%3Apr%20is%3Aopen/)
    }
    const signedOut = cli(() => ({ code: 4 }))
    const failures: Array<[number, Record<string, string>, string]> = [[422, {}, "sign_in"], [404, {}, "sign_in"],
      [403, { "x-ratelimit-remaining": "0" }, "rate_limited"], [429, {}, "rate_limited"]]
    for (const [status, headers, reason] of failures) {
      const { fetcher } = web(() => ({ status, headers, body: { message: "x" } }))
      assert.deepEqual(await new ForgeWorkItems({ run: signedOut.run, fetcher }).list(directory, { kind: "issue", query: "", page: 1 }),
        { status: "unavailable", reason }, String(status))
    }
    const { fetcher } = web(() => ({ status: 502, body: {} }))
    await assert.rejects(new ForgeWorkItems({ run: signedOut.run, fetcher }).list(directory, { kind: "issue", query: "", page: 1 }), /HTTP 502/)
  })

  it("reads GitLab merge requests and Gitea pulls with their header totals and states", async () => {
    const gitlab = cli(() => ({ stdout: included(200, { "X-Total": "79", "X-Next-Page": "2" }, [{ iid: 4255, title: "Fix", state: "opened", draft: true,
      web_url: "https://gitlab.com/g/p/-/merge_requests/4255", updated_at: "u", author: { username: "kai" }, labels: ["bug"] }]) }))
    const lab = await new ForgeWorkItems({ run: gitlab.run }).list(checkout({ origin: "git@gitlab.com:g/p.git" }), { kind: "pullRequest", query: "fix", page: 1 })
    assert.deepEqual(lab.status === "ok" && [lab.total, lab.hasMore, lab.items[0]], [79, true,
      { kind: "pullRequest", number: 4255, title: "Fix", state: "open", draft: true, author: "kai", labels: ["bug"], updatedAt: "u", url: "https://gitlab.com/g/p/-/merge_requests/4255" }])
    assert.deepEqual(gitlab.calls[0]!.args, ["api", "--hostname", "gitlab.com", "-i",
      "projects/g%2Fp/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=20&page=1&search=fix&in=title,description"])

    const tea = cli(({ args }) => args[0] === "logins" ? { stdout: JSON.stringify([{ name: "other", url: "https://gitea.com" }]) } : {})
    const { fetcher, urls } = web(() => ({ status: 200, headers: { "X-Total-Count": "162" }, body: [{ number: 9, title: "Pull", state: "closed",
      html_url: "https://codeberg.org/o/r/pulls/9", updated_at: "u", user: { login: "m" }, labels: [{ name: "ui" }], pull_request: { merged: true } }] }))
    const tead = await new ForgeWorkItems({ run: tea.run, fetcher }).list(checkout({ origin: "https://codeberg.org/o/r" }), { kind: "pullRequest", query: "", page: 3 })
    assert.deepEqual(tead.status === "ok" && [tead.repository.access, tead.total, tead.hasMore, tead.items[0]?.state], ["anonymous", 162, true, "merged"])
    assert.equal(urls[0], "https://codeberg.org/api/v1/repos/o/r/issues?state=open&type=pulls&limit=20&page=3")
  })

  it("looks one number up in its own kind, and an unknown number as no item", async () => {
    const directory = checkout({ origin: "https://github.com/o/r" })
    const { run, calls } = cli(({ args }) => args[4]!.endsWith("/77") ? { stdout: included(200, {}, gitHubIssue(77, { state: "closed", pull_request: { merged_at: "t" } })) }
      : { stdout: included(404, {}, { message: "Not Found" }), code: 1 })
    const forge = new ForgeWorkItems({ run })
    const found = await forge.list(directory, { kind: "pullRequest", query: "#77", page: 1 })
    assert.deepEqual(found.status === "ok" && found.items.map(item => [item.number, item.state]), [[77, "merged"]])
    assert.deepEqual(await forge.list(directory, { kind: "issue", query: "77", page: 1 }).then(result => result.status === "ok" && result.items), [], "a pull request is not an issue")
    assert.deepEqual(await forge.list(directory, { kind: "issue", query: "#5", page: 1 }).then(result => result.status === "ok" && result.items), [])
    assert.deepEqual(calls.map(call => call.args[4]), ["repos/o/r/issues/77", "repos/o/r/issues/77", "repos/o/r/issues/5"])
  })

  it("reads a self-hosted forge only through a CLI signed in to its exact authority, and never contacts it anonymously", async () => {
    const hosted = checkout({ origin: "https://git.example.com:8443/team/app.git" })
    const viaTea = cli(({ command, args }) => command === "tea" && args[0] === "logins"
      ? { stdout: JSON.stringify([{ name: "other-port", url: "https://git.example.com" }, { name: "work", url: "https://git.example.com:8443" }]) }
      : command === "tea" ? { stderr: "HTTP/1.1 200 OK\nX-Total-Count: 4\n", stdout: "[]" } : { code: 1 })
    const anywhere = web(() => ({ status: 500 }))
    const result = await new ForgeWorkItems({ run: viaTea.run, fetcher: anywhere.fetcher }).list(hosted, { kind: "issue", query: "", page: 1 })
    assert.deepEqual(result.status === "ok" && [result.repository.provider, result.repository.access, result.total], ["gitea", "cli", 4])
    assert.deepEqual(viaTea.calls.at(-1)!.args.slice(0, 3), ["api", "--login", "work"])

    const viaGlab = cli(({ command, args }) => command === "glab" && args[0] === "auth" ? {}
      : command === "glab" ? { stdout: included(200, { "X-Total": "2" }, []) } : { code: 1 })
    const gitlab = await new ForgeWorkItems({ run: viaGlab.run, fetcher: anywhere.fetcher }).list(hosted, { kind: "issue", query: "", page: 1 })
    assert.equal(gitlab.status === "ok" && gitlab.repository.provider, "gitlab")

    const noCli = cli(() => ({ code: "ENOENT" }))
    assert.deepEqual(await new ForgeWorkItems({ run: noCli.run, fetcher: anywhere.fetcher }).list(hosted, { kind: "issue", query: "", page: 1 }),
      { status: "unavailable", reason: "unsupported_host" })
    assert.deepEqual(await new ForgeWorkItems({ run: noCli.run, fetcher: anywhere.fetcher }).list(checkout({ origin: "https://127.0.0.1/team/app.git" }),
      { kind: "issue", query: "", page: 1 }), { status: "unavailable", reason: "unsupported_host" })
    assert.deepEqual(anywhere.urls, [], "no anonymous request reaches a host that is not a public forge")
    assert.deepEqual(await new ForgeWorkItems({ run: noCli.run }).list(checkout({ origin: "/srv/app.git" }), { kind: "issue", query: "", page: 1 }),
      { status: "unavailable", reason: "no_remote" })
  })

  it("keeps GitHub search words literal and publishes only this repository's items", async () => {
    assert.equal(literalSearchTerms('repo:cli/cli OR (label:"x") -is:pr NOT  crash'), '"repocli/cli" "labelx" "-ispr" "crash"')
    const directory = checkout({ origin: "https://github.com/o/r.git" })
    const foreign = gitHubIssue(9, { html_url: "https://github.com/cli/cli/issues/9" })
    const { run, calls } = cli(() => ({ stdout: included(200, {}, { total_count: 2, items: [gitHubIssue(1), foreign] }) }))
    const result = await new ForgeWorkItems({ run }).list(directory, { kind: "issue", query: "repo:cli/cli", page: 1 })
    assert.deepEqual(result.status === "ok" && result.items.map(item => item.number), [1])
    assert.match(decodeURIComponent(calls[0]!.args[4]!), /q=repo:o\/r is:issue is:open "repocli\/cli"&/)
  })

  it("bounds anonymous bodies while streaming and refuses a larger declared length unread", async () => {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1024 * 1024; controller.enqueue(new Uint8Array(1024 * 1024)) } })
    await assert.rejects(readBoundedText(new Response(stream), 4 * 1024 * 1024), /too large/)
    assert.ok(pulled <= 6 * 1024 * 1024, `stopped reading at ${pulled} bytes`)
    let read = false
    const declared = new Response(new ReadableStream({ pull() { read = true } }), { headers: { "Content-Length": String(10 * 1024 * 1024) } })
    await assert.rejects(readBoundedText(declared), /too large/)
    assert.equal(read, false)
  })

  it("shares identical reads, cancels them once no caller waits, and bounds concurrent forge requests host-wide", async () => {
    const directory = checkout({ origin: "https://github.com/o/r" })
    let running = 0, peak = 0
    const release: Array<() => void> = []
    const signals: AbortSignal[] = []
    const run: ProcessRunner = async (_command, args, signal) => {
      if (args[0] === "auth") return { stdout: "", stderr: "", code: 0 }
      signals.push(signal!)
      running += 1; peak = Math.max(peak, running)
      await new Promise<void>(resolve => { release.push(resolve); signal?.addEventListener("abort", () => resolve()) })
      running -= 1
      return signal?.aborted ? { stdout: "", stderr: "", code: "ABORT_ERR" } : { stdout: included(200, {}, { total_count: 0, items: [] }), stderr: "", code: 0 }
    }
    const forge = new ForgeWorkItems({ run })
    const callers = Array.from({ length: 12 }, () => new AbortController())
    const shared = callers.map(caller => forge.list(directory, { kind: "issue", query: "", page: 1, fresh: true }, caller.signal).catch(error => error))
    await until(() => signals.length > 0, "first shared read starts")
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(signals.length, 1, "identical fresh reads share one request")
    callers.slice(0, 11).forEach(caller => caller.abort())
    assert.equal(signals[0]!.aborted, false, "a remaining caller keeps the read")
    callers[11]!.abort()
    assert.equal(signals[0]!.aborted, true, "the last caller leaving cancels it")
    await Promise.all(shared)

    const distinct = Array.from({ length: 6 }, (_, page) => forge.list(directory, { kind: "issue", query: "", page: page + 1 }))
    await until(() => running === 4, `four run, got ${running}`)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(peak, 4)
    while (release.length) release.shift()!()
    await until(() => running === 2, "two queued run")
    while (release.length) release.shift()!()
    await Promise.all(distinct)
    assert.equal(peak, 4, "at most four forge requests run at once")
  })

  it("follows the forge's own continuation and never advertises a page past the 50th", async () => {
    const tea = cli(({ args }) => args[0] === "logins" ? { stdout: "[]" } : {})
    const capped = web(() => ({ status: 200, headers: { "X-Total-Count": "15", Link: '<https://codeberg.org/api/v1/x?page=2>; rel="next"' },
      body: Array.from({ length: 10 }, (_, index) => ({ number: index + 1, title: "t", state: "open", html_url: `https://codeberg.org/o/r/issues/${index + 1}`, updated_at: "u" })) }))
    const gitea = await new ForgeWorkItems({ run: tea.run, fetcher: capped.fetcher }).list(checkout({ origin: "https://codeberg.org/o/r" }), { kind: "issue", query: "", page: 1 })
    assert.equal(gitea.status === "ok" && gitea.hasMore, true, "a capped page size still continues")
    const glab = cli(() => ({ stdout: included(200, { "X-Total": "9999", "X-Next-Page": "51" }, []) }))
    const last = await new ForgeWorkItems({ run: glab.run }).list(checkout({ origin: "git@gitlab.com:g/p.git" }), { kind: "issue", query: "", page: 50 })
    assert.equal(last.status === "ok" && last.hasMore, false)
  })

  it("serves a page from a short cache unless the read is fresh, and never caches failures", async () => {
    const directory = checkout({ origin: "https://github.com/o/r" })
    let time = 0, fail = true
    const { run, calls } = cli(() => fail ? { code: 1, stderr: "boom" } : { stdout: included(200, {}, { total_count: 0, items: [] }) })
    const forge = new ForgeWorkItems({ run, now: () => time })
    const request = { kind: "issue" as const, query: "", page: 1 }
    await assert.rejects(forge.list(directory, request), /gh api failed/)
    fail = false
    await forge.list(directory, request)
    await forge.list(directory, request)
    time += 31_000
    await forge.list(directory, request)
    await forge.list(directory, { ...request, fresh: true })
    assert.equal(calls.length, 4)
  })
})
