// Fake OpenCode integration (dev-docs/OPENCODE_INTEGRATIONS.md, Test fixtures): the native RPC contract of
// opencode-integrations spec draft 0.2 with an injectable clock and hello probe. Dependency-free, because
// writeFakeIntegrationPackage copies this file into the plugin package the fixture daemon loads; tests may
// also call it in process.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import net from "node:net"

export const OFFER_LEASE_MS = 15_000
export const MAX_OFFERS = 16
export const HELLO_TIMEOUT_MS = 2_000
export const FAKE_INTEGRATION_VERSION = "0.1.0"
export const FAKE_INTEGRATION_PACKAGE = "@neuralnomads/opencode-fixture"

/** A native marker for `id` (default `fixture`); its host part range is fixed at ^0.1.0. */
export function fakeIntegrationMarker(id = "fixture") {
  return {
    spec: 0, id, displayName: `OpenCode for ${id[0].toUpperCase()}${id.slice(1)}`, family: "native",
    plugin: `neuralnomads.${id}`, rpc: `neuralnomads.${id}`,
    host: { app: id, protocol: 1, range: "^0.1.0", appVersions: ">=1.0", payload: `host/${id}/${id}-host-0.1.0.zip`, sha256: "0".repeat(64) },
  }
}

// status.output bounds `attachedSessions`.
export const MAX_BINDINGS = 10_000

const TOKEN = /^[0-9a-f]{64}$/
const OFFER_KEY = /^[A-Za-z0-9._:-]{1,64}$/
const OFFER_ID = /^[A-Za-z0-9_-]{8,64}$/
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const DISPLAY = /^[^/\\\p{Cc}]+$/u
const HANDLE = /^[^\p{Cc}]+$/u
const length = value => [...value].length
const isText = (value, expression, max) => typeof value === "string" && expression.test(value) && length(value) <= max
const isInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max
const isObject = value => typeof value === "object" && value !== null && !Array.isArray(value)
const hasOnly = (value, keys) => Object.keys(value).every(key => keys.includes(key))

// advertise.input of rpc.schema.json, checked by the plugin itself (RPC-8).
function parseAdvertise(input) {
  if (!isObject(input) || !hasOnly(input, ["host", "port", "token", "script_handle", "label", "protocol", "offer_key"])) return null
  const valid = input.host === "127.0.0.1" && isInteger(input.port, 1, 65_535) && isText(input.token, TOKEN, 64)
    && isText(input.script_handle, HANDLE, 200) && isText(input.label, DISPLAY, 120) && isInteger(input.protocol, 1, 1000)
    && isText(input.offer_key, OFFER_KEY, 64)
  return valid ? input : null
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

// Whether display text mentions the token, the offer key, the script handle or the port (HST-11).
function revealsSecret(text, input) {
  return [input.token, input.offer_key, input.script_handle].some(secret => text.includes(secret))
    || new RegExp(`(^|\\D)${input.port}(\\D|$)`).test(text)
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  return JSON.stringify(value)
}
export const capabilityHash = capabilities => createHash("sha256").update(canonicalJson(capabilities)).digest("hex")

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
const METHOD = /^[a-z][a-z0-9_.]{0,63}$/
const isNames = (value, max) => Array.isArray(value) && value.length <= max && value.every(name => isText(name, METHOD, 64))

// hello of host.schema.json: an answer outside it is refused (HST-11).
function isHello(value) {
  if (!isObject(value) || !isObject(value.capabilities)) return false
  const { capabilities } = value
  return isInteger(value.protocol, 1, 1000) && isText(value.host_version, SEMVER, 64) && isText(value.app_version, DISPLAY, 64)
    && hasOnly(capabilities, ["methods", "operations", "undo", "background"]) && isNames(capabilities.methods, 512)
    && new Set(capabilities.methods).size === capabilities.methods.length
    && Array.isArray(capabilities.operations) && capabilities.operations.length <= 512 && capabilities.operations.every(operation =>
      isObject(operation) && hasOnly(operation, ["name", "undoable", "network"]) && isText(operation.name, METHOD, 64)
      && typeof operation.undoable === "boolean" && (operation.network === undefined || typeof operation.network === "boolean"))
    && ["transactional", "grouped_best_effort", "none"].includes(capabilities.undo) && typeof capabilities.background === "boolean"
    && isText(value.capability_hash, TOKEN, 64) && isText(value.script_handle, HANDLE, 200) && isInteger(value.revision, 0, Number.MAX_SAFE_INTEGER)
    && (value.document === undefined || isText(value.document, DISPLAY, 120))
}

const versionParts = value => (String(value).match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/) ?? []).slice(1).map(part => Number(part ?? 0))
const compare = (a, b) => a.map((part, index) => part - b[index]).find(delta => delta !== 0) ?? 0

// HST-3 for the fake's own marker: protocol equal, application >=1.0, host part in ^0.1.0 (>=0.1.0 <0.2.0-0, so a
// prerelease of 0.1.0 is outdated and any 0.2.0 prerelease is incompatible).
function compatibility(hello) {
  if (!versionParts(hello.app_version).length || versionParts(hello.app_version)[0] < 1) return "incompatible"
  const part = versionParts(hello.host_version)
  const toLower = compare(part, [0, 1, 0])
  if (toLower < 0 || (toLower === 0 && SEMVER.exec(hello.host_version)[4])) return "outdated"
  return compare(part, [0, 2, 0]) >= 0 ? "incompatible" : "ok"
}

/** One request line, one response line to a loopback host (spec/host-handshake.md). */
export function requestHost({ port, token }, method, params = {}, timeoutMs = HELLO_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    let buffer = ""
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Host timeout")) }, timeoutMs)
    const finish = (error, value) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value) }
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: "fixture", token, method, params })}\n`))
    socket.on("data", chunk => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, newline))
        if (response?.ok === true) finish(null, response.result)
        else finish(Object.assign(new Error("Host error"), { code: response?.error?.code }))
      } catch (error) { finish(error) }
    })
    socket.on("error", error => finish(error))
  })
}

/** The offer registry of HST-11 to HST-16. `now` is the injectable clock; `hello` replaces the TCP probe. */
export function createOfferRegistry({ protocol = 1, now = Date.now, hello = endpoint => requestHost(endpoint, "hello"), newOfferID } = {}) {
  const offers = new Map(), bindings = new Map(), listeners = new Set()
  const serviceGeneration = globalThis[Symbol.for("codenomad.fake-integration.serviceGeneration")] ??= randomBytes(16).toString("base64url")
  const registryGeneration = randomBytes(16).toString("base64url")
  let revision = 0
  const mint = newOfferID ?? (() => `offer_${randomBytes(12).toString("base64url")}`)
  const emit = () => { revision++; for (const listener of listeners) { listener("hosts"); listener("status") } }
  const remove = offerID => {
    offers.delete(offerID)
    for (const [sessionID, bound] of bindings) if (bound === offerID) bindings.delete(sessionID)
  }
  const sweep = () => {
    let changed = false
    for (const offer of [...offers.values()]) if (now() >= offer.expiresAt) { remove(offer.offerID); changed = true }
    if (changed) emit()
  }
  const byKey = key => [...offers.values()].find(offer => offer.key === key)
  const validHello = (value, input) => isHello(value) && value.protocol === protocol && value.script_handle === input.script_handle
    && value.capability_hash === capabilityHash(value.capabilities)
  const display = (value, input, max) => typeof value === "string" && isText(value, DISPLAY, max) && !revealsSecret(value, input) ? value : undefined

  return {
    async advertise(raw) {
      sweep()
      const input = parseAdvertise(raw)
      if (!input || input.protocol !== protocol || revealsSecret(input.label, input)) return { outcome: "refused" }
      const existing = byKey(input.offer_key)
      if (existing && sameSecret(existing.token, input.token) && existing.port === input.port && existing.scriptHandle === input.script_handle) {
        existing.expiresAt = now() + OFFER_LEASE_MS
        return { outcome: "renewed" }
      }
      if (!existing && offers.size >= MAX_OFFERS) return { outcome: "refused" }
      let answer
      try { answer = await hello({ host: input.host, port: input.port, token: input.token }) } catch { return { outcome: "refused" } }
      if (!validHello(answer, input)) return { outcome: "refused" }
      // Other announcements may have landed during the hello: recheck the key and the cap.
      sweep()
      const current = byKey(input.offer_key)
      if (!current && offers.size >= MAX_OFFERS) return { outcome: "refused" }
      if (current) remove(current.offerID)
      const offerID = mint()
      offers.set(offerID, { offerID, key: input.offer_key, token: input.token, port: input.port, scriptHandle: input.script_handle,
        label: input.label, document: display(answer.document, input, 120), appVersion: display(answer.app_version, input, 64),
        hostVersion: answer.host_version, compatibility: compatibility(answer), expiresAt: now() + OFFER_LEASE_MS })
      emit()
      return { outcome: "accepted" }
    },
    withdraw(raw) {
      if (!isObject(raw) || !hasOnly(raw, ["offer_key", "token"]) || !isText(raw.offer_key, OFFER_KEY, 64) || !isText(raw.token, TOKEN, 64)) return { outcome: "none" }
      const offer = byKey(raw.offer_key)
      if (!offer || !sameSecret(offer.token, raw.token)) return { outcome: "none" }
      remove(offer.offerID)
      emit()
      return { outcome: "withdrawn" }
    },
    hosts() {
      sweep()
      return { offers: [...offers.values()].map(offer => ({ offerID: offer.offerID, label: offer.label,
        ...(offer.document ? { document: offer.document } : {}), ...(offer.appVersion ? { appVersion: offer.appVersion } : {}),
        protocol: offer.compatibility === "incompatible" ? "incompatible" : "ok" })) }
    },
    attach(offerID, sessionID) {
      sweep()
      if (!isText(sessionID, SESSION_ID, 128)) return { outcome: "refused" }
      const offer = isText(offerID, OFFER_ID, 64) ? offers.get(offerID) : undefined
      if (!offer) return { outcome: "gone" }
      if (offer.compatibility === "incompatible") return { outcome: "refused" }
      const bound = bindings.get(sessionID)
      if (bound && bound !== offerID && offers.has(bound)) return { outcome: "busy" }
      if (!bound && bindings.size >= MAX_BINDINGS) return { outcome: "refused" }
      bindings.set(sessionID, offerID)
      if (bound !== offerID) revision++
      for (const listener of listeners) listener("status")
      return { outcome: "attached" }
    },
    detach(sessionID) {
      if (!isText(sessionID, SESSION_ID, 128) || !bindings.delete(sessionID)) return { outcome: "none" }
      revision++
      for (const listener of listeners) listener("status")
      return { outcome: "detached" }
    },
    /** The bound offer's display fields, as a tool of the attached session would see them. */
    binding(sessionID) {
      sweep()
      const offer = offers.get(bindings.get(sessionID))
      return offer ? { offerID: offer.offerID, label: offer.label } : null
    },
    bindingRead(input) {
      if (!isObject(input) || !hasOnly(input, ["sessionID"]) || typeof input.sessionID !== "string"
        || !/^[A-Za-z0-9_-]{1,128}$(?![\s\S])/.test(input.sessionID)) return { state: "unknown" }
      sweep()
      const offer = offers.get(bindings.get(input.sessionID))
      const authority = { serviceGeneration, registryGeneration, revision }
      return offer ? { state: "attached", authority, binding: { offerID: offer.offerID, label: offer.label } } : { state: "none", authority }
    },
    liveHellos() { sweep(); return [...offers.values()].map(offer => ({ compatibility: offer.compatibility, hostVersion: offer.hostVersion, appVersion: offer.appVersion })) },
    counts() { sweep(); return { offers: offers.size, attachedSessions: bindings.size } },
    sweep,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
}

/** The daemon-wide registry of HST-12, shared by every Location of the process, on the real clock and hello
 * probe; tests that move time use createOfferRegistry. */
export function sharedOfferRegistry(marker) {
  const key = Symbol.for(`${marker.rpc}.offers`)
  return globalThis[key] ??= createOfferRegistry({ protocol: marker.host.protocol })
}

const SEVERITY = { incompatible: 2, outdated: 1, ok: 0 }

/**
 * RPC handlers of a native integration. `markerMismatch` makes `status` report another integration ID than the
 * marker (a non-conforming package); `hostPart` is the read-only inspection result without a live hello.
 */
export function createFakeIntegrationRpc({ marker, version = FAKE_INTEGRATION_VERSION, registry, markerMismatch = false,
  hostPart = "absent", installOutcome = "installed", calls = [] }) {
  let part = hostPart
  const hostStatus = () => {
    const live = registry.liveHellos()
    if (live.length) {
      const worst = live.reduce((a, b) => SEVERITY[b.compatibility] > SEVERITY[a.compatibility] ? b : a)
      return { state: worst.compatibility, partVersion: worst.hostVersion, expectedRange: marker.host.range,
        ...(worst.appVersion ? { appVersion: worst.appVersion } : {}), ...(worst.compatibility === "outdated" ? { action: "update" } : {}) }
    }
    return part === "absent" ? { state: "absent", expectedRange: marker.host.range, action: "install" } : { state: "unknown", expectedRange: marker.host.range }
  }
  const handlers = {
    status: async () => {
      const { offers, attachedSessions } = registry.counts()
      return {
        contract: 1,
        integration: { id: markerMismatch ? `${marker.id}-other` : marker.id, version, family: marker.family, spec: marker.spec },
        host: hostStatus(),
        connection: { state: attachedSessions > 0 ? "attached" : offers > 0 ? "available" : "none", offers, attachedSessions },
      }
    },
    installHost: async () => {
      calls.push("installHost")
      if (installOutcome === "installed" || installOutcome === "updated") part = "installed"
      return { outcome: installOutcome }
    },
    hosts: async () => registry.hosts(),
    // OpenCode enforces no pattern in the registered definitions: the registry checks both IDs.
    attachHost: async input => registry.attach(input?.offerID, input?.sessionID),
    detachHost: async input => registry.detach(input?.sessionID),
    bindingRead: async input => registry.bindingRead(input),
    advertise: input => registry.advertise(input),
    withdraw: async input => registry.withdraw(input),
  }
  // Relays registry changes as payload-free events; returns the cleanup.
  const connect = (registration, sweepIntervalMs = 1_000) => {
    const unsubscribe = registry.onChange(change => {
      void registration.events.emit(change === "hosts" ? "hosts_changed" : "status_changed", {}).catch(() => {})
    })
    const timer = setInterval(() => registry.sweep(), sweepIntervalMs)
    timer.unref?.()
    return () => { unsubscribe(); clearInterval(timer) }
  }
  return { handlers, connect }
}
