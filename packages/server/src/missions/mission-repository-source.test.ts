import assert from "node:assert/strict"
import { test, after } from "node:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ForgeWorkItems } from "../forge/work-items"
import { forgeWebUrl } from "../forge/providers"
import type { ForgeResponse, ForgeTransport } from "../forge/transport"
import { readMissionRepositorySource } from "./mission-repository-source"
import { missionRepositoryConditionSchema, missionRepositoryCheckpointSchema, repositoryEvents, type MissionRepositoryCondition } from "./mission-repository-condition"
import { missionLaunchPolicySchema } from "./launch-policy"
import { missionSourceKey } from "./mission-document"

const BEFORE = "2026-11-11T10:00:00.000Z", AT = "2026-11-11T11:00:00.000Z", LATER = "2026-11-11T12:00:00.000Z"
function fixture(provider: MissionRepositoryCondition["provider"], event: MissionRepositoryCondition["event"]) {
  const condition: MissionRepositoryCondition = { kind: "repository-activity", provider, host: provider === "github" ? "github.com" : provider === "gitlab" ? "gitlab.com" : "codeberg.org",
    repository: provider === "gitlab" ? "group/sub/project" : "acme/repo", event, author: "alice" }
  const requests: string[] = []
  let account = 7, date = AT, status = 200, remote = condition.repository
  let page = (_page: number): { rows: unknown[]; headers?: [string, string][] } => ({ rows: [] })
  const transport: ForgeTransport = { access: "cli", request: async path => {
    requests.push(path)
    const values = page(Number(new URL(path, "https://fixture/").searchParams.get("page") ?? 1))
    return { status: path === "user" && account === 0 ? 401 : status, headers: new Map([["date", new Date(date).toUTCString()], ...values.headers ?? []]),
      body: JSON.stringify(path === "user" ? { id: account } : values.rows) }
  } }
  const forge = { openRepository: async () => ({ status: "ok" as const, repository: { provider, host: condition.host, path: remote,
    access: "cli" as const, webUrl: `https://${condition.host}/${remote}` }, transport }) }
  const row = (id: number, at: string, author = "alice", merged = event === "pull-request-merged", updated = at) => {
    const issue = event === "issue-created", url = forgeWebUrl(provider, condition.host, condition.repository, issue ? "issue" : "pullRequest", id)
    const common = { title: `Item ${id}`, created_at: merged ? BEFORE : at, updated_at: updated, state: merged ? "closed" : "open" }
    if (provider === "gitlab") return { ...common, iid: id, web_url: url, author: { username: author }, merged_at: merged ? at : null }
    if (provider === "github") return { ...common, number: id, html_url: url, user: { login: author },
      ...(!issue ? { pull_request: { merged_at: merged ? at : null } } : {}) }
    return { ...common, number: id, html_url: url, user: { login: author }, merged, merged_at: merged ? at : null }
  }
  return { condition, requests, transport, forge, row, date: (value: string) => { date = value }, account: (value: number) => { account = value },
    remote: (value: string) => { remote = value }, status: (value: number) => { status = value },
    pages: (value: typeof page) => { page = value }, read: (previous?: Parameters<typeof readMissionRepositorySource>[2], signal?: AbortSignal) =>
      readMissionRepositorySource(condition, "/root", previous, signal, forge) }
}
const events = (read: Awaited<ReturnType<typeof readMissionRepositorySource>>) => missionRepositoryCheckpointSchema.parse(read.checkpoint.value).events

for (const provider of ["github", "gitlab", "gitea"] as const) for (const event of repositoryEvents)
  test(`${provider} ${event}: baseline, author, historical merged work, ties, retry and consumption`, async () => {
    const f = fixture(provider, event)
    f.pages(() => ({ rows: [f.row(1, AT)] }))
    const baseline = await f.read()
    assert.equal(baseline.changed, false); assert.deepEqual(events(baseline), [])
    f.date(LATER)
    f.pages(() => ({ rows: [f.row(4, LATER, "bob"), f.row(3, LATER), f.row(2, AT), f.row(1, AT)] }))
    const read = await f.read(baseline.checkpoint)
    assert.equal(read.changed, true); assert.deepEqual(events(read).map(row => row.id), ["2", "3"])
    assert.deepEqual(events(await f.read(baseline.checkpoint)), events(read), "failed passages keep their unconsumed window")
    assert.deepEqual(events(await f.read(read.checkpoint)), [])
    assert.equal(read.checkpoint.key, missionSourceKey(f.condition))
    assert.deepEqual(missionLaunchPolicySchema.parse({ when: [f.condition] }), { when: [f.condition] })
    const request = new URL(f.requests.find(value => value !== "user")!, "https://fixture/")
    assert.equal(request.searchParams.get("state"), provider === "gitlab" && event === "pull-request-merged" ? "merged" : "all")
    if (provider === "gitlab") { assert.match(request.pathname, /group%2Fsub%2Fproject/); assert.equal(request.searchParams.get("scope"), "all") }
  })

test("merged requests are keyed by merge time, not creation or later comments", async () => {
  const f = fixture("gitlab", "pull-request-merged"), baseline = await f.read()
  f.date(LATER)
  f.pages(() => ({ rows: [f.row(2, LATER), f.row(3, BEFORE, "alice", true, LATER)] }))
  assert.deepEqual(events(await f.read(baseline.checkpoint)).map(row => row.id), ["2"])
})

test("GitLab merge windows use merge time across pages even when updates precede merges or change order", async () => {
  const f = fixture("gitlab", "pull-request-merged"), baseline = await f.read()
  f.date("2026-11-11T16:00:00.000Z")
  const mergedAt = "2026-11-11T15:21:03.414Z", updatedAt = "2026-11-11T15:21:00.567Z"
  // Timestamp pair observed on gitlab-org/gitlab!269974.
  f.pages(page => ({ rows: page === 1 ? [f.row(269974, mergedAt, "alice", true, updatedAt)]
    : [f.row(2, "2026-11-11T12:30:00.000Z", "alice", true, BEFORE)],
    headers: [["x-next-page", page === 1 ? "2" : ""]] }))
  const read = await f.read(baseline.checkpoint)
  assert.deepEqual(events(read).map(row => row.id), ["2", "269974"])
  for (const path of f.requests.filter(path => path.includes("merged_after="))) {
    const query = new URL(path, "https://fixture/").searchParams
    assert.equal(query.get("order_by"), "merged_at"); assert.equal(query.get("state"), "merged")
    assert.equal(query.has("updated_after"), false)
    assert.equal(query.get("merged_after"), "2026-11-11T10:59:59.000Z")
  }
  assert.equal(f.requests.filter(path => path.includes("merged_after=")).length, 2)
  f.pages(() => ({ rows: [f.row(1, BEFORE), f.row(2, LATER)] }))
  await assert.rejects(f.read(baseline.checkpoint), /capacity/, "ignored merge ordering leaves coverage unavailable")
})

test("complete pages, short capped pages, and unordered Gitea issues keep the whole window", async () => {
  for (const provider of ["github", "gitlab", "gitea"] as const) {
    const f = fixture(provider, "issue-created"), baseline = await f.read(); f.date(LATER)
    f.pages(page => ({ rows: page === 1 ? [f.row(1, BEFORE)] : [f.row(2, LATER)], headers: [["link", page === 1 ? '<https://foreign.invalid/ignored>; rel="next"' : ""]] }))
    if (provider === "gitea") assert.deepEqual(events(await f.read(baseline.checkpoint)).map(row => row.id), ["2"], "unordered collections must exhaust pagination")
    else assert.deepEqual(events(await f.read(baseline.checkpoint)), [], "sorted old tail closes the window")
  }
  const f = fixture("gitea", "issue-created"), baseline = await f.read(); f.date(LATER)
  f.pages(page => ({ rows: [f.row(page, LATER)], headers: [["x-total-count", "2"]] }))
  assert.deepEqual(events(await f.read(baseline.checkpoint)).map(row => row.id), ["1", "2"])
  f.pages(page => ({ rows: page === 1 ? [f.row(1, LATER), f.row(2, LATER)] : [f.row(3, LATER)], headers: [["x-total-count", "3"]] }))
  assert.deepEqual(events(await f.read(baseline.checkpoint)).map(row => row.id), ["1", "2", "3"], "a shorter final page keeps its complete total")
})

test("remote, account, authorization, placement and cancellation changes refuse stale authority", async () => {
  const f = fixture("github", "pull-request-merged"), baseline = await f.read()
  f.remote("other/repo"); await assert.rejects(baseline.revalidate()); assert.throws(baseline.current)
  await assert.rejects(f.read(baseline.checkpoint))
  f.remote(f.condition.repository); f.account(8); await assert.rejects(f.read(baseline.checkpoint))
  f.account(7); f.status(403); await assert.rejects(f.read(baseline.checkpoint))
  f.status(200)
  await assert.rejects(readMissionRepositorySource(f.condition, "/elsewhere", baseline.checkpoint, undefined, f.forge))
  const controller = new AbortController(); controller.abort(new Error("cancelled"))
  const count = f.requests.length; await assert.rejects(f.read(undefined, controller.signal), /cancelled/); assert.equal(f.requests.length, count)
})

test("public anonymous observation stays read-only and cannot reuse a signed-in checkpoint", async () => {
  const f = fixture("gitea", "issue-created")
  f.transport.access = "anonymous"; f.account(0)
  const baseline = await f.read(); f.date(LATER); f.pages(() => ({ rows: [f.row(1, LATER)] }))
  assert.equal((await f.read(baseline.checkpoint)).changed, true)
  f.transport.access = "cli"; f.account(7)
  await assert.rejects(f.read(baseline.checkpoint))
})

test("malformed, duplicate, unsorted, foreign and over-capacity pages never publish partial events", async () => {
  const f = fixture("github", "pull-request-created"), baseline = await f.read(); f.date(LATER)
  for (const rows of [[{}], [f.row(1, LATER), f.row(1, LATER)], [f.row(1, BEFORE), f.row(2, LATER)],
    [{ ...f.row(1, LATER), html_url: "https://evil.invalid/acme/repo/pull/1" }]]) {
    f.pages(() => ({ rows })); await assert.rejects(f.read(baseline.checkpoint))
  }
  f.pages(page => ({ rows: Array.from({ length: 50 }, (_, index) => f.row(page * 50 + index, LATER)) }))
  await assert.rejects(f.read(baseline.checkpoint), /capacity/)
  assert.equal(missionRepositoryCheckpointSchema.parse(baseline.checkpoint.value).at, AT)
  for (const patch of [{ host: "github.com/evil" }, { host: "user@github.com" }, { repository: "a/../b" }, { author: "alice OR bob" }])
    assert.equal(missionRepositoryConditionSchema.safeParse({ ...f.condition, ...patch }).success, false)
})

const roots: string[] = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
test("Missions uses Contribute's upstream detection, CLI host selection and transport for all three forges", async () => {
  for (const provider of ["github", "gitlab", "gitea"] as const) {
    const f = fixture(provider, "pull-request-merged"), root = mkdtempSync(path.join(tmpdir(), "mission-forge-")); roots.push(root)
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { windowsHide: true })
    git("init", "-q"); git("remote", "add", "origin", "https://github.com/fork/elsewhere.git")
    git("remote", "add", "upstream", `https://${f.condition.host}/${f.condition.repository}.git`)
    const calls: string[] = []
    const forge = new ForgeWorkItems({ run: async (command, args, signal) => {
      calls.push(command)
      if (command === "tea" && args[0] === "logins") return { code: 0, stderr: "", stdout: JSON.stringify([{ name: "work", url: `https://${f.condition.host}` }]) }
      const response: ForgeResponse = await f.transport.request(args.at(-1)!.replace(/^\//, ""), signal!)
      const headers = `HTTP/1.1 ${response.status} OK\r\nDate: ${response.headers.get("date")}\r\n\r\n`
      return { code: 0, stdout: command === "tea" ? response.body : headers + response.body, stderr: command === "tea" ? headers : "" }
    } })
    const read = await readMissionRepositorySource(f.condition, root, undefined, undefined, forge)
    assert.equal(read.changed, false)
    assert.ok(calls.includes(provider === "github" ? "gh" : provider === "gitlab" ? "glab" : "tea"))
    git("remote", "set-url", "upstream", "https://github.com/different/project.git")
    await assert.rejects(read.revalidate()); assert.throws(read.current)
  }
})
