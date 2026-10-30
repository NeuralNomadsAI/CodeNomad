import type { Agent, Plugin, Skill } from "@opencode/plugin/effect"
import { Effect, type Scope } from "effect"
import type { DesignContent } from "./content"

type DesignContext = Pick<Plugin.Context, "agent" | "skill">
/** Whether a live backend lease requests Design (`observeDesignRequest`). */
export interface DesignRequest {
  read(): Promise<boolean>
  release(): void
}

/**
 * Registers the Design agent and skills once, while the plugin loads, with content
 * that depends on a Location-local `applied` flag. Registering at load keeps the
 * user's configuration in charge: their permissions apply to the agent, and their
 * own `design` agent or `design-*` skills win. Reconciliation at the presence
 * interval only flips `applied` and reloads, on an actual change. Content loads
 * once, when Design is first requested. Runs before `followPresence` and owns
 * `request` (released with the plugin scope).
 */
export const registerDesign = (
  ctx: DesignContext,
  request: DesignRequest,
  load: () => Promise<DesignContent>,
  skillPath: string,
  interval: number,
  onError: (error: unknown) => void = console.error,
) => Effect.gen(function* () {
  // Capability, never version: a runtime without these domains simply has no Design agent.
  if (typeof ctx.agent?.transform !== "function" || typeof ctx.agent.reload !== "function"
    || typeof ctx.skill?.transform !== "function" || typeof ctx.skill.reload !== "function") {
    request.release()
    return
  }
  yield* Effect.addFinalizer(() => Effect.sync(() => request.release()))
  let content: DesignContent | undefined
  // A content failure leaves Design unapplied; the next reconciliation retries.
  const wanted = async () => await request.read() && Boolean(content ??= await load().catch(error => { onError(error); return undefined }))
  let applied = yield* Effect.promise(wanted)
  yield* ctx.agent.transform(editor => {
    if (!applied || !content || editor.get(content.agent.id)) return
    const { agent: provided } = content
    editor.update(provided.id, agent => {
      agent.name = provided.name as Agent.Name
      agent.description = provided.description
      agent.mode = provided.mode
      agent.system = provided.system
    })
  })
  yield* ctx.skill.transform(editor => {
    if (!applied || !content) return
    for (const skill of content.skills) {
      if (editor.get(skill.id)) continue
      editor.add({ id: skill.id as Skill.ID, name: skill.name as Skill.Name, description: skill.description,
        content: skill.content, path: skillPath as Skill.Info["path"], autoinvoke: false })
    }
  })
  const run = Effect.runPromiseWith(yield* Effect.context<Scope.Scope>())
  let pending: Promise<void> | undefined
  let stale = false
  const reconcile = () => pending ??= (async () => {
    const next = await wanted()
    if (next === applied && !stale) return
    applied = next
    // A failed reload is retried at the next interval even if the request is unchanged.
    stale = true
    await run(ctx.agent.reload())
    await run(ctx.skill.reload())
    stale = false
  })().catch(onError).finally(() => { pending = undefined })
  yield* Effect.acquireRelease(Effect.sync(() => {
    const timer = setInterval(() => void reconcile(), interval)
    timer.unref?.()
    return timer
  }), timer => Effect.promise(async () => {
    clearInterval(timer)
    await pending
  }))
})
