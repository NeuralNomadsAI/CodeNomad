import assert from "node:assert/strict"
import { test } from "node:test"
import type { ForgeTransport } from "../forge/transport"
import { readMissionGithubSource } from "./mission-github-source"
import type { MissionGithubCondition } from "./mission-github-condition"

const AT = "2026-11-10T12:00:00.000Z", LATER = "2026-11-10T12:00:01.000Z", OLD = "2026-11-10T11:00:00.000Z"
const issue = (number: number, at: string, pull = false, author = "alice") => ({ number, created_at: at, title: `Item ${number}`,
  html_url: `https://github.com/acme/repo/${pull ? "pull" : "issues"}/${number}`, user: { login: author }, ...(pull ? { pull_request: {} } : {}) })
function fixture() {
  let values: unknown[] = [], account = 7
  let page: ((page: number) => unknown[]) | undefined
  const requests: string[] = []
  const transport: ForgeTransport = { access: "cli", request: async path => {
    requests.push(path)
    const index = Number(new URL(path, "https://api.github.com/").searchParams.get("page") ?? 1)
    return { status: 200, headers: new Map([["date", new Date(AT).toUTCString()]]),
      body: JSON.stringify(path === "user" ? { id: account } : page ? page(index) : index === 1 ? values : []) }
  } }
  return { transport, requests, rows: (items: unknown[]) => { values = items }, account: (id: number) => { account = id },
    pages: (read: (page: number) => unknown[]) => { page = read } }
}

for (const kind of ["github-issue", "github-pull-request"] as const) test(`${kind}: baseline, exact author, closed items and consumed events`, async () => {
  const f = fixture(), condition: MissionGithubCondition = { kind, repository: "acme/repo", author: "alice" }
  f.rows([issue(1, OLD)])
  const baseline = await readMissionGithubSource(condition, "/repo", undefined, undefined, f.transport)
  assert.equal(baseline.changed, false)
  f.rows([issue(4, LATER, kind === "github-pull-request", "bob"), issue(3, LATER, kind !== "github-pull-request"),
    { ...issue(2, LATER, kind === "github-pull-request"), state: "closed" }, issue(1, OLD)])
  const read = await readMissionGithubSource(condition, "/repo", baseline.checkpoint, undefined, f.transport)
  assert.equal(read.changed, true)
  assert.deepEqual((read.checkpoint.value as any).events.map((item: any) => item.id), ["2"])
  assert.ok(f.requests.some(path => path.includes("creator=alice") && path.includes("state=all")))
  const consumed = await readMissionGithubSource(condition, "/repo", read.checkpoint, undefined, f.transport)
  assert.equal(consumed.changed, false)
  assert.deepEqual((consumed.checkpoint.value as any).events, [])
})

test("notifications: same-second IDs, later thread updates, and no mark-as-read call", async () => {
  const f = fixture(), condition: MissionGithubCondition = { kind: "github-notification" }
  const notification = (id: string, updated_at: string) => ({ id, updated_at, repository: { full_name: "acme/repo" },
    subject: { title: `Notification ${id}`, url: "https://api.github.com/repos/acme/repo/issues/1" } })
  f.rows([notification("1", AT)])
  const baseline = await readMissionGithubSource(condition, "/repo", undefined, undefined, f.transport)
  f.rows([notification("2", AT), notification("1", AT)])
  const next = await readMissionGithubSource(condition, "/repo", baseline.checkpoint, undefined, f.transport)
  assert.deepEqual((next.checkpoint.value as any).events.map((item: any) => item.id), ["2"])
  f.rows([notification("1", LATER), notification("2", AT)])
  const updated = await readMissionGithubSource(condition, "/repo", next.checkpoint, undefined, f.transport)
  assert.deepEqual((updated.checkpoint.value as any).events.map((item: any) => item.id), ["1"])
  assert.equal(f.requests.filter(path => path.startsWith("notifications?")).length, 3, "one collection read per observation")
  assert.ok(f.requests.every(path => path === "user" || path.startsWith("notifications?all=") || path.startsWith("notifications?per_page=")))
  assert.ok(f.requests.filter(path => path.startsWith("notifications?")).every(path => new URL(path, "https://api.github.com").searchParams.get("all") === "true"))
})

test("security alerts keep resolved alerts and forward only bounded event metadata", async () => {
  const f = fixture(), condition: MissionGithubCondition = { kind: "github-security-alert", repository: "acme/repo" }
  const baseline = await readMissionGithubSource(condition, "/repo", undefined, undefined, f.transport)
  f.rows([{ number: 9, created_at: LATER, html_url: "https://github.com/acme/repo/security/dependabot/9", state: "fixed",
    security_advisory: { summary: "Fix package", details: "not copied" }, dependency: { package: { name: "pkg" } }, secret: "not copied" }])
  const read = await readMissionGithubSource(condition, "/repo", baseline.checkpoint, undefined, f.transport)
  assert.equal(read.changed, true)
  assert.equal((read.checkpoint.value as any).events[0].title, "Fix package")
  assert.doesNotMatch(JSON.stringify(read.checkpoint), /not copied/)
})

test("Dependabot pagination follows opaque after cursors and preserves its own filters", async () => {
  const f = fixture(), condition: MissionGithubCondition = { kind: "github-security-alert", repository: "acme/repo" }
  const baseline = await readMissionGithubSource(condition, "/repo", undefined, undefined, f.transport)
  const requests: URL[] = [], token = "Y3Vyc29yOjEyMzQ="
  const transport: ForgeTransport = { access: "cli", request: async path => {
    if (path === "user") return f.transport.request(path, new AbortController().signal)
    const url = new URL(path, "https://api.github.com/"); requests.push(url)
    const second = url.searchParams.has("after")
    return { status: 200, headers: new Map(second ? [] : [["link",
      `<https://api.github.com/repos/acme/repo/dependabot/alerts?after=${encodeURIComponent(token)}&state=open>; rel="next"`]]),
    body: JSON.stringify([{ number: second ? 1 : 2, created_at: LATER, security_advisory: { summary: "Package alert" },
      dependency: { package: { name: "pkg" } }, html_url: `https://github.com/acme/repo/security/dependabot/${second ? 1 : 2}` }]) }
  } }
  const read = await readMissionGithubSource(condition, "/repo", baseline.checkpoint, undefined, transport)
  assert.deepEqual((read.checkpoint.value as any).events.map((item: any) => item.id), ["1", "2"])
  assert.equal(requests.length, 2)
  assert.equal(requests[1].searchParams.get("after"), token)
  assert.ok(requests.every(url => !url.searchParams.has("page") && !url.searchParams.has("state")
    && url.searchParams.get("sort") === "created" && url.searchParams.get("direction") === "desc"))
})

test("account changes and wrong source placement cannot reuse a checkpoint", async () => {
  const f = fixture(), condition: MissionGithubCondition = { kind: "github-issue", repository: "acme/repo" }
  const read = await readMissionGithubSource(condition, "/repo", undefined, undefined, f.transport)
  await assert.rejects(readMissionGithubSource(condition, "/elsewhere", read.checkpoint, undefined, f.transport))
  f.account(8)
  await assert.rejects(read.revalidate())
  assert.throws(read.current)
  await assert.rejects(readMissionGithubSource(condition, "/repo", read.checkpoint, undefined, f.transport))
})

test("cancellation and failed credentials remain unavailable, not unchanged", async () => {
  const f = fixture(), condition: MissionGithubCondition = { kind: "github-notification" }
  const controller = new AbortController(); controller.abort(new Error("cancelled"))
  await assert.rejects(readMissionGithubSource(condition, "/repo", undefined, controller.signal, f.transport), /cancelled/)
  assert.deepEqual(f.requests, [])
  await assert.rejects(readMissionGithubSource(condition, "/repo", undefined, undefined, { access: "cli", request: async () => ({
    status: 403, headers: new Map(), body: "private-token-must-not-leak" }) }), error => {
    assert.doesNotMatch(String(error), /private-token/); return true
  })
})

test("foreign response URLs, unsorted pages and invalid selectors fail closed", async () => {
  const f = fixture(), condition: MissionGithubCondition = { kind: "github-issue", repository: "acme/repo" }
  f.rows([{ ...issue(1, LATER), html_url: "https://evil.example/issues/1" }])
  await assert.rejects(readMissionGithubSource(condition, "/repo", undefined, undefined, f.transport))
  f.rows([issue(1, OLD), issue(2, LATER)])
  await assert.rejects(readMissionGithubSource(condition, "/repo", undefined, undefined, f.transport))
  await assert.rejects(readMissionGithubSource({ ...condition, repository: "acme/../other" }, "/repo", undefined, undefined, f.transport))
})

test("an unconsumed page window over capacity never publishes a partial checkpoint", async () => {
  const f = fixture(), condition: MissionGithubCondition = { kind: "github-issue", repository: "acme/repo" }
  const baseline = await readMissionGithubSource(condition, "/repo", undefined, undefined, f.transport)
  f.requests.length = 0
  f.pages(page => Array.from({ length: 50 }, (_, index) => issue(1000 - (page - 1) * 50 - index, LATER)))
  await assert.rejects(readMissionGithubSource(condition, "/repo", baseline.checkpoint, undefined, f.transport), /capacity/)
  assert.equal(f.requests.filter(path => path.startsWith("repos/")).length, 4)
  assert.equal((baseline.checkpoint.value as any).at, AT)
})
