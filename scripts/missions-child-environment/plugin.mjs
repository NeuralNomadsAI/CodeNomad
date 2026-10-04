import { CHILD_ENV_RPC } from "./schema.mjs"
import { readFile } from "node:fs/promises"

// Private plugin construction only. No product flags, presence-owned dispatch,
// invented session.create(parentID), child prompt, client-side environment values
// or runner. The identity-only backend seam performs the actual environment write.
export function childEnvironmentPlugin(token, seedFile) {
  return { id: "private.missions.child.environment", async setup(ctx) {
    const portable = value => {
      const serialized = JSON.stringify(value)
      return serialized === undefined ? null : JSON.parse(serialized)
    }
    let active = true
    const registrations = []
    const assertActive = () => { if (!active) throw new Error("Private child wrapper disposed") }
    const key = (parentID, callID) => `invocation/${parentID}/${callID}`
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const checkOwner = (owner, invocation) => {
      for (const field of ["parentID", "executionID", "taskKey", "contractRequestID"]) {
        if (owner[field] !== invocation[field]) throw new Error("Immutable child owner mismatch")
      }
    }
    registrations.push(await ctx.session.hook("prompt", async event => {
      const requestID = event.metadata?.["private.child.environment"]?.rootRequestID
      if (requestID) {
        if (event.messageID !== requestID) throw new Error("Actual root admission identity mismatch")
        await ctx.storage.set(`root-request/${event.sessionID}`, { rootRequestID: requestID })
      }
    }))
    registrations.push(await ctx.session.hook("context", async event => {
      const binding = await ctx.storage.get(`current-binding/${event.sessionID}`)
      const session = await ctx.session.get({ sessionID: event.sessionID })
      if (session.parentID && (!binding || binding.parentID !== session.parentID || binding.childID !== session.id)) {
        throw new Error("Native child model context requires structured binding")
      }
      if (session.parentID) {
        const receipt = await ctx.storage.get(`model-admission/${session.id}`)
        if (receipt?.callID !== binding.callID) throw new Error("Native child model context requires completed environment admission")
      }
      if (binding) event.system.push({ type: "text", text: "CHILD_ENV_BINDING:" + JSON.stringify(binding) })
    }))
    registrations.push(await ctx.session.hook("http.request", async event => {
      event.request.headers.set("x-authority-session", event.sessionID)
      event.request.headers.set("x-authority-kind", event.kind)
      const binding = await ctx.storage.get(`current-binding/${event.sessionID}`)
      if (binding) event.request.headers.set("x-child-call", binding.callID)
    }))
    registrations.push(await ctx.session.hook("retry", event => { event.decision = { retry: false } }))
    const nativeDefinition = (await ctx.tool.list()).find(tool => tool.id === "subagent")
    if (!nativeDefinition) throw new Error("Native foreground subagent unavailable")
    const nativeOptions = portable(nativeDefinition.options ?? {})
    const nativeInput = portable(nativeDefinition.input)
    const nativeKeys = Object.keys(nativeDefinition)
    let preservedFields
    const wrapper = await ctx.tool.transform(editor => editor.update("subagent", definition => {
      const native = definition.execute
      const originalFields = Object.entries(definition).filter(([field]) => field !== "execute")
      // Change only execute: preserve native input/options/permission policy.
      definition.execute = async (input, tool) => {
        let environmentAdmitted = false
        assertActive(); tool.signal.throwIfAborted()
        if (input.background === true) throw new Error("Background excluded from private qualification")
        const invocation = await ctx.storage.get(key(tool.sessionID, tool.id))
        assertActive(); tool.signal.throwIfAborted()
        if (!invocation || invocation.parentID !== tool.sessionID || invocation.callID !== tool.id) throw new Error("Missing exact child invocation")
        const admitted = await ctx.storage.get(`root-request/${tool.sessionID}`)
        assertActive(); tool.signal.throwIfAborted()
        if (admitted?.rootRequestID !== invocation.rootRequestID) throw new Error("Root request correlation mismatch")
        if (input.sessionID) {
          const child = await ctx.session.get({ sessionID: input.sessionID })
          assertActive(); tool.signal.throwIfAborted()
          const owner = await ctx.storage.get(`owner/${child.id}`)
          assertActive(); tool.signal.throwIfAborted()
          if (child.parentID !== tool.sessionID || !owner) throw new Error("Foreign child continuation")
          checkOwner(owner, invocation)
        }
        const result = await native(input, { ...tool, progress: async update => {
          assertActive(); tool.signal.throwIfAborted()
          if (typeof update.sessionID === "string") {
            const child = await ctx.session.get({ sessionID: update.sessionID })
            assertActive(); tool.signal.throwIfAborted()
            if (child.parentID !== tool.sessionID) throw new Error("Structured native parent mismatch")
            const owner = await ctx.storage.get(`owner/${child.id}`)
            assertActive(); tool.signal.throwIfAborted()
            if (owner) checkOwner(owner, invocation)
            const binding = { ...invocation, childID: child.id, assistantMessageID: tool.messageID,
              nativeAgent: child.agent ?? null, nativeModel: child.model ?? null }
            const previous = await ctx.storage.get(`binding/${tool.sessionID}/${tool.id}`)
            assertActive(); tool.signal.throwIfAborted()
            if (previous && !same(previous, binding)) throw new Error("Immutable call binding conflict")
            if (!previous) await ctx.storage.set(`binding/${tool.sessionID}/${tool.id}`, binding)
            assertActive(); tool.signal.throwIfAborted()
            if (!owner) await ctx.storage.set(`owner/${child.id}`, invocation)
            assertActive(); tool.signal.throwIfAborted()
            await ctx.storage.set(`current-binding/${child.id}`, binding)
            assertActive(); tool.signal.throwIfAborted()
            if (!environmentAdmitted) {
              const seed = JSON.parse(await readFile(seedFile, "utf8"))
              assertActive(); tool.signal.throwIfAborted()
              const body = Object.fromEntries(["parentID", "callID", "childID", "rootRequestID", "executionID", "taskKey", "contractRequestID"].map(field => [field, binding[field]]))
              const signal = AbortSignal.any([tool.signal, AbortSignal.timeout(Math.max(1, seed.deadline - Date.now()))])
              for (const operation of ["observe", "admit"]) {
                try {
                  const response = await fetch(`${seed.url}/${operation}`, { method: "POST", headers: { "content-type": "application/json", cookie: seed.cookie }, body: JSON.stringify(body), signal })
                  assertActive(); tool.signal.throwIfAborted()
                  if (!response.ok) throw new Error("Admission denied")
                  const result = await response.json()
                  assertActive(); tool.signal.throwIfAborted()
                  if (result[operation === "observe" ? "observed" : "admitted"] !== true) throw new Error("Admission not acknowledged")
                } catch { throw new Error("Private child environment admission failed") }
              }
              await ctx.storage.set(`model-admission/${child.id}`, { callID: binding.callID })
              assertActive(); tool.signal.throwIfAborted()
              environmentAdmitted = true
            }
          }
          await tool.progress(update)
          assertActive(); tool.signal.throwIfAborted()
        } })
        assertActive(); tool.signal.throwIfAborted()
        return result
      }
      preservedFields = originalFields.every(([field, value]) => definition[field] === value)
      if (!preservedFields) throw new Error("Native subagent fields changed beyond execute")
    }))
    registrations.push(wrapper)
    registrations.push(await ctx.rpc.register(CHILD_ENV_RPC, {
      authorize: async input => {
        if (input.token !== token) throw new Error("Private proof unauthorized")
        assertActive()
        const { token: _token, ...invocation } = input
        const previous = await ctx.storage.get(key(invocation.parentID, invocation.callID))
        assertActive()
        if (previous && !same(previous, invocation)) throw new Error("Immutable invocation conflict")
        if (!previous) await ctx.storage.set(key(invocation.parentID, invocation.callID), invocation)
        assertActive()
        return { recorded: true }
      },
      proof: async input => {
        if (input.token !== token) throw new Error("Private proof unauthorized")
        return { binding: await ctx.storage.get(`binding/${input.parentID}/${input.callID}`) ?? null }
      },
      capabilities: async input => {
        if (input.token !== token) throw new Error("Private proof unauthorized")
        const current = (await ctx.tool.list()).find(tool => tool.id === "subagent")
        return { nativeInput, nativeOptions, nativeKeys, preservedFields, currentInput: portable(current.input), currentOptions: portable(current.options),
          sessionMethods: Object.keys(ctx.session), agents: await ctx.agent.list() }
      },
      disposeWrapper: async input => {
        if (input.token !== token) throw new Error("Private proof unauthorized")
        active = false; await wrapper.dispose()
        return { disposed: true }
      },
    }))
    return async () => { active = false; await Promise.allSettled(registrations.map(registration => registration.dispose())) }
  } }
}
