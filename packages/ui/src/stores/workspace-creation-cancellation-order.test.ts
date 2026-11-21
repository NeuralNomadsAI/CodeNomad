import assert from "node:assert/strict"
import { it } from "node:test"
import { createBackendClient, registerBackendClient } from "../lib/backend-client"
import { backendEvents } from "../lib/backend-events"
import { preferences } from "./preferences"
import { createInstance, instances, removeInstance, refreshWorkspaceList } from "./instances"

for (const mode of ["SSE", "list"] as const)
  for (const order of ["user-before-ACK", "user-response-after-ACK"])
    for (const reused of [false, true])
      for (const probe of ["metadata", "stop"]) it(`${mode} ${order} reused=${reused}: old cancellation preserves user ${probe}`, async t => {
        const prior = preferences().multiBackend
        preferences().multiBackend = true
        let requestId = "", finishPost!: () => void, enterPost!: () => void
        let finishCancel!: () => void, enterCancel!: () => void, finishUser!: () => void, enterUser!: () => void
        const post = new Promise<void>(r => { finishPost = r }), posted = new Promise<void>(r => { enterPost = r })
        const cancel = new Promise<void>(r => { finishCancel = r }), canceling = new Promise<void>(r => { enterCancel = r })
        const user = new Promise<void>(r => { finishUser = r }), userEntered = new Promise<void>(r => { enterUser = r })
        const backendId = `order-${mode}-${order}-${reused}-${probe}`
        const calls: string[] = []
        const client = createBackendClient({ id: backendId, baseUrl: "https://order.invalid", relayProfileId: backendId, bindRelayAuthority: true,
          fetcher: async (input, init) => {
            const path = new URL(String(input)).pathname
            if (init?.method !== "POST" && init?.method !== "DELETE") return Response.json([])
            calls.push(`${init.method} ${path}`)
            if (path.endsWith("/creation/cancel")) { enterCancel(); await cancel; return new Response(null, { status: 204 }) }
            const body = JSON.parse(String(init?.body))
            if (body.requestId) { requestId = body.requestId; enterPost(); await post }
            else { enterUser(); await user }
            return Response.json({ id: "w", requestId: body.requestId, path: body.path,
              binaryLabel: body.requestId ? "restore-binary" : "user-binary", reused: !body.requestId ? reused : false,
              status: "starting", proxyPath: "", createdAt: "", updatedAt: "" })
          } })
        client.admitRelayAuthority!("o".repeat(43))
        const unregister = registerBackendClient(client), detach = backendEvents.attach(client.id, client.events), id = `${backendId}~w`
        t.after(() => {
          finishPost(); finishCancel(); finishUser(); detach(); unregister(); client.events.dispose()
          preferences().multiBackend = prior; removeInstance(id, { authoritative: false })
        })
        const controller = new AbortController()
        const rejected = assert.rejects(createInstance("/same", undefined, { backend: client, signal: controller.signal }))
        await posted; controller.abort(); await canceling
        const opened = createInstance("/same", undefined, { backend: client }); await userEntered
        if (order === "user-before-ACK") { finishUser(); await opened; assert.equal(instances().get(id)?.binaryLabel, "user-binary") }
        finishCancel(); await new Promise<void>(r => setImmediate(r))
        const old = { id: "w", requestId, path: "/same", status: "starting" as const, proxyPath: "", createdAt: "", updatedAt: "", binaryId: "test", binaryLabel: "restore-binary" }
        const observe = async (descriptor: typeof old & { reused?: boolean }) => {
          if (mode === "SSE") (client.events as any).dispatch({ type: "workspace.created", workspace: descriptor })
          else await refreshWorkspaceList(backendId, { fetchWorkspaces: async () => [descriptor] })
        }
        await observe(old)
        if (order === "user-response-after-ACK") { finishUser(); await opened }
        finishPost(); await rejected
        await observe(old); await observe(old)
        assert.equal(instances().get(id)?.binaryLabel, "user-binary", "old descriptor must not replace the user occurrence")
        if (probe === "metadata") {
          await observe({ ...old, requestId: undefined as any, binaryLabel: "updated-user-binary", reused })
          assert.equal(instances().get(id)?.binaryLabel, "updated-user-binary", "old cancellation must not block user metadata")
        } else {
          ;(client.events as any).dispatch({ type: "workspace.stopped", workspaceId: "w", reason: "deleted" })
          await new Promise<void>(r => setImmediate(r))
          assert.equal(instances().has(id), false, "authoritative user stop must not be ignored")
        }
        const route = `/api/backends/${backendId}/api/workspaces`
        assert.deepEqual(calls, [`POST ${route}`, `POST ${route}/creation/cancel`, `POST ${route}`])
      })
