// Fixture-only trusted construction + read/checkpoint diagnostics. No generic
// action driver and no private signing key. Qualification here is INJECTED, not
// evidence of managed distribution, human authentication or host provisioning.
import { createPublicKey, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { setupDurableMissionsPlugin } from "../../packages/server/src/opencode/missions/durable-plugin.ts"
import { authoritySignerDigest, canonicalAuthority, MISSION_AUTHORITY_POLICY, MissionAuthorityError } from "../../packages/server/src/missions/authority-protocol.ts"
import { FIXTURE_RPC } from "./schema.mjs"
const captures = globalThis[Symbol.for("private.missions.durable.native.captures")] ??= []
const namespaceKey = "codenomad-missions/authority-v2/namespace"
const physical = directory => {
  const value = realpathSync(directory)
  return process.platform === "win32" ? value.toLowerCase() : value
}

export function fixturePlugin(options) {
  const publicKey = createPublicKey(options.publicKey)
  return { id: "codenomad.missions", async setup(ctx) {
    let active = true, trustedNamespace, currentSigner, productWrites = 0
    const checkpoints = new Map()
    const registrations = []
    const assertActive = () => { if (!active) throw new MissionAuthorityError("authorization-blocked") }
    const root = { mode: "git", directory: ctx.location.directory, family: options.familyID, checkout: options.checkoutID }
    const host = {
      assertManagedIncarnation() { assertActive(); return true }, // Explicit private injection, never a product approval.
      async readSigners() {
        assertActive()
        const namespace = await ctx.storage.get(namespaceKey)
        if (typeof namespace !== "string" || !/^[a-f0-9-]{36}$/i.test(namespace)) throw new MissionAuthorityError("storage-invalid")
        trustedNamespace ??= namespace
        if (namespace !== trustedNamespace) throw new MissionAuthorityError("namespace-mismatch")
        currentSigner = { authorityID: options.authorityID, keyID: options.keyID, profileID: options.profileID,
          executionHost: options.executionHost, namespace, projectID: ctx.location.project.id,
          projectCanonical: ctx.location.project.canonical, roots: [root], publicKey,
          provisioningGeneration: options.generation, policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" }
        return [currentSigner]
      },
      assertSignerCurrent(snapshot) {
        assertActive()
        if (!currentSigner || snapshot.signerDigest !== authoritySignerDigest(publicKey)
          || !["authorityID", "keyID", "profileID", "executionHost", "namespace", "projectID", "projectCanonical", "provisioningGeneration", "policy", "qualification"]
            .every(key => snapshot[key] === currentSigner[key])
          || canonicalAuthority(snapshot.roots) !== canonicalAuthority(currentSigner.roots)) throw new MissionAuthorityError("untrusted-signer")
        return true
      },
      async resolveRoot(location) {
        assertActive()
        if (location.workspaceID !== undefined || location.directory !== root.directory
          || physical(location.directory) !== options.physicalProject) throw new MissionAuthorityError("binding-mismatch")
        return { ...root }
      },
      transport: { async execute(request, invocation) {
        assertActive(); invocation.signal.throwIfAborted()
        await invocation.assertCurrent()
        const id = randomUUID()
        checkpoints.set(id, invocation.assertCurrent)
        try {
          const response = await fetch(options.bridge, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
            body: JSON.stringify({ ...request, checkpointID: id }), signal: invocation.signal })
          if (!response.ok) throw new MissionAuthorityError("effect-unavailable")
          return await response.json()
        } finally { checkpoints.delete(id) }
      } },
    }
    // Capture only a genuine native inspect invocation, not a caller-selected
    // session/tool/input. A later narrow probe tests that same disposed closure.
    const instrumented = { ...ctx,
      storage: { ...ctx.storage, set: async (...args) => { productWrites++; return ctx.storage.set(...args) } },
      tool: { ...ctx.tool, transform: callback => ctx.tool.transform(draft => callback({
      ...draft, namespace: value => draft.namespace(value), add: tool => draft.add({ ...tool, execute: async (input, invocation) => {
        if (tool.name === "inspect") captures.push({ execute: tool.execute, input, invocation })
        return tool.execute(input, invocation)
      } }),
    })) } }
    let disposeProduct
    try {
      disposeProduct = await setupDurableMissionsPlugin(instrumented, host)
      registrations.push(await ctx.session.hook("http.request", event => {
        event.request.headers.set("x-authority-kind", event.kind)
        event.request.headers.set("x-authority-session", event.sessionID)
      }))
      const authorize = input => { assertActive(); if (input.token !== options.token) throw new Error("Private fixture access denied") }
      registrations.push(await ctx.rpc.register(FIXTURE_RPC, {
        capabilities: async input => { authorize(input); return { directory: ctx.location.directory, projectID: ctx.location.project.id,
          projectCanonical: ctx.location.project.canonical, sessionMethods: Object.keys(ctx.session), tools: (await ctx.tool.list()).map(tool => tool.id),
          policy: MISSION_AUTHORITY_POLICY, captures: captures.length, productWrites, namespace: await ctx.storage.get(namespaceKey) } },
        checkpoint: async input => { authorize(input); const callback = checkpoints.get(input.id); if (!callback) throw new Error("Unknown private checkpoint"); await callback(); return { current: true } },
        staleInspector: async input => {
          authorize(input)
          const captured = captures[0]
          if (!captured) throw new Error("No real native inspector invocation captured")
          try { await captured.execute(captured.input, captured.invocation) }
          catch (error) {
            if (!/no longer available|authorization-blocked/.test(error.message)) throw new Error("Unexpected captured inspector failure")
            return { rejected: true, diagnostic: "disposed native inspector" }
          }
          throw new Error("Disposed native inspector executed")
        },
        damageAuthority: async input => { authorize(input); await ctx.storage.set(namespaceKey, "damaged-private-namespace"); return { damaged: true } },
      }))
      return async () => { active = false; await disposeProduct(); await Promise.allSettled(registrations.map(value => value.dispose())); checkpoints.clear() }
    } catch (error) { active = false; await disposeProduct?.(); await Promise.allSettled(registrations.map(value => value.dispose())); throw error }
  } }
}
