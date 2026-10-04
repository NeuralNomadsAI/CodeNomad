// Test-only durable native plugin, compiled privately; not a product entrypoint.
import { randomUUID } from "node:crypto"
import { setupMissionsPlugin } from "../../packages/server/src/opencode/missions-plugin.ts"
import { runMissionExclusive } from "../../packages/server/src/missions/exclusive.ts"
import { stableToken } from "../../packages/server/src/missions/journal.ts"
import { authenticate, canonical, digest, POLICY, RPC } from "./protocol.mjs"

const namespaceKey = "authority-spike/v1/namespace"
const grantKey = missionID => `authority-spike/v1/grant/${missionID}`
const captures = globalThis[Symbol.for("authority-spike.captured")] ??= new Map()

export function authorityPlugin(trust) {
  return { id: "codenomad.missions", async setup(ctx) {
    const namespace = await runMissionExclusive("authority-spike:namespace", async () => {
      let value = await ctx.storage.get(namespaceKey)
      if (!value) { value = randomUUID(); await ctx.storage.set(namespaceKey, value) }
      return value
    })
    let original
    const proxy = { ...ctx, rpc: { register: async (definition, handlers) => {
      original = handlers
      // Preserve typed snapshot/cleanup read contract; ALL legacy human mutators fail closed.
      return ctx.rpc.register(definition, Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name,
        ["snapshot", "cleanupTarget"].includes(name)
          ? handler : async () => { throw new Error("Signed authority required; legacy writer rejected") }])))
    } } }
    const snapshot = () => original.snapshot({})
    const mutationScope = `mutation:${stableToken(`${ctx.location.project.id}\0${ctx.location.project.canonical}`, 24)}`
    const transport = async (coordinatorID, kind, input) => {
      const missionID = input.missionID ?? input.metadata?.["codenomad.mission"]?.missionID
      const grant = await ctx.storage.get(grantKey(missionID))
      if (!grant || (kind !== "lifecycle" && grant.state !== "active")) throw new Error("Continuity authority unavailable")
      const response = await fetch(trust.bridge, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${trust.token}` },
        body: JSON.stringify({ coordinatorID, kind, input, grant }), signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error("Private authority admission rejected")
      return response.json()
    }
    const dispose = await setupMissionsPlugin(proxy, {
      prompt: (coordinatorID, input) => transport(coordinatorID, "prompt", input),
      synthetic: (coordinatorID, input) => transport(coordinatorID, "synthetic", input),
      lifecycle: (coordinatorID, input) => transport(coordinatorID, "lifecycle", input),
    })
    const hook = await ctx.session.hook("http.request", event => {
      event.request.headers.set("x-authority-kind", event.kind)
      event.request.headers.set("x-authority-session", event.sessionID)
    })
    const registration = await ctx.rpc.register(RPC, {
      challenge: async input => ({ nonce: input.nonce, namespace, policy: POLICY,
        projectID: ctx.location.project.id, projectCanonical: ctx.location.project.canonical,
        directory: ctx.location.directory, sessionMethods: Object.keys(ctx.session),
        tools: (await ctx.tool.list()).map(t => t.id), grants: (await ctx.storage.scan({ prefix: "authority-spike/v1/grant/", limit: 100 })).entries.map(e => e.value) }),
      privileged: async (input, invocation) => {
        const body = authenticate(input, trust.publicKey)
        if (body.namespace !== namespace || body.profileID !== trust.profileID || body.authorityID !== trust.authorityID || body.executionHost !== trust.executionHost
          || body.projectID !== ctx.location.project.id || body.projectCanonical !== ctx.location.project.canonical
          || canonical(body.roots) !== canonical([ctx.location.directory])) throw new Error("Authority binding rejected")
        // Separate lock from MissionControl's project lock; avoids callback deadlock.
        return runMissionExclusive(`authority-spike:privileged:${body.projectID}`, async () => {
          const ledgerKey = `authority-spike/v1/request/${body.requestID}`
          const prior = await ctx.storage.get(ledgerKey)
          if (prior && prior.digest !== digest(body)) throw new Error("Authority request conflict")
          const current = body.missionID ? (await snapshot()).missions.find(m => m.id === body.missionID) : undefined
          const grant = body.missionID ? await ctx.storage.get(grantKey(body.missionID)) : undefined
          if (prior && body.method !== "lifecycle") return body.method === "adopt" ? { grant } : prior.result
          if (body.method !== "create" && (!current || current.coordinatorSessionId !== body.payload.coordinatorID)) throw new Error("Authoritative mission mismatch")
          let result
          if (body.method === "create") {
            if (body.missionID !== null || body.expectedRevision !== 0 || body.payload.requestID !== body.requestID || body.payload.prepared !== true) throw new Error("Creation binding rejected")
            result = await original.create(body.payload, invocation)
          } else if (body.method === "adopt") {
            if (current.status !== "active" || current.revision !== body.expectedRevision || current.control?.pending.length
              || body.epoch !== (grant?.epoch ?? 0) + 1) throw new Error("Adoption state rejected")
            for (const actor of current.actors) {
              const session = await ctx.session.get({ sessionID: actor.sessionId })
              if (session.parentID || session.projectID !== body.projectID || session.location.directory !== body.roots[0]
                || actor.location.directory !== body.roots[0]) throw new Error("Exact actor root rejected")
            }
            const saved = { version: 1, state: "active", authorityID: body.authorityID, profileID: body.profileID, executionHost: body.executionHost,
              epoch: body.epoch, namespace, projectID: body.projectID, projectCanonical: body.projectCanonical,
              roots: body.roots, missionID: current.id, coordinatorID: current.coordinatorSessionId }
            await runMissionExclusive(mutationScope, async () => {
              const fresh = (await snapshot()).missions.find(m => m.id === current.id)
              if (!fresh || fresh.revision !== body.expectedRevision || fresh.status !== "active" || fresh.control?.pending.length) throw new Error("Adoption changed during admission")
              await ctx.storage.set(grantKey(current.id), saved)
            })
            result = { grant: saved }
          } else {
            if (!grant || grant.epoch !== body.epoch || (grant.state !== "active" && !(body.method === "lifecycle" && body.payload.action === "stop"))) throw new Error("Grant epoch revoked")
            if (body.method === "revoke") {
              if (current.revision !== body.expectedRevision) throw new Error("Revocation revision rejected")
              await runMissionExclusive(mutationScope, () => ctx.storage.set(grantKey(current.id), { ...grant, state: "revoked" }))
              result = { revoked: true }
            } else if (body.method === "lifecycle") {
              const { coordinatorID, ...payload } = body.payload
              if (payload.missionID !== body.missionID || payload.expectedRevision !== body.expectedRevision || payload.requestID !== body.requestID) throw new Error("Lifecycle binding rejected")
              if (payload.action === "stop") await runMissionExclusive(mutationScope, () => ctx.storage.set(grantKey(current.id), { ...grant, state: "revoked" }))
              result = await original.lifecycle(payload, invocation)
            } else {
              // Private signed test driver only, NOT a proposed shipped RPC/tool API.
              const tool = body.method === "invoke-captured" ? captures.get(body.payload.captureID)
                : (await ctx.tool.list()).find(t => t.id === `mission_${body.payload.tool}`)
              if (!tool) throw new Error("Fixture tool unavailable")
              if (body.method === "capture") { captures.set(body.payload.captureID, tool); result = { captured: true } }
              else {
                const actor = current.actors.find(a => a.sessionId === body.payload.sessionID)
                if (!actor || actor.location.directory !== body.roots[0]) throw new Error("Fixture caller rejected")
                result = JSON.parse((await tool.execute(body.payload.input, { sessionID: actor.sessionId, messageID: "msg_authority_fixture",
                  id: body.requestID, progress: async () => {}, signal: invocation.signal })).content)
              }
            }
          }
          // Errors from the original declared lifecycle context are not success receipts.
          if (result instanceof Error) return result
          await ctx.storage.set(ledgerKey, { digest: digest(body), result })
          return result
        })
      },
    })
    return async () => { await dispose(); await hook.dispose(); await registration.dispose() }
  } }
}
