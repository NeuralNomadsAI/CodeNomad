import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { once } from "node:events"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import test from "node:test"
import pino from "pino"
import { CodeNomadServerCredentials } from "../codenomad-servers/credentials"
import { RemoteServerBrowseManager } from "../codenomad-servers/browse-manager"
import { RELAY_AUTHORITY_HEADER as AUTHORITY, RELAY_AUTHORITY_QUERY as QUERY, RELAY_BOOTSTRAP } from "../codenomad-servers/relay-authority"
import { startFakeCodeNomad } from "../codenomad-servers/test-support/fake-codenomad"
import { resolveConfigLocation } from "../config/location"
import { SettingsService } from "../settings/service"
import { resolveHttpsOptions } from "../server/tls"
import { SERVER_PAIR_PATH } from "./server-pairing"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "./test-support/surface"
import { assertSentinelsHidden, sentinelForms, sentinelForward } from "./test-support/sentinel-forward"

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string }
type Options = { method?: string; headers?: Record<string, string>; body?: unknown }

test("sentinel scanner catches every encoding in a populated capture", () => {
  // UTF-8 bytes force both base64 alphabets and padding; whitespace/backslash force URL/JSON transforms.
  const secret = 'password/token/proof? \\"࿿'
  const b64 = Buffer.from(secret).toString("base64")
  const url = b64.replaceAll("+", "-").replaceAll("/", "_")
  let count = 0
  for (const value of [secret, b64, b64.replace(/=+$/, ""), url, url.replace(/=+$/, "")]) {
    for (const encoded of [value, encodeURIComponent(value), new URLSearchParams({ value }).toString().slice(6)]) {
      for (const form of [encoded, JSON.stringify(encoded).slice(1, -1)]) {
        assert.throws(() => assertSentinelsHidden(`captured:${form}:end`, [secret], "counterexample"), /exposed sentinel/)
        count++
      }
    }
  }
  assert.equal(count, 30)
  assert.equal(sentinelForms(secret).length, 30)
  assertSentinelsHidden("ordinary populated capture", [secret], "clean")
})

// Real sockets on both sides, including TLS termination before the direct listener.
function send(base: string, target: string, options: Options = {}, ca?: string): Promise<Reply> {
  const url = new URL(target, base)
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: options.method ?? "GET", ca, path: target,
      headers: { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
    }, response => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", chunk => { body += chunk })
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }))
    })
    request.on("error", reject)
    request.end(options.body === undefined ? undefined : JSON.stringify(options.body))
  })
}

for (const viaSsh of [false, true]) for (const channel of ["RC", "HTTPS", "LAN"] as const) {
  test(`security sentinel matrix: ${channel} ${viaSsh ? "SSH-forward" : "direct"} admitted A/B, failures, carriers, state and real pino logs`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-sentinels-"))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    let logs = ""
    const logger = pino({ level: "trace" }, { write(chunk: string) { logs += chunk } })
    const tls = resolveHttpsOptions({ enabled: true, configDir: directory, host: "localhost",
      tlsSANs: "127.0.0.1,sentinel-ui.test", logger })!
    const ca = fs.readFileSync(tls.caCertPath!, "utf8")
    const previous = getCACertificates()
    setDefaultCACertificates([...previous, ca])
    t.after(() => setDefaultCACertificates(previous))
    const password = "stored-password-SENTINEL-7dbdf138"
    const device = "paired-device-SENTINEL-27dfe752"
    const pairingToken = "pairing_SENTINEL_8a527c2adfc635d"
    const pairedCredential = `paired_SENTINEL_${"d".repeat(27)}`
    const wrongPassword = "rejected-password-SENTINEL-6a8f2851"
    const memoryTitle = "memory-title-SENTINEL-19ac76a4"
    const memoryText = "memory-content-SENTINEL-847aa4e1"
    const memoryDirectory = "/memory-directory-SENTINEL-b2d592ec"
    const sshPath = path.join(directory, ".ssh", "id-SENTINEL-89b3c0a2")
    const sshKey = "SSH-PRIVATE-CONTENTS-SENTINEL-fb27610c"
    fs.mkdirSync(path.dirname(sshPath))
    fs.writeFileSync(sshPath, sshKey)
    fs.writeFileSync(path.join(directory, ".ssh", "config"),
      `Host fixture-host\n  HostName 192.0.2.90\n  IdentityFile "${sshPath}"\n`)
    t.mock.method(os, "homedir", () => directory)
    const hidden = [password, wrongPassword, device, pairingToken, pairedCredential, sshPath, sshPath.replaceAll("\\", "/"), sshKey,
      // Check both entire PEMs and their unique base64 payload, including JSON-escaped PEMs.
      ...[tls.httpsOptions.key.toString(), tls.httpsOptions.cert.toString(), ca,
        fs.readFileSync(path.join(directory, "tls", "ca-key.pem"), "utf8")]
        .flatMap(pem => [pem, pem.split(/\r?\n/).filter(line => line && !line.startsWith("-----")).join("")]) ]
    const assertHidden = (value: unknown, label: string, extra: string[] = []) => {
      assertSentinelsHidden(value, [...hidden, ...extra], label)
    }
    const remotes = await Promise.all(["A", "B"].map(async id => {
      const remote = await startFakeCodeNomad({ password, anonymous: id === "B", tls: tls.httpsOptions })
      remote.state.overrides.set("/api/meta", { status: 200, body: { serverId: id, apiContract: 1 } })
      remote.state.overrides.set("/api/workspaces", { status: 200,
        body: [{ id: "same-workspace", server: id }],
        headers: { "set-cookie": `private=${device}`, authorization: `Bearer ${password}`,
          location: `https://blocked.test/?password=${password}`, "x-private-key": sshKey } })
      remote.state.overrides.set("/api/memory/settings", { status: 200, body: { enabled: true } })
      remote.state.overrides.set("/api/memory", { status: 200, body: {
        entries: [{ id: "same-entry", sessionId: "same-session", title: memoryTitle, text: `${id}:${memoryText}` }],
      }, headers: { "set-cookie": `private=${device}`, authorization: `Bearer ${password}`,
        location: `https://blocked.test/?password=${password}`, "x-private-key": sshKey } })
      remote.state.overrides.set("/api/failure", { status: 503, body: { error: "controlled" },
        headers: { location: `https://blocked.test/?token=${device}`, "set-cookie": `private=${device}` } })
      remote.state.overrides.set("/api/redirect", { status: 302, body: { redirect: true },
        headers: { location: `https://blocked.test/?password=${password}` } })
      return remote
    }))
    t.after(async () => { await Promise.all(remotes.map(remote => remote.close())) })
    remotes[1]!.state.overrides.set(SERVER_PAIR_PATH, { status: 200, body: {
      credential: pairedCredential,
      device: { id: "12345678-1234-4123-8123-123456789012", name: "CodeNomad sentinel",
        createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() },
    } })
    const location = resolveConfigLocation(directory)
    fs.writeFileSync(location.configYamlPath, "ui:\n  settings:\n    multiBackend: true\n")
    fs.writeFileSync(location.stateYamlPath, JSON.stringify({ ui: { remoteServers: remotes.map((remote, i) =>
      ({ id: i ? "B" : "A", baseUrl: remote.origin, skipTlsVerify: false,
        ...(viaSsh ? { ssh: { host: `fixture-${i ? "B" : "A"}` } } : {}) })), recentFolders: [] } }))
    const credentials = new CodeNomadServerCredentials(path.join(directory, "remote-server-credentials.json"))
    credentials.set("A", viaSsh ? `ssh:fixture-A|${remotes[0]!.origin}` : remotes[0]!.origin,
      { kind: "password", username: "codenomad", password })
    credentials.set("B", viaSsh ? `ssh:fixture-B|${remotes[1]!.origin}` : remotes[1]!.origin,
      { kind: "device", cookie: `__Host-codenomad_device=${device}` })
    const settings = new SettingsService(location, undefined, logger)
    const forward = sentinelForward(t, remotes.map(remote => remote.origin), sshPath, sshKey)
    if (viaSsh) {
      // Listener managers share this SettingsService's connection state. Prime only
      // the injected process boundary; every browser operation below uses real routes.
      const owner = new RemoteServerBrowseManager(settings, forward.open)
      t.after(() => owner.close())
      for (const id of ["A", "B"]) await owner.connect(id, {})
    }
    const publicOrigin = channel === "RC" ? `https://${FAKE_TUNNEL_HOST}`
      : channel === "HTTPS" ? "https://sentinel-ui.test" : "http://sentinel-lan.test"
    const surface = await startRemoteSurface(t, { settings, logger, bindHost: "0.0.0.0",
      allowedOrigins: [publicOrigin] })
    hidden.push(surface.code)
    let base = `http://${surface.local}`
    let cookie: string
    if (channel === "RC") {
      base = `http://${surface.target()}`
      const paired = await send(base, "/api/remote-control/pair", { method: "POST",
        headers: { host: FAKE_TUNNEL_HOST, origin: publicOrigin }, body: { code: surface.code } })
      assert.equal(paired.status, 200, paired.body)
      cookie = String(paired.headers["set-cookie"]).split(";")[0]!
      // This is the caller's own authorized pairing response, not a stored remote identity.
      assertHidden(paired, "pair response")
    } else {
      cookie = `codenomad_session=${surface.authManager.createSession("codenomad").id}`
      if (channel === "HTTPS") {
        const backend = base
        const proxy = https.createServer(tls.httpsOptions, (request, response) => {
          const upstream = http.request(backend, { path: request.url, method: request.method, headers: request.headers }, reply => {
            response.writeHead(reply.statusCode!, reply.headers); reply.pipe(response)
          })
          upstream.on("error", error => response.destroy(error))
          request.pipe(upstream)
        })
        proxy.listen(0, "127.0.0.1")
        await once(proxy, "listening")
        t.after(async () => { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())) })
        base = `https://localhost:${(proxy.address() as { port: number }).port}`
      } else {
        const lan = Object.values(os.networkInterfaces()).flat().find(address => address?.family === "IPv4" && !address.internal)
        assert.ok(lan, "a real non-loopback interface is required; never silently substitute injection")
        base = `http://${lan.address}:${new URL(base).port}`
      }
    }
    const replies: Reply[] = []
    const urls: string[] = []
    const proofs: string[] = []
    const network: Array<{ target: string; method: string; headers: Record<string, string>; body?: unknown }> = []
    hidden.push(cookie.split("=")[1]!)
    const call = async (target: string, options: Options = {}) => {
      urls.push(target)
      const headers = { cookie, origin: publicOrigin, host: new URL(publicOrigin).host, ...options.headers }
      network.push({ target, method: options.method ?? "GET", headers, body: options.body })
      const reply = await send(base, target, { ...options, headers }, ca)
      replies.push(reply)
      assertHidden(reply, target)
      return reply
    }
    assert.equal((await call("/api/remote-servers/ssh-hosts")).status, 200)
    if (channel === "HTTPS" && !viaSsh) {
      const post = (action: string, body = {}) => call(`/api/remote-servers/A/${action}`, { method: "POST", body })
      assert.equal((await post("forget")).status, 200)
      const missing = await post("browse")
      assert.equal(missing.status, 409, missing.body)
      assert.equal(JSON.parse(missing.body).error, "needs_credentials")
      assert.equal((await post("connect", { username: "codenomad", password })).status, 200)
      assert.equal((await post("browse")).status, 200)
    }
    // Establish stored connections before testing new-secret entry, including LAN
    // refusal: a forbidden submission must leave both existing identities usable.
    for (const id of ["A", "B"]) {
      assert.equal((await call(`/api/remote-servers/${id}/connect`, { method: "POST", body: {} })).status, 200)
    }
    const requestsBeforeEntry = remotes.map(remote => remote.state.requests.length)
    const passwordEntry = await call("/api/remote-servers/A/connect", { method: "POST",
      body: { username: "codenomad", password } })
    const pairingEntry = await call("/api/remote-servers/B/connect", { method: "POST",
      body: { pairingLink: `${remotes[1]!.origin}/remote-pair#${pairingToken}` } })
    if (channel === "LAN") {
      for (const reply of [passwordEntry, pairingEntry]) {
        assert.equal(reply.status, 403, reply.body)
        assert.equal(JSON.parse(reply.body).error, "secret_entry_forbidden")
      }
      assert.deepEqual(remotes.map(remote => remote.state.requests.length), requestsBeforeEntry)
    } else {
      for (const reply of [passwordEntry, pairingEntry]) assert.equal(reply.status, 200, reply.body)
      const login = remotes[0]!.state.requests.slice(requestsBeforeEntry[0])
        .find(request => request.path === "/api/auth/login")
      assert.ok(login, "new password actually submitted upstream")
      assert.equal(JSON.parse(login.body).password, password)
      const exchange = remotes[1]!.state.requests.slice(requestsBeforeEntry[1])
        .find(request => request.path === SERVER_PAIR_PATH)
      assert.ok(exchange, "pairing code actually exchanged upstream")
      assert.equal(JSON.parse(exchange.body).code, pairingToken)
      assert.equal(exchange.headers["x-codenomad-server-pairing"], "1")
      for (const name of ["cookie", "authorization", "origin", "referer", "sec-fetch-site", "sec-fetch-mode"]) {
        assert.equal(exchange.headers[name], undefined, `private pairing exchange: ${name}`)
      }
      assert.ok(remotes[1]!.state.requests.some(request => request.path === "/api/auth/status"
        && request.headers.cookie === `__Host-codenomad_device=${pairedCredential}`),
      "pairing result authenticated privately before success")
      assert.equal(fs.readFileSync(path.join(directory, "remote-server-credentials.json"), "utf8").includes(pairingToken), false)
    }
    const beforeRefusals = remotes.map(remote => remote.state.requests.length)
    const passwordRefusal = await call("/api/remote-servers/A/connect", { method: "POST",
      body: { username: "codenomad", password: wrongPassword } })
    remotes[1]!.state.overrides.set(SERVER_PAIR_PATH, { status: 401, body: { credential: pairedCredential } })
    const pairingRefusal = await call("/api/remote-servers/B/connect", { method: "POST",
      body: { pairingLink: `${remotes[1]!.origin}/remote-pair#${pairingToken}` } })
    for (const [reply, error] of [[passwordRefusal, "auth"], [pairingRefusal, "pairing_expired"]] as const) {
      assert.equal(reply.status, channel === "LAN" ? 403 : 409, reply.body)
      assert.equal(JSON.parse(reply.body).error, channel === "LAN" ? "secret_entry_forbidden" : error)
    }
    if (channel === "LAN") assert.deepEqual(remotes.map(remote => remote.state.requests.length), beforeRefusals)
    else assert.ok(remotes[0]!.state.requests.slice(beforeRefusals[0])
      .some(request => request.path === "/api/auth/login" && JSON.parse(request.body).password === wrongPassword),
    "remote password refusal actually exercised")
    for (const id of ["A", "B"]) {
      for (const action of ["connect", "browse"]) {
        const reply = await call(`/api/remote-servers/${id}/${action}`, { method: "POST", body: {} })
        assert.equal(reply.status, 200, reply.body)
      }
      const bootstrap = await call(`/api/backends/${id}/api/meta`, { headers: { [AUTHORITY]: RELAY_BOOTSTRAP } })
      assert.equal(bootstrap.status, 200, bootstrap.body)
      const proof = String(bootstrap.headers[AUTHORITY])
      assert.match(proof, /^[A-Za-z0-9_-]{43}$/)
      proofs.push(proof)
      const rejectedTarget = await call(`/api/backends/${id}/api/workspaces?${QUERY}=${proof}#fragment`)
      assert.ok([400, 403].includes(rejectedTarget.status), rejectedTarget.body)
      // Proof is deliberately client-visible only in its authorized carrier.
      const workspaces = await call(`/api/backends/${id}/api/workspaces?${QUERY}=${proof}&view=sentinel`,
        { headers: { authorization: "Bearer caller-only-SENTINEL" } })
      assert.equal(workspaces.status, 200, workspaces.body)
      assert.equal(JSON.parse(workspaces.body)[0].server, id)
      assert.equal(workspaces.headers.location, undefined)
      assert.equal(workspaces.headers["set-cookie"], undefined)
      const remote = remotes[id === "A" ? 0 : 1]!
      const memoryStart = remote.state.requests.length
      const memorySettings = await call(`/api/backends/${id}/api/memory/settings`, { headers: { [AUTHORITY]: proof } })
      assert.equal(memorySettings.status, 200, memorySettings.body)
      assert.equal((await call(`/api/backends/${id}/api/memory/settings`, {
        method: "PUT", headers: { [AUTHORITY]: proof }, body: { enabled: true },
      })).status, 200)
      const memory = await call(`/api/backends/${id}/api/memory`, {
        method: "POST", headers: { [AUTHORITY]: proof, authorization: "Bearer caller-only-SENTINEL" },
        body: { operation: { action: "list", scope: "project" },
          context: { workspaceId: "same-workspace", directory: memoryDirectory } },
      })
      assert.equal(memory.status, 200, memory.body)
      assert.equal(JSON.parse(memory.body).entries[0].text, `${id}:${memoryText}`)
      assert.equal(memory.headers["set-cookie"], undefined)
      assert.equal(memory.headers.authorization, undefined)
      assert.equal(memory.headers.location, undefined)
      assert.equal(memory.headers["x-private-key"], undefined)
      assert.equal(remote.state.requests.slice(memoryStart).filter(request => request.path.startsWith("/api/memory")).length, 3)
      for (const [target, status] of [["failure", 503], ["redirect", 302]] as const) {
        remote.state.overrides.set("/api/workspaces", remote.state.overrides.get(`/api/${target}`)!)
        const reply = await call(`/api/backends/${id}/api/workspaces`, { headers: { [AUTHORITY]: proof } })
        assert.equal(reply.status, status === 302 ? 502 : status, reply.body)
        assert.equal(reply.headers.location, undefined)
      }
      const before = remotes.reduce((n, remote) => n + remote.state.requests.length, 0)
      const malformed = await call(`/api/backends/${id}/api/workspaces?${QUERY}=malformed`)
      assert.equal(malformed.status, 502)
      assert.equal(remotes.reduce((n, remote) => n + remote.state.requests.length, 0), before)
      assert.equal((await call(`/api/remote-servers/${id}/forget`, { method: "POST", body: {} })).status, 200)
      assert.equal((await call(`/api/backends/${id}/api/workspaces`, { headers: { [AUTHORITY]: proof } })).status, 502)
    }
    assert.equal((await call("/api/storage/state/ui")).status, 200)
    assert.equal((await call("/api/storage/state")).status, 200)
    for (const baseUrl of [`https://user:${password}@invalid.test`, `https://invalid.test/remote-pair#${pairingToken}`]) {
      const reply = await call("/api/remote-servers/probe", { method: "POST", body: { baseUrl } })
      assert.ok(reply.status >= 400 || JSON.parse(reply.body).ok === false, reply.body)
    }
    let malformedPaths = 0
    const malformedReplies: Reply[] = []
    for (const proof of proofs) for (const form of new Set(sentinelForms(proof))) {
      for (const prefix of ["/api/backends/%", "/api/backends;ignored", "/api/%2562ackends", "/api/remote-servers;ignored"]) {
        // Deliberately hostile inbound targets; exclude them from the app's permitted outbound carrier catalog.
        const reply = await send(base, `${prefix}/${encodeURIComponent(form)}/connect?opaque=${encodeURIComponent(form)}`,
          { headers: { cookie, origin: publicOrigin, host: new URL(publicOrigin).host } }, ca)
        assert.ok(reply.status >= 400, "malformed/denied target stays refused")
        malformedReplies.push(reply)
        malformedPaths++
      }
    }
    for (const [index, reply] of replies.entries()) {
      const { [AUTHORITY]: carrier, ...headers } = reply.headers
      if (carrier !== undefined) {
        assert.ok(proofs.includes(String(carrier)), "only issued proof in the authorized header")
        assert.match(network[index]!.target, /^\/api\/backends\/[AB]\/api\/meta$/)
        assert.equal(network[index]!.headers[AUTHORITY], RELAY_BOOTSTRAP)
      }
      assertHidden({ body: reply.body, headers }, "non-carrier response", proofs)
    }
    for (const target of urls) {
      const url = new URL(target, "http://client.invalid")
      const carrier = url.searchParams.get(QUERY)
      if (carrier) assert.ok(carrier === "malformed" || proofs.includes(carrier))
      url.searchParams.delete(QUERY)
      assertHidden(url.href, "non-carrier client URL", proofs)
    }
    assertHidden(fs.readFileSync(location.stateYamlPath, "utf8"), "persisted client state", proofs)
    assertHidden(settings.getDoc("state"), "client state snapshot", proofs)
    assertSentinelsHidden(settings.getDoc("state"), [memoryTitle, memoryText, memoryDirectory], "memory stays out of client state")
    assertHidden(urls, "client-visible URLs")
    for (const request of network) {
      const url = new URL(request.target, "http://client.invalid")
      const headers = { ...request.headers }
      assert.equal(headers.cookie, cookie, "exact admitted browser authentication carrier")
      delete headers.cookie
      const carrier = headers[AUTHORITY]
      if (carrier !== undefined) {
        assert.ok(carrier === RELAY_BOOTSTRAP || proofs.includes(carrier), "exact outbound header carrier")
        delete headers[AUTHORITY]
      }
      const query = url.searchParams.get(QUERY)
      if (query !== null) {
        assert.deepEqual(url.searchParams.getAll(QUERY), [query])
        assert.ok(query === "malformed" || proofs.includes(query), "exact outbound query carrier")
        url.searchParams.delete(QUERY)
      }
      let body = request.body
      if (request.method === "POST" && /^\/api\/remote-servers\/[AB]\/connect$/.test(url.pathname)) {
        const { password: submittedPassword, pairingLink, ...rest } = (body ?? {}) as Record<string, unknown>
        if (submittedPassword !== undefined) assert.ok(submittedPassword === password || submittedPassword === wrongPassword)
        if (pairingLink !== undefined) assert.equal(pairingLink, `${remotes[1]!.origin}/remote-pair#${pairingToken}`)
        body = rest
      } else if (url.pathname === "/api/remote-servers/probe") {
        assert.ok([`https://user:${password}@invalid.test`, `https://invalid.test/remote-pair#${pairingToken}`]
          .includes((body as { baseUrl: string }).baseUrl))
        body = {}
      }
      assertHidden({ target: url.href, headers, body }, "captured non-carrier outgoing request", proofs)
    }
    for (const reply of replies) {
      const headers = { ...reply.headers }
      delete headers[AUTHORITY]
      assertHidden({ body: reply.body, headers }, "non-carrier replies", proofs)
    }
    for (const remote of remotes) for (const request of remote.state.requests) {
      assert.equal(request.path.includes(QUERY), false)
      assert.equal(request.headers[AUTHORITY], undefined)
      assert.equal(JSON.stringify(request).includes("caller-only-SENTINEL"), false)
      assertHidden({ path: request.path, authority: request.headers[AUTHORITY] }, "upstream proof stripping", proofs)
      const headers = { ...request.headers }
      // These exact private authentication carriers are the upstream contract.
      if (headers.cookie) {
        headers.cookie = headers.cookie.split(/;\s*/).filter(part => {
          if (part.includes(device)) {
            assert.ok(part === `__Host-codenomad_device=${device}` || part === `private=${device}`)
            return false
          }
          if (part.includes(pairedCredential)) {
            assert.equal(part, `__Host-codenomad_device=${pairedCredential}`)
            return false
          }
          return true
        }).join("; ")
      }
      let body = request.body
      if (request.path === "/api/auth/login") {
        const parsed = JSON.parse(body)
        assert.ok(parsed.password === password || parsed.password === wrongPassword)
        const { password: _, ...rest } = parsed
        body = JSON.stringify(rest)
      } else if (request.path === SERVER_PAIR_PATH) {
        const { code, ...rest } = JSON.parse(body)
        assert.equal(code, pairingToken)
        body = JSON.stringify(rest)
      }
      assertHidden({ ...request, headers, body }, "captured non-carrier upstream request", proofs)
    }
    assert.ok(remotes[0]!.state.logins > 0, "stored password actually used")
    assert.ok(remotes[1]!.state.requests.some(request => request.headers.cookie?.includes(device)), "stored device actually used")
    assert.deepEqual(forward.opened, viaSsh ? ["fixture-A", "fixture-B"] : [])
    assert.ok(logs.split("\n").some(line => line && JSON.parse(line).msg), "real pino emitted records")
    assertHidden(logs, "real application logs", [...proofs, surface.code, cookie.split("=")[1]!, memoryTitle, memoryText, memoryDirectory])
    t.diagnostic(`${channel}/${viaSsh ? "injected TCP-forward" : "direct"}: ${replies.length} replies, ${network.length} client requests, ${remotes.reduce((n, remote) => n + remote.state.requests.length, 0)} upstream requests; ${malformedPaths} malformed-path probes; ${hidden.length} secrets + ${proofs.length} proofs; 30 encoding slots each; response bodies/headers, client URL/header/body, upstream URL/header/body, persisted state/snapshot, trace pino`)
    for (const reply of malformedReplies) assertHidden(reply, "malformed-path response", proofs)
  })
}
